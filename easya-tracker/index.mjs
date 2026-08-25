// index.mjs — bot theo dõi token launch trên EasyA/Kickstart (Meteora DBC, Solana) -> cảnh báo Telegram.
//
// Luồng:
//   1) logsSubscribe (mentions = EASYA_CONFIG, commitment "confirmed") -> lọc marker launch -> dedupe theo sig.
//   2) getParsedTransaction (retry ~8x/300ms, FAILOVER nhiều endpoint) -> parseLaunch -> gửi thẻ NGAY + getBalance(dev).
//   3) NỀN: fetchSocials (đua IPFS gateway) -> editMessageText làm giàu thẻ (không chặn đường tới hạn).
//   4) logsSubscribe thứ 2 (Streamflow) -> nếu lock đúng mint đã launch -> reply "🔒 LOCK".
// Macro giống các bot khác: lệnh chat (/status /health /ping /tokens /help) + heartbeat + hàng đợi alert không mất tin.
//
// Độ bền (chống điểm chết đơn):
//   - RPC: Pool nhiều endpoint, thử lần lượt (getParsedTransaction/getBalance/getSlot).
//   - Websocket: onSlotChange làm "nhịp tim" ws; im lặng quá lâu -> XOAY endpoint + re-subscribe; vẫn chết -> thoát cho supervisor.
//   - Telegram: hàng đợi nền không mất tin khi lỗi tạm (queueAlert).
// Bài học: commitment PHẢI "confirmed" (không "processed"); không để IPFS chặn cảnh báo; 1 instance (lockfile); dedupe theo sig.
import "./env.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { parseProviders, maskUrl, Pool } from "./providers.mjs";
import { EASYA_CONFIG, STREAMFLOW, LAUNCH_MARKERS, parseLaunch } from "./dbc.mjs";
import { fetchSocials } from "./socials.mjs";
import { send, edit, reply, queueAlert, listen, formatCard, formatEnriched, escapeHtml, configured } from "./telegram.mjs";
import { isLockLogs, lockedMint } from "./streamflow.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RECENT_FILE = path.join(__dirname, "recent.json");
const LOCK_FILE = path.join(__dirname, "easya.lock");
const RECENT_TTL_MS = 24 * 3600 * 1000;
const LOCK_STALE_MS = 45 * 1000;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_HOURS || 6) * 3600 * 1000;
const WATCHDOG_MS = 20000;                 // nhịp kiểm liveness
const WS_SILENT_MS = 45000;                // ws im lặng lâu hơn ngần này -> coi là chết (slot ~2/s nên rất an toàn)
const WS_STALL_EXIT = 5;                    // số nhịp im lặng liên tiếp (sau khi đã xoay) trước khi thoát cho supervisor

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pool = null; // Pool nhiều endpoint (khởi tạo trong main)

// ---- Trạng thái (cho lệnh chat + heartbeat + health + watchdog) ----
const status = {
  startedAt: Date.now(),
  launches: 0,
  locks: 0,
  lastEventAt: null,     // log ws bất kỳ (launch/lock) gần nhất
  lastWsSlotAt: null,    // onSlotChange gần nhất = "nhịp tim" websocket
  lastSlot: 0,
  lastLaunch: null,
  lastLaunchAt: null,
  consecutiveErrors: 0,
  lastError: null,
  lastErrorAt: null,
  wsStalls: 0,
  onWsFallback: false,
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

const seenSigs = new Set(); // dedupe theo signature

// getParsedTransaction có retry + FAILOVER: tx có thể chưa query được ngay lúc log bắn.
async function fetchTx(sig) {
  for (let i = 0; i < 8; i++) {
    try {
      const tx = await pool.call((c) => c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
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
  if (!LAUNCH_MARKERS.some((m) => logs.some((l) => l.includes(m)))) return; // bỏ swap/spam

  const tx = await fetchTx(sig);
  if (!tx) { console.error("Không lấy được tx sau retry:", sig); return; }
  const d = parseLaunch(tx);
  if (!d) { console.error("Không parse được launch:", sig); return; }

  let devBal = null;
  try { devBal = (await pool.call((c) => c.getBalance(new PublicKey(d.creator)))) / 1e9; } catch (_) {}

  const messageId = await send(formatCard(d, devBal)); // gửi thẻ NGAY (on-chain), giữ message_id
  status.launches++;
  status.lastLaunch = { symbol: d.symbol, mint: d.mint };
  status.lastLaunchAt = Date.now();
  console.log(`🚀 launch ${d.symbol || "?"} ${d.mint} dev=${d.creator} buy=${d.buySol} (msg ${messageId ?? "-"})`);

  recent.set(d.mint, { symbol: d.symbol, message_id: messageId, totalSupply: d.totalSupply, ts: Date.now() });
  saveRecent();

  if (messageId && d.uri) { // NỀN: làm giàu socials rồi edit (không await)
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
  if (!rec) return; // không phải token mình đã theo dõi
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

// ---- Quản lý subscription (để re-subscribe khi xoay endpoint) ----
let sub = null; // { conn, launchId, lockId, slotId }
async function subscribe() {
  const c = pool.conn();
  const launchId = await c.onLogs(new PublicKey(EASYA_CONFIG), (l) => {
    if (l.err) return;
    runHandler(handleLaunch, l.signature, l.logs || [], "launch");
  }, "confirmed");
  const lockId = await c.onLogs(new PublicKey(STREAMFLOW), (l) => {
    if (l.err) return;
    runHandler(handleLock, l.signature, l.logs || [], "lock");
  }, "confirmed");
  // onSlotChange = "nhịp tim" websocket (fires ~2/s khi ws sống) -> phát hiện ws chết ngay cả khi EasyA im.
  const slotId = c.onSlotChange((s) => { status.lastSlot = s.slot; status.lastWsSlotAt = Date.now(); });
  sub = { conn: c, launchId, lockId, slotId };
}
async function unsubscribe() {
  if (!sub) return;
  try { await sub.conn.removeOnLogsListener(sub.launchId); } catch (_) {}
  try { await sub.conn.removeOnLogsListener(sub.lockId); } catch (_) {}
  try { await sub.conn.removeSlotChangeListener(sub.slotId); } catch (_) {}
  sub = null;
}
async function resubscribe(reason) {
  await unsubscribe();
  await subscribe();
  console.log(`Re-subscribe trên ${maskUrl(pool.current)}${reason ? " (" + reason + ")" : ""}`);
}

// ---- Lệnh chat Telegram ----
async function onCommand(cmd) {
  switch (cmd) {
    case "/status": {
      return [
        `📊 EasyA tracker — ${status.consecutiveErrors > 0 ? "⚠️ đang lỗi" : "🟢 OK"}`,
        `Uptime: ${uptime()}`,
        `Launch đã bắt: ${status.launches}${status.lastLaunch ? ` (mới nhất: $${status.lastLaunch.symbol || "?"} ${status.lastLaunch.mint}, ${ago(status.lastLaunchAt)})` : ""}`,
        `Lock đã báo: ${status.locks}`,
        `Đang theo dõi (recent 24h): ${recent.size} token`,
        `Endpoint: ${pool ? `${maskUrl(pool.current)} (${pool.size} cái, đã xoay ${pool.rotations})` : "?"}`,
        `Websocket: nhịp gần nhất ${ago(status.lastWsSlotAt)} (slot ${status.lastSlot || "?"})${status.onWsFallback ? " ⚠️ đang dự phòng" : ""}`,
        `Event ws (launch/lock) gần nhất: ${ago(status.lastEventAt)}`,
        `Lỗi liên tiếp: ${status.consecutiveErrors}${status.lastError ? ` (${status.lastError}, ${ago(status.lastErrorAt)})` : ""}`,
        `Heartbeat gần nhất: ${ago(status.lastHeartbeatAt)}`,
      ].join("\n");
    }
    case "/health": {
      const t0 = Date.now();
      let slot = null, rpcOk = false, err = "";
      try { slot = await pool.call((c) => c.getSlot("confirmed")); rpcOk = true; } catch (e) { err = e.message; }
      const wsAge = Date.now() - (status.lastWsSlotAt || status.startedAt);
      const wsOk = wsAge <= WS_SILENT_MS;
      const errOk = status.consecutiveErrors === 0;
      const tgOk = configured();
      const verdict = !rpcOk ? "🔴 UNHEALTHY" : (!wsOk || !errOk) ? "🟡 DEGRADED" : "🟢 HEALTHY";
      return [
        `${verdict}  (easya-tracker, probe ${Date.now() - t0}ms)`,
        `Uptime: ${uptime()}`,
        `${rpcOk ? "🟢" : "🔴"} RPC (${pool ? pool.size : 0} endpoint, xoay ${pool ? pool.rotations : 0}): ${rpcOk ? "OK slot=" + slot : "LỖI (" + err + ")"}`,
        `${wsOk ? "🟢" : "🟡"} Websocket: nhịp ${ago(status.lastWsSlotAt)}${status.onWsFallback ? " (đang dự phòng)" : ""}`,
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
  const providers = parseProviders();
  if (!providers.length) { console.error("Thiếu endpoint Solana — đặt HELIUS_API_KEY hoặc SOLANA_RPC_URLS trong .env."); process.exit(1); }
  pool = new Pool(providers, "confirmed");

  acquireLock();
  loadRecent();
  pruneRecent();
  if (!configured()) console.warn("⚠️ Telegram chưa cấu hình (TELEGRAM_*) — chỉ log ra console, không nhận lệnh chat.");

  listen(onCommand).catch((e) => console.error("listen lỗi:", e.message)); // lắng nghe lệnh chat (không chặn)

  await subscribe(); // logsSubscribe (launch + lock) + onSlotChange trên endpoint hiện tại

  queueAlert(`🟢 EasyA tracker khởi động — canh launch trên Kickstart/Meteora DBC (confirmed), ${pool.size} endpoint failover.`);
  console.log(`Đang lắng nghe launch (EasyA config) + lock (Streamflow) trên ${maskUrl(pool.current)}…`);

  // Giữ lock tươi + prune recent.
  setInterval(touchLock, 20000);
  setInterval(() => { pruneRecent(); saveRecent(); }, 10 * 60 * 1000);

  // Heartbeat định kỳ (mặc định 6h) — hàng đợi nền, không mất tin.
  setInterval(() => {
    status.lastHeartbeatAt = Date.now();
    queueAlert(`💓 Heartbeat (easya) — uptime ${uptime()}, launch ${status.launches}, lock ${status.locks}, ws nhịp ${ago(status.lastWsSlotAt)}, endpoint ${maskUrl(pool.current)}, lỗi liên tiếp ${status.consecutiveErrors}.`);
  }, HEARTBEAT_MS);

  // Watchdog websocket: onSlotChange là nhịp tim. Im lặng quá lâu -> XOAY endpoint + re-subscribe;
  // vẫn im lặng sau nhiều lần -> thoát cho supervisor restart (chốt chặn cuối).
  setInterval(async () => {
    const wsAge = Date.now() - (status.lastWsSlotAt || status.startedAt);
    if (wsAge > WS_SILENT_MS) {
      status.wsStalls++;
      if (pool.size > 1) {
        pool.rotate();
        status.onWsFallback = true;
        queueAlert(`🟡 EasyA: websocket im lặng ${Math.round(wsAge / 1000)}s — xoay sang ${maskUrl(pool.current)} và re-subscribe.`);
        try { await resubscribe("ws im lặng"); } catch (e) { console.error("resubscribe lỗi:", e.message); }
      } else {
        queueAlert(`🟡 EasyA: websocket im lặng ${Math.round(wsAge / 1000)}s (chỉ 1 endpoint — chờ web3.js reconnect).`);
      }
      if (status.wsStalls >= WS_STALL_EXIT) {
        console.error("Watchdog: websocket vẫn im lặng sau nhiều lần xoay -> thoát để supervisor khởi động lại.");
        await send("🔴 EasyA tracker: websocket chết kéo dài — thoát để restart.");
        process.exit(1);
      }
    } else {
      if (status.wsStalls > 0 || status.onWsFallback) queueAlert("🟢 EasyA: websocket đã nhận slot trở lại.");
      status.wsStalls = 0;
      status.onWsFallback = false;
    }
  }, WATCHDOG_MS);
}

// Bắt lỗi toàn cục -> không chết âm thầm; thoát để supervisor (pm2/systemd) restart sạch.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => { console.error("uncaughtException:", e?.message || e); setTimeout(() => process.exit(1), 500); });
process.on("exit", () => { if (ownLock) { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} } });

// Chỉ chạy bot khi file này là entry point; khi bị import (test) thì KHÔNG chạy main.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) main().catch((e) => { console.error("Lỗi khởi động:", e.message); process.exit(1); });

export { onCommand, status, recent };
