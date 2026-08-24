// track-rest.js — Tracker LIVE Cách B (poll REST Blockscout, không cần RPC node)
// + Telegram alert + heartbeat + cảnh báo lỗi + lắng nghe lệnh chat (/status ...).
//
// Chạy: node track-rest.js   (cấu hình TELEGRAM_* trong .env)

require("./lib/env");
require("./lib/guard"); // bắt lỗi toàn cục
const fs = require("fs");
const { queueAlert, listen, escapeHtml } = require("./lib/bot");
const { loadJson, saveJson } = require("./lib/store");

const BASE = "https://robinhoodchain.blockscout.com";
const WALLET = "0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49";
const T0 = "0xf5e62f18207578ca90c9d19a15c6405c9b3b401917ba0ad7a443bc76dcdadb2d"; // AdapterDeployed
const creatorTopic = "0x" + "0".repeat(24) + WALLET.toLowerCase().slice(2);     // topic2 = creator
const POLL_MS = 20000;
const STATE = "./last_block.txt";
const TOKENS_FILE = "./rest_tokens.json"; // #10 lịch sử token đã bắt
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_HOURS || 6) * 3600 * 1000;
const ERR_THRESHOLD = Number(process.env.ERROR_ALERT_THRESHOLD || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alert = queueAlert; // #11: không chặn vòng quét

const status = {
  mode: "rest",
  wallet: WALLET,
  startedAt: Date.now(),
  lastBlock: null,
  cursor: null,
  lastScanAt: null,
  adapters: new Set(),
  tokens: [], // {token, symbol, tx}
  consecutiveErrors: 0,
  lastError: null,
  lastErrorAt: null,
  lastHeartbeatAt: Date.now(),
  downAlerted: false,
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

// Probe sống: hỏi Blockscout block hiện tại ngay lúc gọi (1 lần, timeout ngắn) cho /health
async function liveProbe() {
  const t0 = Date.now();
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch(`${BASE}/api/v2/blocks?type=block`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, ms: Date.now() - t0, err: `HTTP ${r.status}` };
    const j = await r.json();
    const blk = j?.items?.[0]?.height;
    return blk != null ? { ok: true, ms: Date.now() - t0, chainBlock: blk } : { ok: false, ms: Date.now() - t0, err: "no block" };
  } catch (e) { return { ok: false, ms: Date.now() - t0, err: e.message }; }
}

async function onCommand(cmd, args) {
  switch (cmd) {
    case "/status": {
      const L = [
        `📊 Tracker (${status.mode}) — ${status.consecutiveErrors > 0 ? "⚠️ đang lỗi" : "🟢 OK"}`,
        `Ví: ${status.wallet}`,
        `Uptime: ${uptime()}`,
        `Block mới nhất: ${status.lastBlock ?? "?"}`,
        `Đã quét tới: ${status.cursor != null ? status.cursor - 1 : "?"}`,
        `Adapter của ví: ${status.adapters.size}`,
        `Token đã bắt (từ lúc chạy): ${status.tokens.length}`,
      ];
      const last = status.tokens[status.tokens.length - 1];
      if (last) L.push(`  • mới nhất: ${last.token} (${last.symbol || "?"})`);
      L.push(`Lỗi liên tiếp: ${status.consecutiveErrors}${status.lastError ? ` (${status.lastError}, ${ago(status.lastErrorAt)})` : ""}`);
      L.push(`Scan gần nhất: ${ago(status.lastScanAt)}`);
      L.push(`Heartbeat gần nhất: ${ago(status.lastHeartbeatAt)}`);
      return L.join("\n");
    }
    case "/health": {
      const p = await liveProbe();
      const freshMs = status.lastScanAt ? Date.now() - status.lastScanAt : Infinity;
      const staleLimit = POLL_MS * 3 + 30000;
      const lagWarn = Math.ceil((POLL_MS / 1000) * 12 * 4) + 200;
      const lag = (p.ok && status.cursor != null) ? p.chainBlock - (status.cursor - 1) : null;
      const srcOk = p.ok, errOk = status.consecutiveErrors === 0;
      const freshOk = freshMs <= staleLimit, lagOk = lag == null ? true : lag <= lagWarn;
      const verdict = (!srcOk || !errOk) ? "🔴 UNHEALTHY" : (!freshOk || !lagOk) ? "🟡 DEGRADED" : "🟢 HEALTHY";
      const L = [
        `${verdict}  (tracker ${status.mode})`,
        `Uptime: ${uptime()}`,
        `${srcOk ? "🟢" : "🔴"} Nguồn dữ liệu (Blockscout): ${srcOk ? `OK ${p.ms}ms` : `LỖI (${p.err || "?"})`}`,
        `${errOk ? "🟢" : "🔴"} Lỗi liên tiếp: ${status.consecutiveErrors}${status.lastError ? ` (${status.lastError})` : ""}`,
        `${freshOk ? "🟢" : "🟡"} Scan gần nhất: ${ago(status.lastScanAt)}`,
      ];
      if (lag != null) L.push(`${lagOk ? "🟢" : "🟡"} Lag: ${lag} block (chain ${p.chainBlock} / đã quét ${status.cursor - 1})`);
      return L.join("\n");
    }
    case "/ping":
      return "🏓 pong — bot đang chạy, uptime " + uptime();
    case "/tokens":
      return status.tokens.length
        ? "Token đã bắt:\n" + status.tokens.slice(-10).map((t) => `• ${t.token} (${t.symbol || "?"}) tx ${t.tx}`).join("\n")
        : "Chưa bắt được token nào từ lúc khởi động.";
    case "/adapters":
      return status.adapters.size
        ? `Adapter của ví (${status.adapters.size}):\n` + [...status.adapters].slice(-10).map((a) => `• ${a}`).join("\n")
        : "Chưa biết adapter nào.";
    case "/help":
    case "/start":
      return "Lệnh: /status  /health  /ping  /tokens  /adapters  /help";
    default:
      return null;
  }
}

// fetch JSON có backoff cho 429. Trả null nếu thất bại hẳn.
async function api(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (r.ok) return await r.json();
    } catch (_) {}
    await sleep(1500 * (i + 1));
  }
  return null;
}

async function latestBlock() {
  const j = await api(`${BASE}/api/v2/blocks?type=block`);
  return j?.items?.[0]?.height ?? null;
}

async function getAdapterLogs(from, to) {
  const j = await api(`${BASE}/api?module=logs&action=getLogs` +
    `&fromBlock=${from}&toBlock=${to}&topic0=${T0}&topic2=${creatorTopic}&topic0_2_opr=and`);
  if (!j) throw new Error("Blockscout không phản hồi (getLogs)");
  if (j.status !== "1") {
    if (/No (logs|records) found/i.test(j.message || "")) return [];
    throw new Error("getLogs: " + (j.message || "status " + j.status));
  }
  return (j.result || []).map((l) => ({
    adapter: "0x" + l.topics[1].slice(26),
    router: "0x" + l.topics[3].slice(26),
    block: parseInt(l.blockNumber, 16),
    tx: l.transactionHash,
  }));
}

async function extractToken(adapter, startBlock) {
  const j = await api(`${BASE}/api?module=account&action=tokentx` +
    `&address=${adapter}&startblock=${startBlock}&endblock=${startBlock + 500}&sort=asc`);
  const first = j?.result?.[0];
  return first ? { token: first.contractAddress, symbol: first.tokenSymbol, launchTx: first.hash } : null;
}

async function scan() {
  const to = await latestBlock();
  if (to == null) throw new Error("Không lấy được block mới nhất (Blockscout rate-limit?)");
  status.lastBlock = to;
  let from = status.cursor;
  if (from == null) from = fs.existsSync(STATE) ? Number(fs.readFileSync(STATE, "utf8")) : to;

  const logs = await getAdapterLogs(from, to);
  for (const l of logs) {
    status.adapters.add(l.adapter.toLowerCase());
    alert(`🆕 ${WALLET} deploy adapter mới\nadapter: <code>${l.adapter}</code>\nrouter: <code>${l.router}</code>\ntx: <code>${l.tx}</code>`, { parseMode: "HTML" });
    const info = await extractToken(l.adapter, l.block);
    if (info) {
      status.tokens.push({ token: info.token, symbol: info.symbol, tx: info.launchTx, at: Date.now() });
      saveJson(TOKENS_FILE, status.tokens); // #10
      alert(
        `✅ TOKEN MỚI${info.symbol ? " " + escapeHtml(info.symbol) : ""}\n` +
        `CA: <code>${info.token}</code>\n` +      // chạm để copy
        `launchTx: <code>${info.launchTx}</code>`,
        { parseMode: "HTML" }
      );
    } else {
      alert(`   ⏳ chưa thấy token (adapter mới deploy, chưa launch)`);
    }
  }

  status.cursor = to + 1;
  status.lastScanAt = Date.now();
  fs.writeFileSync(STATE, String(status.cursor));
}

async function loop() {
  console.log(`Theo dõi (Cách B / REST): ${WALLET}`);
  status.tokens = loadJson(TOKENS_FILE, []); // #10: khôi phục lịch sử token
  if (status.tokens.length) console.log(`Đã khôi phục ${status.tokens.length} token đã bắt trước đó.`);
  listen(onCommand); // lắng nghe lệnh chat song song
  alert(`🟢 Tracker (rest) khởi động — theo dõi ${WALLET} qua Blockscout.`);

  while (true) {
    try {
      await scan();
      if (status.downAlerted) {
        await alert(`🟢 Đã phục hồi — scan bình thường trở lại (sau ${status.consecutiveErrors} lỗi).`);
        status.downAlerted = false;
      }
      status.consecutiveErrors = 0;
    } catch (e) {
      status.consecutiveErrors++;
      status.lastError = e.message;
      status.lastErrorAt = Date.now();
      console.error("scan err:", e.message);
      if (status.consecutiveErrors >= ERR_THRESHOLD && !status.downAlerted) {
        await alert(`🔴 CẢNH BÁO: tracker (rest) lỗi ${status.consecutiveErrors} lần liên tiếp.\n   Lỗi: ${e.message}`);
        status.downAlerted = true;
      }
    }

    if (Date.now() - status.lastHeartbeatAt >= HEARTBEAT_MS) {
      status.lastHeartbeatAt = Date.now();
      await alert(`💓 Heartbeat (rest) — uptime ${uptime()}, block ${status.lastBlock}, adapter ${status.adapters.size}, token ${status.tokens.length}, lỗi liên tiếp ${status.consecutiveErrors}.`);
    }

    await sleep(POLL_MS);
  }
}

if (require.main === module) loop();
module.exports = { onCommand, status }; // để test được bộ xử lý lệnh
