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
const { queueAlert, send, editMessage, listen, escapeHtml } = require("./lib/bot");
const { Rpc, parseUrls } = require("./lib/rpc");
const { startPush } = require("./lib/push");
const { loadJson, saveJson } = require("./lib/store");
const blockscout = require("./lib/blockscout"); // nguồn log dự phòng độc lập (REST)

const WALLET = "0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49";
const PONS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"; // PonsV2LaunchFactory
const POLL_MS = 5000;
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 5); // #5
const WS_STATE = "./ws_cursor.txt"; // #2 con trỏ block
const TOKENS_FILE = "./ws_tokens.json"; // #10 lịch sử token đã bắt
const ADAPTERS_FILE = "./ws_adapters.json"; // lưu adapter đã biết -> khỏi re-scan toàn lịch sử mỗi lần khởi động
const SPLIT_BUDGET = Number(process.env.LOG_SPLIT_BUDGET || 4000); // trần số call khi chia nhỏ getLogs (chặn RPC giới hạn range quá chặt)
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
const pending = new Map();         // 0-conf: key(tx:index) -> {kind, blockNumber, messageId, ...} (in-memory)
const pendingAdapters = new Set(); // adapter 0-conf (chưa xác nhận) -> để lọc token push của ví
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
  onFallback: false, // đang chạy qua Blockscout dự phòng (mọi RPC chết) hay không
  pushConnected: false, // websocket push 0-conf đang kết nối?
  pendingCount: 0,      // số cảnh báo 0-conf đang chờ xác nhận
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
    return { ok: true, ms: Date.now() - t0, chainBlock: blk, rpc: rpc.current, src: "RPC" };
  } catch (e) {
    // RPC chết -> thử Blockscout (nguồn dự phòng) để /health phản ánh ĐÚNG là vẫn đang chạy được
    try {
      const blk = await blockscout.latestBlock();
      return { ok: true, ms: Date.now() - t0, chainBlock: blk, rpc: "Blockscout (dự phòng)", src: "Blockscout" };
    } catch (e2) { return { ok: false, ms: Date.now() - t0, err: e.message }; }
  }
}

// Nhận diện lỗi "range/kết quả quá lớn" (đáng chia đôi) vs lỗi mạng/tạm (đừng chia).
// Bắt theo NỘI DUNG message nên tự nhiên: "exceed maximum block range" -> chia;
// "specify an address" / ECONNREFUSED / timeout -> KHÔNG chia (ném để failover xử lý).
function isRangeError(e) {
  const m = String(
    (e && (e.error?.message || e.info?.error?.message || e.shortMessage || e.message)) || ""
  ).toLowerCase();
  // Rate-limit/throttle KHÔNG phải range -> đừng chia đôi (tránh dội bom RPC đang bị siết).
  if (/rate.?limit|compute unit|too many request|throttl|quota|capacity|429/.test(m)) return false;
  // Chỉ chia đôi khi RPC báo range/kết quả quá lớn (chia đôi mới có ích).
  return /block range|range is too|out of range|exceed.{0,20}range|10 block range|too many (results|logs)|more than \d+ results|query returned more|result set|response size|max(imum)? results|payload too large|log.{0,20}limit/.test(m);
}

// getLogs qua RPC (mọi endpoint failover). Thử nguyên range trước (RPC như official nhận
// cả 45M block/1 call); CHỈ chia đôi khi RPC báo range/kết quả quá lớn (#8). Lỗi mạng/tạm
// -> NÉM ngay: đây là FIX bug treo âm thầm — trước đây MỌI lỗi đều chia đôi nên khi mọi RPC
// chết lúc khởi động (nạp 0..tip) đệ quy bùng nổ, treo cứng. Ngân sách SPLIT_BUDGET chặn
// trường hợp RPC giới hạn range quá chặt (vd Alchemy free 10 block) trên range khổng lồ ->
// ném để getLogs() rơi xuống Blockscout thay vì chia hàng triệu lần.
async function getLogsAdaptive(filter, from, to) {
  return splitLogs(filter, from, to, 0, { n: 0 });
}
async function splitLogs(filter, from, to, depth, budget) {
  if (++budget.n > SPLIT_BUDGET) throw new Error(`getLogs: vượt ngân sách chia nhỏ ${SPLIT_BUDGET} call (RPC giới hạn range quá chặt cho khoảng ${from}-${to})`);
  try {
    return await rpc.call((p) => p.getLogs({ ...filter, fromBlock: from, toBlock: to }), onRotate);
  } catch (e) {
    if (!isRangeError(e) || to <= from || depth >= 40) throw e;
    const mid = Math.floor((from + to) / 2);
    const left = await splitLogs(filter, from, mid, depth + 1, budget);
    const right = await splitLogs(filter, mid + 1, to, depth + 1, budget);
    return left.concat(right);
  }
}

// Nguồn log HỢP NHẤT: thử mọi RPC trước; nếu RPC hỏng hẳn thì rơi xuống Blockscout REST
// (hạ tầng ĐỘC LẬP) để không "mù" khi official + tenderly cùng chết. Cả hai chết -> ném để
// vòng poll đếm lỗi. Việc báo 🟡/🟢 do vòng poll làm theo CHU KỲ (dựa trên bsUseCount) để
// tránh flap khi query adapter (address-less) và query launch (có address) thành/bại lệch nhau.
let bsUseCount = 0; // tăng mỗi lần PHẢI dùng Blockscout (getLogs/getTip)
async function getLogs(filter, from, to) {
  try {
    return await getLogsAdaptive(filter, from, to);
  } catch (e) {
    try {
      const logs = await blockscout.getLogs(filter, from, to);
      bsUseCount++;
      return logs;
    } catch (e2) {
      throw new Error(`RPC lỗi (${e.message}) VÀ Blockscout lỗi (${e2.message})`);
    }
  }
}

// Lấy block mới nhất: thử RPC trước; RPC hỏng hẳn -> Blockscout REST. Nhờ vậy tracker CHẠY ĐƯỢC
// cả khi KHÔNG có RPC nào sống (Blockscout gánh). Ném nếu cả hai chết (vòng poll đếm lỗi -> 🔴).
async function getTip() {
  try {
    return await rpc.getBlockNumber(onRotate);
  } catch (e) {
    const b = await blockscout.latestBlock(); // ném nếu Blockscout cũng chết
    bsUseCount++;
    return b;
  }
}

// #9: đọc symbol token (1 lần/token, có failover). Lỗi -> null.
async function tokenSymbol(addr) {
  try {
    return await rpc.call((p) => new ethers.Contract(addr, ERC20_SYMBOL, p).symbol(), onRotate);
  } catch (_) { return null; }
}

// ---- Push 0-conf (báo sớm) — nguồn chân lý VẪN là vòng poll ----
// Quyết định khi POLL xác nhận 1 event: 'edit' nếu đã có tin 0-conf; 'fresh' nếu chưa; null nếu đã báo.
function resolveConfirm(k) {
  if (alerted.has(k)) return null;
  alerted.add(k);
  const p = pending.get(k);
  if (p) { pending.delete(k); status.pendingCount = pending.size; return { action: "edit", messageId: p.messageId }; }
  return { action: "fresh" };
}
// Pending đã tới độ sâu xác nhận (block <= to) mà KHÔNG được confirmed -> reorg/rớt. Trả [[k,p],...].
function collectReorged(to) {
  const out = [];
  for (const [k, p] of pending) if (to >= p.blockNumber) out.push([k, p]);
  return out;
}
// Nhận 1 log từ websocket (0-conf): gửi thẻ ⚡ CHỜ XÁC NHẬN + ghi pending. Dedupe theo tx:index.
async function onPush(log) {
  try {
    const k = key(log);
    if (alerted.has(k) || pending.has(k)) return;
    const t0 = log.topics[0];
    if (t0 === T_ADAPTER) {
      const a = iface.parseLog(log).args;
      pendingAdapters.add(a.adapter.toLowerCase());
      const mid = await send(
        `⚡ Adapter mới của ví (0-conf — CHỜ XÁC NHẬN)\nadapter: <code>${a.adapter}</code>\nrouter: <code>${a.router}</code>\ntx: <code>${log.transactionHash}</code>`,
        undefined, { parseMode: "HTML" });
      pending.set(k, { kind: "adapter", blockNumber: log.blockNumber, messageId: mid || null, adapter: a.adapter, tx: log.transactionHash });
      status.pendingCount = pending.size;
    } else if (t0 === T_LAUNCH) {
      const a = iface.parseLog(log).args;
      const dep = a.deployer.toLowerCase();
      if (!status.adapters.has(dep) && !pendingAdapters.has(dep)) return; // chỉ token của ví
      const sym = await tokenSymbol(a.token);
      const mid = await send(
        `⚡ TOKEN MỚI (0-conf — CHỜ XÁC NHẬN)${sym ? " " + escapeHtml(sym) : ""}\nCA: <code>${a.token}</code>\ncurve: <code>${a.curve}</code>\ndeployer: <code>${a.deployer}</code>\ntx: <code>${log.transactionHash}</code>`,
        undefined, { parseMode: "HTML" });
      pending.set(k, { kind: "launch", blockNumber: log.blockNumber, messageId: mid || null, token: a.token, symbol: sym, curve: a.curve, deployer: a.deployer, tx: log.transactionHash });
      status.pendingCount = pending.size;
    }
  } catch (e) { console.error("push err:", e.message); }
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
        `Push 0-conf: ${status.pushConnected ? "🟢 kết nối" : "⚪ tắt/mất"} | chờ xác nhận: ${status.pendingCount}`,
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
        `${srcOk ? "🟢" : "🔴"} Nguồn dữ liệu (${p.src || "RPC"}): ${srcOk ? `OK ${p.ms}ms` : `LỖI (${p.err || "?"})`}`,
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
  let net = null;
  try { net = await rpc.call((p) => p.getNetwork(), onRotate); } catch (_) {} // không chặn khởi động nếu RPC chết
  const latest = await getTip(); // fallback Blockscout -> khởi động được cả khi mọi RPC chết
  status.lastBlock = latest;
  status.rpc = rpc.current;
  const safeTip = Math.max(0, latest - CONFIRMATIONS); // #5

  listen(onCommand);

  // ⚡ Push 0-conf (báo sớm) qua websocket — CHỈ tối ưu độ trễ; poll vẫn là nguồn chân lý.
  // Cần 1 URL wss trong RPC_URLS (hoặc WS_URL). Không có -> tắt push, poll chạy như cũ.
  const wsUrl = RPC_URLS.find((u) => /^wss?:/i.test(u)) || process.env.WS_URL || null;
  if (wsUrl) {
    startPush({
      wsUrl,
      filters: [
        { topics: [T_ADAPTER, null, creatorTopic] },
        { address: PONS, topics: [T_LAUNCH] },
      ],
      onEvent: onPush,
      onStatus: (s) => { status.pushConnected = s === "connected"; if (s !== "connected") console.warn("push:", s); },
    });
    try { console.log("⚡ Push 0-conf bật qua", new URL(wsUrl).host); } catch (_) { console.log("⚡ Push 0-conf bật."); }
  } else {
    console.log("Push 0-conf TẮT (không có URL wss trong RPC_URLS/WS_URL) — chạy poll thường.");
  }

  let saved = null;
  if (fs.existsSync(WS_STATE)) { const n = Number(fs.readFileSync(WS_STATE, "utf8")); if (Number.isFinite(n)) saved = n; }
  status.cursor = saved != null ? saved : safeTip; // #2

  status.tokens = loadJson(TOKENS_FILE, []); // #10: khôi phục lịch sử token
  if (status.tokens.length) console.log(`Đã khôi phục ${status.tokens.length} token đã bắt trước đó.`);

  // #3 + persistence: khôi phục adapter đã biết để KHỎI quét toàn lịch sử mỗi lần khởi động
  // (giảm tải + hợp RPC giới hạn range như Alchemy free). Chỉ quét toàn chuỗi khi chưa có file.
  const savedAdapters = loadJson(ADAPTERS_FILE, []);
  if (Array.isArray(savedAdapters) && savedAdapters.length) {
    for (const a of savedAdapters) status.adapters.add(String(a).toLowerCase());
    console.log(`Đã khôi phục ${status.adapters.size} adapter từ ${ADAPTERS_FILE} (bỏ quét toàn lịch sử).`);
  } else {
    try {
      const all = await getLogs({ topics: [T_ADAPTER, null, creatorTopic] }, 0, safeTip);
      for (const l of all) {
        status.adapters.add(iface.parseLog(l).args.adapter.toLowerCase());
        if (l.blockNumber < status.cursor) alerted.add(key(l));
      }
      saveJson(ADAPTERS_FILE, [...status.adapters]);
      console.log(`Đã nạp ${status.adapters.size} adapter của ví (toàn lịch sử).`);
    } catch (e) { console.log("Không nạp được adapter lịch sử:", e.message); }
  }

  await alert(`🟢 Tracker (ws) khởi động — theo dõi ${WALLET}\n   RPC=${rpc.current} (+${RPC_URLS.length - 1} dự phòng, chainId ${net ? net.chainId : "?"})${net ? "" : " — ⚠️ mọi RPC lỗi lúc khởi động, đang chạy qua Blockscout dự phòng"}\n   Đã biết ${status.adapters.size} adapter, quét từ block ${status.cursor}, confirmations=${CONFIRMATIONS}.`);

  while (true) {
    try {
      const bsBefore = bsUseCount; // để suy ra chu kỳ này có phải dùng Blockscout dự phòng không
      const tip = await getTip(); // fallback Blockscout khi mọi RPC chết
      status.lastBlock = tip;
      status.rpc = rpc.current;
      const to = tip - CONFIRMATIONS;
      if (to >= status.cursor) {
        const from = status.cursor;

        const aLogs = await getLogs({ topics: [T_ADAPTER, null, creatorTopic] }, from, to);
        for (const l of aLogs) {
          const a = iface.parseLog(l).args;
          const isNew = !status.adapters.has(a.adapter.toLowerCase());
          status.adapters.add(a.adapter.toLowerCase());
          pendingAdapters.delete(a.adapter.toLowerCase());
          if (isNew) saveJson(ADAPTERS_FILE, [...status.adapters]); // lưu ngay -> khỏi re-scan lịch sử
          const c = resolveConfirm(key(l));
          if (!c) continue;
          const text = `🆕 Adapter mới của ví (đã xác nhận)\nadapter: <code>${a.adapter}</code>\nrouter: <code>${a.router}</code>\ntx: <code>${l.transactionHash}</code>`;
          if (c.action === "edit" && c.messageId) editMessage(c.messageId, text, { parseMode: "HTML" }); // 0-conf -> ✅
          else alert(text, { parseMode: "HTML" });
        }

        const tLogs = await getLogs({ address: PONS, topics: [T_LAUNCH] }, from, to);
        for (const l of tLogs) {
          const a = iface.parseLog(l).args;
          if (!status.adapters.has(a.deployer.toLowerCase())) continue;
          const c = resolveConfirm(key(l));
          if (!c) continue;
          const sym = await tokenSymbol(a.token); // #9
          status.tokens.push({ token: a.token, symbol: sym, curve: a.curve, tx: l.transactionHash, at: Date.now() });
          saveJson(TOKENS_FILE, status.tokens); // #10: lưu ngay khi bắt được
          const text =
            `✅ TOKEN MỚI (đã xác nhận)${sym ? " " + escapeHtml(sym) : ""}\n` +
            `CA: <code>${a.token}</code>\n` +      // chạm để copy
            `curve: <code>${a.curve}</code>\n` +
            `deployer: <code>${a.deployer}</code>\n` +
            `tx: <code>${l.transactionHash}</code>`;
          if (c.action === "edit" && c.messageId) editMessage(c.messageId, text, { parseMode: "HTML" }); // 0-conf -> ✅
          else alert(text, { parseMode: "HTML" });
        }

        // Reorg/rớt: pending 0-conf đã tới độ sâu xác nhận (block <= to) mà KHÔNG confirmed -> báo huỷ.
        for (const [k, p] of collectReorged(to)) {
          pending.delete(k);
          if (p.kind === "adapter" && p.adapter) pendingAdapters.delete(p.adapter.toLowerCase());
          const text = p.kind === "launch"
            ? `⚠️ Token 0-conf BIẾN MẤT (reorg?) — không lên chain ở độ sâu xác nhận.\nCA: <code>${p.token}</code>\ntx: <code>${p.tx}</code>`
            : `⚠️ Adapter 0-conf BIẾN MẤT (reorg?)\nadapter: <code>${p.adapter}</code>\ntx: <code>${p.tx}</code>`;
          if (p.messageId) editMessage(p.messageId, text, { parseMode: "HTML" });
        }
        status.pendingCount = pending.size;

        status.cursor = to + 1;
        try { fs.writeFileSync(WS_STATE, String(status.cursor)); } catch (_) {} // #2
      }
      status.lastScanAt = Date.now();

      // 🟡/🟢 theo CHU KỲ: chu kỳ này có dùng Blockscout dự phòng không (tránh flap giữa 2 query)
      const usedBs = bsUseCount > bsBefore;
      if (usedBs && !status.onFallback) {
        await alert("🟡 RPC lỗi hết — đang chạy qua Blockscout REST dự phòng (không mất coverage).");
        status.onFallback = true;
      } else if (!usedBs && status.onFallback) {
        await alert("🟢 RPC đã phục hồi — thôi dùng Blockscout dự phòng.");
        status.onFallback = false;
      }

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

module.exports = { onCommand, status, rpc, getLogsAdaptive, getLogs, getTip, isRangeError, tokenSymbol, iface, T_ADAPTER, T_LAUNCH, creatorTopic, PONS, CONFIRMATIONS, alerted, pending, pendingAdapters, resolveConfirm, collectReorged, onPush };
