// index.mjs — bot theo dõi token launch trên EasyA/Kickstart (Meteora DBC, Solana) -> cảnh báo Telegram.
//
// Luồng:
//   1) logsSubscribe (mentions = EASYA_CONFIG, commitment "confirmed") -> lọc marker launch -> dedupe theo sig.
//   2) getParsedTransaction (retry ~8x/300ms) -> parseLaunch -> gửi thẻ NGAY (on-chain) + getBalance(dev).
//   3) NỀN: fetchSocials (đua IPFS gateway) -> editMessageText làm giàu thẻ (không chặn đường tới hạn).
//   4) logsSubscribe thứ 2 (Streamflow) -> nếu lock đúng mint đã launch -> reply "🔒 LOCK".
// Macro giống các bot khác: lệnh chat (/status /health /ping /tokens /help) + heartbeat định kỳ.
//
// Bài học (đừng lặp lại): commitment PHẢI "confirmed" (không "processed" — Helius im lặng, mất launch);
// không để IPFS chặn cảnh báo; 1 instance duy nhất (lockfile); dedupe theo signature; chạy dưới supervisor.
import "./env.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { EASYA_CONFIG, STREAMFLOW, LAUNCH_MARKERS, parseLaunch } from "./dbc.mjs";
import { fetchSocials } from "./socials.mjs";
import { send, edit, reply, listen, formatCard, formatEnriched, escapeHtml, configured } from "./telegram.mjs";
import { isLockLogs, lockedMint } from "./streamflow.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HTTP_URL = (k) => `https://mainnet.helius-rpc.com/?api-key=${k}`;
const WS_URL = (k) => `wss://mainnet.helius-rpc.com/?api-key=${k}`;

const RECENT_FILE = path.join(__dirname, "recent.json");
const LOCK_FILE = path.join(__dirname, "easya.lock");
const RECENT_TTL_MS = 24 * 3600 * 1000;
const LOCK_STALE_MS = 45 * 1000;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_HOURS || 6) * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connection tạo lazy (không kết nối khi construct) -> an toàn dù chưa có key lúc import (cho test).
const conn = new Connection(HTTP_URL(process.env.HELIUS_API_KEY || "x"), {
  commitment: "confirmed",
  wsEndpoint: WS_URL(process.env.HELIUS_API_KEY || "x"),
});

// ---- Trạng thái (cho lệnh chat + heartbeat + health) ----
const status = {
  startedAt: Date.now(),
  launches: 0,          // số launch đã bắt từ lúc chạy
  locks: 0,             // số lock đã báo
  lastEventAt: null,    // log ws bất kỳ gần nhất (liveness)
  lastLaunch: null,     // {symbol, mint}
  lastLaunchAt: null,
  consecutiveErrors: 0,
  lastError: null,
  lastErrorAt: null,
  lastSlot: 0,
  slotFails: 0,
  lastHeartbeatAt: Date.now(),
};

function ago(ts) {
  if (!ts) return "chưa";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s trước";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m trước";
  return Math.floor(m / 60) + "h " + (m % 60) + "m trước";
}
function uptime() {
  const s = Math.floor((Date.now() - status.startedAt) / 1000);
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}

// ---- Single-instance guard (lockfile: ghi pid, từ chối chạy nếu lock hiện tại còn "tươi" < 45s) ----
let ownLock = false;
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age < LOCK_STALE_MS) {
        console.error(`Đã có instance khác đang chạy (lock mới ${Math.round(age / 1000)}s) -> thoát để tránh gửi trùng.`);
        process.exit(1); // ownLock=false -> handler 'exit' KHÔNG xoá lock của instance kia
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    ownLock = true;
  } catch (e) { console.error("Lock lỗi:", e.message); }
}
function touchLock() { try { const now = new Date(); fs.utimesSync(LOCK_FILE, now, now); } catch (_) {} }

// ---- Recent launches Map: mint -> {symbol, message_id, totalSupply, ts} (TTL 24h, persist JSON) ----
const recent = new Map();
function loadRecent() {
  try {
    const arr = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"));
    const cutoff = Date.now() - RECENT_TTL_MS;
    for (const [mint, v] of arr) if (v && v.ts >= cutoff) recent.set(mint, v);
  } catch (_) {}
}
function pruneRecent() {
  const cutoff = Date.now() - RECENT_TTL_MS;
  for (const [k, v] of recent) if (v.ts < cutoff) recent.delete(k);
}
function saveRecent() {
  try { fs.writeFileSync(RECENT_FILE, JSON.stringify([...recent.entries()])); } catch (_) {}
}
const recentList = () => [...recent.entries()].map(([mint, v]) => ({ mint, ...v })).sort((a, b) => b.ts - a.ts);

const seenSigs = new Set(); // dedupe theo signature (một sig chỉ xử lý 1 lần)

// getParsedTransaction có retry: tx có thể chưa query được ngay lúc log bắn.
async function fetchTx(sig) {
  for (let i = 0; i < 8; i++) {
    try {
      const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (tx) return tx;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

// ---- Handler: 1 tx launch ----
async function handleLaunch(sig, logs) {
  if (seenSigs.has(sig)) return;
  seenSigs.add(sig);
  if (!LAUNCH_MARKERS.some((m) => logs.some((l) => l.includes(m)))) return; // bỏ swap/spam (không phải launch)

  const tx = await fetchTx(sig);
  if (!tx) { console.error("Không lấy được tx sau retry:", sig); return; }
  const d = parseLaunch(tx);
  if (!d) { console.error("Không parse được launch:", sig); return; }

  // SOL balance của dev (1 RPC). Lỗi -> null (không chặn thẻ).
  let devBal = null;
  try { devBal = (await conn.getBalance(new PublicKey(d.creator))) / 1e9; } catch (_) {}

  // Gửi thẻ NGAY (dữ liệu on-chain), giữ message_id.
  const messageId = await send(formatCard(d, devBal));
  status.launches++;
  status.lastLaunch = { symbol: d.symbol, mint: d.mint };
  status.lastLaunchAt = Date.now();
  console.log(`🚀 launch ${d.symbol || "?"} ${d.mint} dev=${d.creator} buy=${d.buySol} (msg ${messageId ?? "-"})`);

  // Ghi vào recent (để Streamflow reply đúng thẻ).
  recent.set(d.mint, { symbol: d.symbol, message_id: messageId, totalSupply: d.totalSupply, ts: Date.now() });
  saveRecent();

  // NỀN: làm giàu socials rồi edit (KHÔNG await -> không chặn).
  if (messageId && d.uri) {
    fetchSocials(d.uri).then((s) => {
      if (s && (s.description || s.twitter || s.website)) return edit(messageId, formatEnriched(d, devBal, s));
    }).catch(() => {});
  }
}

// ---- Handler: Streamflow lock -> reply vào thẻ gốc ----
async function handleLock(sig, logs) {
  if (seenSigs.has("lock:" + sig)) return;
  if (!isLockLogs(logs)) return;
  seenSigs.add("lock:" + sig);
  const tx = await fetchTx(sig);
  if (!tx) return;
  const lk = lockedMint(tx);
  if (!lk) return;
  const rec = recent.get(lk.mint);
  if (!rec) return; // không phải token mình đã theo dõi -> bỏ
  const pct = rec.totalSupply ? ` (${((lk.amount / rec.totalSupply) * 100).toFixed(1)}% supply)` : "";
  await reply(rec.message_id, `🔒 LOCK qua Streamflow — $${escapeHtml(rec.symbol || "?")}, khoá ${lk.amount.toLocaleString("en-US")}${pct}`);
  status.locks++;
  console.log(`🔒 lock ${rec.symbol || "?"} ${lk.mint} amount=${lk.amount}`);
}

// gói handler: cập nhật liveness + đếm lỗi liên tiếp (reset khi thành công).
function runHandler(fn, sig, logs, label) {
  status.lastEventAt = Date.now();
  fn(sig, logs)
    .then(() => { status.consecutiveErrors = 0; })
    .catch((e) => {
      status.consecutiveErrors++;
      status.lastError = e.message;
      status.lastErrorAt = Date.now();
      console.error(`${label} handler:`, e.message);
    });
}

// ---- Lệnh chat Telegram ----
async function onCommand(cmd) {
  switch (cmd) {
    case "/status": {
      const L = [
        `📊 EasyA tracker — ${status.consecutiveErrors > 0 ? "⚠️ đang lỗi" : "🟢 OK"}`,
        `Uptime: ${uptime()}`,
        `Launch đã bắt: ${status.launches}${status.lastLaunch ? ` (mới nhất: $${status.lastLaunch.symbol || "?"} ${status.lastLaunch.mint}, ${ago(status.lastLaunchAt)})` : ""}`,
        `Lock đã báo: ${status.locks}`,
        `Đang theo dõi (recent 24h): ${recent.size} token`,
        `Event ws gần nhất: ${ago(status.lastEventAt)}`,
        `Lỗi liên tiếp: ${status.consecutiveErrors}${status.lastError ? ` (${status.lastError}, ${ago(status.lastErrorAt)})` : ""}`,
        `Slot: ${status.lastSlot || "?"} (watchdog fails ${status.slotFails})`,
        `Heartbeat gần nhất: ${ago(status.lastHeartbeatAt)}`,
      ];
      return L.join("\n");
    }
    case "/health": {
      const t0 = Date.now();
      let slot = null, rpcOk = false, err = "";
      try { slot = await conn.getSlot("confirmed"); rpcOk = true; } catch (e) { err = e.message; }
      const errOk = status.consecutiveErrors === 0;
      const tgOk = configured();
      const verdict = !rpcOk ? "🔴 UNHEALTHY" : (!errOk || status.slotFails > 0) ? "🟡 DEGRADED" : "🟢 HEALTHY";
      return [
        `${verdict}  (easya-tracker, probe ${Date.now() - t0}ms)`,
        `Uptime: ${uptime()}`,
        `${rpcOk ? "🟢" : "🔴"} RPC Helius (getSlot): ${rpcOk ? "OK slot=" + slot : "LỖI (" + err + ")"}`,
        `${status.slotFails === 0 ? "🟢" : "🟡"} Watchdog: slot fails ${status.slotFails} | event ws ${ago(status.lastEventAt)}`,
        `${errOk ? "🟢" : "🔴"} Lỗi liên tiếp: ${status.consecutiveErrors}${status.lastError ? " (" + status.lastError + ")" : ""}`,
        `${tgOk ? "🟢" : "🔴"} Telegram: ${tgOk ? "đã cấu hình" : "CHƯA cấu hình"}`,
      ].join("\n");
    }
    case "/ping":
      return "🏓 pong — easya-tracker đang chạy, uptime " + uptime();
    case "/tokens":
    case "/token": {
      const list = recentList();
      if (!list.length) return "Chưa bắt được token nào (trong 24h gần đây).";
      return `🪙 Token EasyA đã bắt gần đây (${list.length}):\n` +
        list.slice(0, 15).map((t, i) => `${i + 1}. $${escapeHtml(t.symbol || "?")} <code>${t.mint}</code> [${ago(t.ts)}]`).join("\n");
    }
    case "/help":
    case "/start":
      return "Lệnh: /status  /health  /ping  /tokens  /help";
    default:
      return null;
  }
}

async function main() {
  const key = process.env.HELIUS_API_KEY || "";
  if (!key) { console.error("Thiếu HELIUS_API_KEY trong .env — không thể chạy."); process.exit(1); }

  acquireLock();
  loadRecent();
  pruneRecent();
  if (!configured()) console.warn("⚠️ Telegram chưa cấu hình (TELEGRAM_*) — chỉ log ra console, không nhận lệnh chat.");

  listen(onCommand).catch((e) => console.error("listen lỗi:", e.message)); // lắng nghe lệnh chat (không chặn)

  // 1) launch: mentions filter = EASYA_CONFIG, commitment "confirmed" (TUYỆT ĐỐI không "processed").
  await conn.onLogs(new PublicKey(EASYA_CONFIG), (l) => {
    if (l.err) return; // bỏ tx fail
    runHandler(handleLaunch, l.signature, l.logs || [], "launch");
  }, "confirmed");

  // 2) Streamflow lock.
  await conn.onLogs(new PublicKey(STREAMFLOW), (l) => {
    if (l.err) return;
    runHandler(handleLock, l.signature, l.logs || [], "lock");
  }, "confirmed");

  await send("🟢 EasyA tracker khởi động — canh launch trên Kickstart/Meteora DBC (commitment=confirmed).");
  console.log("Đang lắng nghe launch (EasyA config) + lock (Streamflow)…");

  // Giữ lock tươi + prune recent.
  setInterval(touchLock, 20000);
  setInterval(() => { pruneRecent(); saveRecent(); }, 10 * 60 * 1000);

  // Heartbeat định kỳ (mặc định 6h) — nhịp "còn sống".
  setInterval(() => {
    status.lastHeartbeatAt = Date.now();
    send(`💓 Heartbeat (easya) — uptime ${uptime()}, launch ${status.launches}, lock ${status.locks}, event ws ${ago(status.lastEventAt)}, lỗi liên tiếp ${status.consecutiveErrors}.`);
  }, HEARTBEAT_MS);

  // Watchdog liveness: slot phải tiến; nếu treo ~3 phút (ws có thể chết) -> thoát cho supervisor restart.
  setInterval(async () => {
    try {
      const s = await conn.getSlot("confirmed");
      if (s > status.lastSlot) { status.lastSlot = s; status.slotFails = 0; } else status.slotFails++;
    } catch (_) { status.slotFails++; }
    if (status.slotFails >= 6) {
      console.error("Watchdog: slot không tiến (ws có thể chết) -> thoát để supervisor khởi động lại.");
      try { await send("🔴 EasyA tracker: mất kết nối (watchdog) — thoát để restart."); } catch (_) {}
      process.exit(1);
    }
  }, 30000);
}

// Bắt lỗi toàn cục -> không chết âm thầm; thoát để supervisor (pm2/systemd) restart sạch.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => { console.error("uncaughtException:", e?.message || e); setTimeout(() => process.exit(1), 500); });
process.on("exit", () => { if (ownLock) { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} } });

// Chỉ chạy bot khi file này là entry point; khi bị import (test) thì KHÔNG chạy main.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) main().catch((e) => { console.error("Lỗi khởi động:", e.message); process.exit(1); });

export { onCommand, status, recent };
