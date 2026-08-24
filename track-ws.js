// track-ws.js — Tracker LIVE Cách C (ethers + RPC, cursor poll) + Telegram alert
// + heartbeat + cảnh báo lỗi + lệnh chat (/status /health ...).
//
// Đã vá: #2 lưu con trỏ block, #3 nạp đủ adapter từ đầu chuỗi, #4 dedupe theo
// tx:logIndex, #5 chờ CONFIRMATIONS block (tránh reorg), #6 tự reconnect WebSocket,
// #7 nhiều RPC failover (RPC_URLS), #9 hiện tên/symbol token.
//
// Cài:  npm i ethers
// Chạy: node track-ws.js
//   RPC_URLS="wss://a,https://b,https://c"  (nhiều RPC, cách nhau dấu phẩy) hoặc RPC_URL=...

require("./lib/env");
require("./lib/guard"); // bắt lỗi toàn cục
const fs = require("fs");
const { ethers } = require("ethers");
const { queueAlert, listen, escapeHtml } = require("./lib/bot");
const { Rpc, parseUrls } = require("./lib/rpc");
const { loadJson, saveJson } = require("./lib/store");

const WALLET = "0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49";
const PONS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"; // PonsV2LaunchFactory
const POLL_MS = 5000;
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 5); // #5
const WS_STATE = "./ws_cursor.txt"; // #2 con trỏ block
const TOKENS_FILE = "./ws_tokens.json"; // #10 lịch sử token đã bắt
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_HOURS || 6) * 3600 * 1000;
const ERR_THRESHOLD = Number(process.env.ERROR_ALERT_THRESHOLD || 3);

const RPC_URLS = parseUrls(process.env);
const rpc = new Rpc(RPC_URLS); // #6 + #7

const iface = new ethers.Interface([
  "event AdapterDeployed(address indexed adapter, address indexed creator, address indexed router, bytes32 userSalt, bytes32 derivedSalt, uint256 chainId, address implementation, bool created)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);
const T_ADAPTER = ethers.id("AdapterDeployed(address,address,address,bytes32,bytes32,uint256,address,bool)");
const T_LAUNCH = ethers.id("TokenLaunched(address,address,address,address,uint256,uint256)");
const creatorTopic = ethers.zeroPadValue(WALLET, 32);
const ERC20_SYMBOL = ["function symbol() view returns (string)"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alert = queueAlert; // #11: không chặn vòng quét
const alerted = new Set(); // #4
const key = (l) => `${l.transactionHash}:${l.index}`;
const onRotate = (r, e) => console.warn(`RPC rotate: ${r.from} -> ${r.to} (${e.shortMessage || e.message})`);

const status = {
  mode: "ws",
  rpc: rpc.current,
  rpcCount: RPC_URLS.length,
  wallet: WALLET,
  startedAt: Date.now(),
  lastBlock: null,
  cursor: null,
  lastScanAt: null,
  adapters: new Set(),
  tokens: [], // {token, symbol, curve, tx}
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

async function liveProbe() {
  const t0 = Date.now();
  try {
    const blk = await rpc.getBlockNumber(onRotate);
    status.rpc = rpc.current;
    return { ok: true, ms: Date.now() - t0, chainBlock: blk, rpc: rpc.current };
  } catch (e) { return { ok: false, ms: Date.now() - t0, err: e.message }; }
}

// getLogs "thích nghi" + failover: rpc.call thử mọi RPC; range lỗi thì chia đôi (#8)
async function getLogsAdaptive(filter, from, to) {
  try {
    return await rpc.call((p) => p.getLogs({ ...filter, fromBlock: from, toBlock: to }), onRotate);
  } catch (e) {
    if (to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    const left = await getLogsAdaptive(filter, from, mid);
    const right = await getLogsAdaptive(filter, mid + 1, to);
    return left.concat(right);
  }
}

// #9: đọc symbol token (1 lần/token, có failover). Lỗi -> null.
async function tokenSymbol(addr) {
  try {
    return await rpc.call((p) => new ethers.Contract(addr, ERC20_SYMBOL, p).symbol(), onRotate);
  } catch (_) { return null; }
}

// ---- Bộ xử lý lệnh chat Telegram ----
async function onCommand(cmd, args) {
  switch (cmd) {
    case "/status": {
      const L = [
        `📊 Tracker (${status.mode}) — ${status.consecutiveErrors > 0 ? "⚠️ đang lỗi" : "🟢 OK"}`,
        `Ví: ${status.wallet}`,
        `Uptime: ${uptime()}`,
        `RPC: ${status.rpc} (${status.rpcCount} endpoint, đã xoay ${rpc.rotations} lần)`,
        `Block mới nhất: ${status.lastBlock ?? "?"}`,
        `Đã quét tới: ${status.cursor != null ? status.cursor - 1 : "?"}`,
        `Adapter của ví: ${status.adapters.size}`,
        `Token đã bắt (từ lúc chạy): ${status.tokens.length}`,
      ];
      const last = status.tokens[status.tokens.length - 1];
      if (last) L.push(`  • mới nhất: ${last.token}${last.symbol ? ` (${last.symbol})` : ""}`);
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
        `RPC: ${status.rpc} (${status.rpcCount} endpoint, xoay ${rpc.rotations} lần)`,
        `${srcOk ? "🟢" : "🔴"} Nguồn dữ liệu (RPC): ${srcOk ? `OK ${p.ms}ms` : `LỖI (${p.err || "?"})`}`,
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
        ? "Token đã bắt:\n" + status.tokens.slice(-10).map((t) => `• ${t.token}${t.symbol ? ` (${t.symbol})` : ""} tx ${t.tx}`).join("\n")
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

async function main() {
  const net = await rpc.call((p) => p.getNetwork(), onRotate);
  const latest = await rpc.getBlockNumber(onRotate);
  status.lastBlock = latest;
  status.rpc = rpc.current;
  const safeTip = Math.max(0, latest - CONFIRMATIONS); // #5

  listen(onCommand);

  let saved = null;
  if (fs.existsSync(WS_STATE)) { const n = Number(fs.readFileSync(WS_STATE, "utf8")); if (Number.isFinite(n)) saved = n; }
  status.cursor = saved != null ? saved : safeTip; // #2

  status.tokens = loadJson(TOKENS_FILE, []); // #10: khôi phục lịch sử token
  if (status.tokens.length) console.log(`Đã khôi phục ${status.tokens.length} token đã bắt trước đó.`);

  // #3: nạp đủ mọi adapter của ví từ đầu chuỗi
  try {
    const all = await getLogsAdaptive({ topics: [T_ADAPTER, null, creatorTopic] }, 0, safeTip);
    for (const l of all) {
      status.adapters.add(iface.parseLog(l).args.adapter.toLowerCase());
      if (l.blockNumber < status.cursor) alerted.add(key(l));
    }
    console.log(`Đã nạp ${status.adapters.size} adapter của ví (toàn lịch sử).`);
  } catch (e) { console.log("Không nạp được adapter lịch sử:", e.message); }

  await alert(`🟢 Tracker (ws) khởi động — theo dõi ${WALLET}\n   RPC=${rpc.current} (+${RPC_URLS.length - 1} dự phòng, chainId ${net.chainId})\n   Đã biết ${status.adapters.size} adapter, quét từ block ${status.cursor}, confirmations=${CONFIRMATIONS}.`);

  while (true) {
    try {
      const tip = await rpc.getBlockNumber(onRotate);
      status.lastBlock = tip;
      status.rpc = rpc.current;
      const to = tip - CONFIRMATIONS;
      if (to >= status.cursor) {
        const from = status.cursor;

        const aLogs = await getLogsAdaptive({ topics: [T_ADAPTER, null, creatorTopic] }, from, to);
        for (const l of aLogs) {
          const a = iface.parseLog(l).args;
          status.adapters.add(a.adapter.toLowerCase());
          const k = key(l);
          if (alerted.has(k)) continue;
          alerted.add(k);
          alert(`🆕 Adapter mới của ví\nadapter: <code>${a.adapter}</code>\nrouter: <code>${a.router}</code>\ntx: <code>${l.transactionHash}</code>`, { parseMode: "HTML" });
        }

        const tLogs = await getLogsAdaptive({ address: PONS, topics: [T_LAUNCH] }, from, to);
        for (const l of tLogs) {
          const a = iface.parseLog(l).args;
          if (!status.adapters.has(a.deployer.toLowerCase())) continue;
          const k = key(l);
          if (alerted.has(k)) continue;
          alerted.add(k);
          const sym = await tokenSymbol(a.token); // #9
          status.tokens.push({ token: a.token, symbol: sym, curve: a.curve, tx: l.transactionHash, at: Date.now() });
          saveJson(TOKENS_FILE, status.tokens); // #10: lưu ngay khi bắt được
          alert(
            `✅ TOKEN MỚI${sym ? " " + escapeHtml(sym) : ""}\n` +
            `CA: <code>${a.token}</code>\n` +      // chạm để copy
            `curve: <code>${a.curve}</code>\n` +
            `deployer: <code>${a.deployer}</code>\n` +
            `tx: <code>${l.transactionHash}</code>`,
            { parseMode: "HTML" }
          );
        }

        status.cursor = to + 1;
        try { fs.writeFileSync(WS_STATE, String(status.cursor)); } catch (_) {} // #2
      }
      status.lastScanAt = Date.now();

      if (status.downAlerted) {
        await alert(`🟢 Đã phục hồi — scan bình thường trở lại (sau ${status.consecutiveErrors} lỗi liên tiếp). RPC=${rpc.current}`);
        status.downAlerted = false;
      }
      status.consecutiveErrors = 0;
    } catch (e) {
      status.consecutiveErrors++;
      status.lastError = e.message;
      status.lastErrorAt = Date.now();
      console.error("poll err:", e.message);
      if (status.consecutiveErrors >= ERR_THRESHOLD && !status.downAlerted) {
        await alert(`🔴 CẢNH BÁO: tracker (ws) lỗi ${status.consecutiveErrors} lần liên tiếp (mọi RPC).\n   Lỗi: ${e.message}\n   RPC hiện tại=${rpc.current}, đã xoay ${rpc.rotations} lần.`);
        status.downAlerted = true;
      }
    }

    if (Date.now() - status.lastHeartbeatAt >= HEARTBEAT_MS) {
      status.lastHeartbeatAt = Date.now();
      await alert(`💓 Heartbeat (ws) — uptime ${uptime()}, block ${status.lastBlock}, adapter ${status.adapters.size}, token ${status.tokens.length}, lỗi liên tiếp ${status.consecutiveErrors}, RPC ${rpc.current} (xoay ${rpc.rotations}).`);
    }

    await sleep(POLL_MS);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("Lỗi:", e.message); process.exit(1); });
}

module.exports = { onCommand, status, rpc, getLogsAdaptive, tokenSymbol, iface, T_ADAPTER, T_LAUNCH, creatorTopic, PONS, CONFIRMATIONS };
