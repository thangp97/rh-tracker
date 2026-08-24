// track-index.js — Bot theo dõi khi THEINDEX tích hợp POOLS.TRADE và LƯU MỌI token index launch.
//
// Hybrid 3 watcher (cảnh báo khi BẤT KỲ tín hiệu nào "dương"):
//   W1 (theindex app.js)  : "poolstrade" xuất hiện trong danh sách launchpad TÍCH HỢP GỐC (như Pons).
//   W2 (pools.trade tRPC) : category MỚI hoặc launchpadId MỚI so với BASELINE ĐÃ BIẾT.
//   W3 (on-chain)         : launch pools.trade ghép cặp STOCK/INDEX (bằng chứng chắc nhất).
// Khi phát hiện tích hợp -> mỗi chu kỳ QUÉT & LƯU token index MỚI (dedupe theo CA). /token liệt kê.
//
// So sánh với BASELINE CỨNG đã biết (không phải snapshot động) -> không bị "đóng băng nhầm" và
// vẫn phát hiện được cả khi tích hợp xảy ra TRƯỚC lần chạy đầu; W3 quét từ block 0 để bắt launch cũ.
//
// Macro giống rh-tracker: /status /health /ping /watchers /assets /token /help + heartbeat + 🔴/🟢
// + guard + hàng đợi alert không mất tin + persistence. Cần Telegram token RIÊNG (INDEX_TELEGRAM_*).

require("./lib/env");
// Bot này cần Telegram token RIÊNG (getUpdates độc quyền — KHÔNG dùng chung token với rh-tracker,
// nếu không sẽ lỗi 409). Đặt INDEX_TELEGRAM_* trong .env; ánh xạ sang biến bot.js đọc (chỉ tiến trình này).
if (process.env.INDEX_TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = process.env.INDEX_TELEGRAM_BOT_TOKEN;
if (process.env.INDEX_TELEGRAM_CHAT_ID) process.env.TELEGRAM_CHAT_ID = process.env.INDEX_TELEGRAM_CHAT_ID;
require("./lib/guard"); // bắt lỗi toàn cục
const { queueAlert, send, listen, escapeHtml } = require("./lib/bot");
const { loadJson, saveJson } = require("./lib/store");
const theindex = require("./lib/theindex");
const poolstrade = require("./lib/poolstrade");
const onchain = require("./lib/poolstrade-onchain"); // W3

const POLL_MS = Number(process.env.INDEX_POLL_MS || 60000); // tích hợp là sự kiện hiếm -> 60s là đủ
const STATE_FILE = "./index_state.json";
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_HOURS || 6) * 3600 * 1000;
const ERR_THRESHOLD = Number(process.env.ERROR_ALERT_THRESHOLD || 3);
const POOLSTRADE_URL = "https://pools.trade";
const INDEX_HINT = /index|stock|equit|linked-?index|share/i; // category/launchpad gợi ý "tích hợp index"

// BASELINE CỨNG đã biết (2026-08) — mọi thứ NGOÀI đây bị coi là "mới" -> xét cảnh báo tích hợp.
const KNOWN_NATIVE = ["letscash", "pons"];
const KNOWN_CATEGORIES = ["linked-x", "recency", "trending", "volume"];
const KNOWN_LAUNCHPADS = ["uniswap-bonding-curve", "uniswap-cca"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alert = queueAlert; // không chặn vòng quét

const status = {
  mode: "index",
  startedAt: Date.now(),
  lastScanAt: null,
  lastHeartbeatAt: Date.now(),
  consecutiveErrors: 0,
  lastError: null,
  lastErrorAt: null,
  downAlerted: false,
  integrationDetected: false,
  w1: { nativeLaunchpads: [], poolstradeNative: false, parserOk: null, at: null },
  w2: { categories: [], launchpadIds: [], at: null },
  w3: { cursor: null, tip: null, lastLaunches: 0, at: null, err: null, stockCount: 0 },
  // cờ alert-once (persisted)
  w1Alerted: false,     // đã báo pools.trade thành native chưa
  alertedNative: [],    // launchpad gốc mới (khác pools.trade) đã báo
  alertedCats: [],
  alertedLps: [],
  found: [],            // {tokenAddress, tokenSymbol, tokenName, launchpadId, pair, via, at}
  parserWarned: false,
};
const foundKeys = new Set();  // CA (lowercase) đã lưu -> dedupe chung cho W2/W3
let indexAssets = null;       // cache /api/assets: {set, stockCount, stocks}

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
const notIn = (base, now) => now.filter((x) => !base.includes(x));

// ---- Persistence (chỉ lưu trạng thái động; baseline là hằng số KNOWN_*) ----
function loadState() {
  const b = loadJson(STATE_FILE, null);
  if (b) {
    status.integrationDetected = !!b.integrationDetected;
    status.w1Alerted = !!b.w1Alerted;
    status.alertedNative = b.alertedNative || [];
    status.alertedCats = b.alertedCats || [];
    status.alertedLps = b.alertedLps || [];
    status.found = b.found || [];
    status.w3.cursor = b.w3Cursor ?? null;
    for (const f of status.found) foundKeys.add(String(f.tokenAddress).toLowerCase());
  }
  return b;
}
function saveState() {
  saveJson(STATE_FILE, {
    integrationDetected: status.integrationDetected,
    w1Alerted: status.w1Alerted,
    alertedNative: status.alertedNative,
    alertedCats: status.alertedCats,
    alertedLps: status.alertedLps,
    found: status.found,
    w3Cursor: status.w3.cursor,
  });
}

// Lưu 1 token index (dedupe chung theo CA cho W2 & W3). Trả true nếu MỚI.
function recordToken(rec, via) {
  const key = String(rec.tokenAddress || "").toLowerCase();
  if (!key || foundKeys.has(key)) return false;
  foundKeys.add(key);
  status.found.push({
    tokenAddress: rec.tokenAddress, tokenSymbol: rec.tokenSymbol, tokenName: rec.tokenName,
    launchpadId: rec.launchpadId, pair: rec.pair, via, at: Date.now(),
  });
  alert(
    `✅ TOKEN INDEX trên pools.trade (${escapeHtml(via)})\n` +
    `CA: <code>${rec.tokenAddress}</code>\n` +
    `${rec.tokenSymbol ? "symbol: " + escapeHtml(String(rec.tokenSymbol)) + "\n" : ""}` +
    `${rec.tokenName ? "tên: " + escapeHtml(String(rec.tokenName)) + "\n" : ""}` +
    `${rec.pair ? "ghép cặp: <code>" + rec.pair + "</code>\n" : ""}` +
    `${POOLSTRADE_URL}/t/${rec.tokenAddress}`,
    { parseMode: "HTML" }
  );
  return true;
}

function markIntegration(reason) {
  const first = !status.integrationDetected;
  status.integrationDetected = true;
  alert(`🚨 THEINDEX ↔ POOLS.TRADE — TÍN HIỆU TÍCH HỢP!\n   ${reason}\n   ${POOLSTRADE_URL}`);
  if (first) alert("   → Bắt đầu quét & lưu token index launch trên pools.trade. Dùng /token để xem.");
}

// ---- Watcher W1: theindex app.js (so với KNOWN_NATIVE) ----
async function runW1() {
  const st = await theindex.getIntegrationState();
  status.w1.at = Date.now();
  if (!st.parserOk) {
    if (!status.parserWarned) {
      alert("🟡 W1: không trích được danh sách launchpad từ app.js (bundle theindex có thể đã đổi cấu trúc). Cần cập nhật parser lib/theindex.js.");
      status.parserWarned = true;
    }
    status.w1.parserOk = false;
    return;
  }
  status.w1.parserOk = true;
  status.parserWarned = false;
  status.w1.nativeLaunchpads = st.nativeLaunchpads;
  status.w1.poolstradeNative = st.poolstradeNative;

  // MARKER chính: pools.trade thành launchpad tích hợp gốc (alert-once qua w1Alerted)
  if (st.poolstradeNative && !status.w1Alerted) {
    status.w1Alerted = true;
    markIntegration("W1 (theindex app.js): pools.trade đã thành launchpad TÍCH HỢP GỐC (vào danh sách như Pons).");
  }
  // launchpad gốc mới khác (không phải pools.trade) so với baseline đã biết -> báo nhẹ, once
  for (const lp of notIn(KNOWN_NATIVE, st.nativeLaunchpads)) {
    if (/pools?[-_]?trade/i.test(lp) || status.alertedNative.includes(lp)) continue;
    status.alertedNative.push(lp);
    alert(`🟡 W1: theindex thêm launchpad gốc mới: "${lp}" (danh sách: ${st.nativeLaunchpads.join(", ")}).`);
  }
}

// ---- Watcher W2: pools.trade tRPC (so với KNOWN_CATEGORIES / KNOWN_LAUNCHPADS) ----
async function runW2() {
  const cats = await poolstrade.getValidCategories();
  const { launchpadIds } = await poolstrade.collectLaunchpadIds();
  status.w2.at = Date.now();
  status.w2.categories = cats;
  status.w2.launchpadIds = launchpadIds;

  for (const c of notIn(KNOWN_CATEGORIES, cats)) {
    if (status.alertedCats.includes(c)) continue;
    status.alertedCats.push(c);
    if (INDEX_HINT.test(c)) markIntegration(`W2 (pools.trade): CATEGORY mới nghi tích hợp index: "${c}" (toàn bộ: ${cats.join(", ")}).`);
    else alert(`🟡 W2: pools.trade có category mới: "${c}" (toàn bộ: ${cats.join(", ")}). Kiểm tra thủ công.`);
  }
  for (const lp of notIn(KNOWN_LAUNCHPADS, launchpadIds)) {
    if (status.alertedLps.includes(lp)) continue;
    status.alertedLps.push(lp);
    markIntegration(`W2 (pools.trade): launchpadId MỚI: "${lp}" (đã biết: ${KNOWN_LAUNCHPADS.join(", ")}). Kiểm tra có phải index không.`);
  }
}

// ---- W2 Phase 2: quét & LƯU token index MỚI qua API (category/launchpad mới). Dedupe theo CA. ----
async function scanIndexTokens() {
  const idxCats = notIn(KNOWN_CATEGORIES, status.w2.categories).filter((c) => INDEX_HINT.test(c));
  const newLps = notIn(KNOWN_LAUNCHPADS, status.w2.launchpadIds);
  if (!idxCats.length && !newLps.length) return; // chưa có nguồn index nào
  let saved = 0;
  const rec = (t, via) => recordToken({ tokenAddress: t.tokenAddress, tokenSymbol: t.tokenSymbol, tokenName: t.tokenName, launchpadId: t.launchpadId }, via);
  // 1) token trong category index mới
  for (const c of idxCats) {
    let arr = [];
    try { arr = await poolstrade.listLaunches(c); } catch (_) { continue; }
    for (const t of arr) if (t && rec(t, "category:" + c)) saved++;
  }
  // 2) token dùng launchpadId mới — quét TẤT CẢ category hiện có (không chỉ recency/trending)
  if (newLps.length) {
    for (const cat of status.w2.categories) {
      let arr = [];
      try { arr = await poolstrade.listLaunches(cat); } catch (_) { continue; }
      for (const t of arr) if (t && newLps.includes(t.launchpadId) && rec(t, "launchpad:" + t.launchpadId)) saved++;
    }
  }
  if (saved) saveState();
}

// ---- Watcher W3: ON-CHAIN — bắt launch pools.trade ghép cặp STOCK/INDEX (bằng chứng chắc nhất) ----
async function runW3() {
  // làm mới danh sách stock/index pair-asset (dùng cache nếu API lỗi tạm)
  try { indexAssets = await theindex.getIndexPairAssets(); status.w3.stockCount = indexAssets.stockCount; }
  catch (e) { if (!indexAssets) { status.w3.err = "assets: " + e.message; return; } }

  const safeTip = await onchain.getSafeTip();
  status.w3.tip = safeTip;
  // Lần đầu: quét lùi 1 khoảng (mặc định 2M block ~ nhanh, không hammer) để bắt launch stock-paired
  // gần đây; đặt INDEX_ONCHAIN_FROM=0 nếu muốn quét TOÀN lịch sử (nặng, dễ rate-limit).
  if (status.w3.cursor == null) {
    const from = process.env.INDEX_ONCHAIN_FROM;
    const lookback = Number(process.env.INDEX_ONCHAIN_LOOKBACK || 2000000);
    status.w3.cursor = from != null ? Number(from) : Math.max(0, safeTip - lookback);
  }
  if (safeTip < status.w3.cursor) { status.w3.at = Date.now(); status.w3.err = null; return; }

  const launches = await onchain.scanLaunches(status.w3.cursor, safeTip);
  status.w3.lastLaunches = launches.length;
  let saved = 0;
  for (const L of launches) {
    if (!indexAssets.set.has(String(L.pair).toLowerCase())) continue; // chỉ token ghép cặp stock/index
    const sym = symbolOfPair(L.pair);
    if (recordToken({ tokenAddress: L.token, pair: L.pair, launchpadId: "uniswap-bonding-curve" }, "onchain:pair=" + sym)) {
      saved++;
      if (!status.integrationDetected) markIntegration(`W3 (on-chain): launch pools.trade ghép cặp ${sym} (stock/index) — tx ${L.tx}`);
    }
  }
  status.w3.cursor = safeTip + 1;
  status.w3.at = Date.now();
  status.w3.err = null;
  if (saved) saveState();
}

// địa chỉ pair -> ký hiệu stock/index (để cảnh báo dễ đọc)
function symbolOfPair(addr) {
  const a = String(addr).toLowerCase();
  if (indexAssets && indexAssets.stocks) { const s = indexAssets.stocks.find((x) => x.addr === a); if (s) return s.sym; }
  for (const [k, v] of Object.entries(theindex.INDEX_ASSETS)) if (v.toLowerCase() === a) return k;
  return a.slice(0, 10) + "…";
}

// ---- Lệnh chat Telegram (macro giống rh-tracker) ----
async function onCommand(cmd) {
  switch (cmd) {
    case "/status": {
      return [
        `📊 Index-tracker — ${status.integrationDetected ? "🚨 ĐÃ có tín hiệu tích hợp" : (status.consecutiveErrors > 0 ? "⚠️ đang lỗi" : "🟢 đang canh")}`,
        `Uptime: ${uptime()}`,
        `W1 theindex: ${status.w1.parserOk === false ? "⚠️ parser lỗi" : "launchpad gốc [" + status.w1.nativeLaunchpads.join(", ") + "], pools.trade native=" + status.w1.poolstradeNative}`,
        `W2 pools.trade: category [${status.w2.categories.join(", ")}], launchpad [${status.w2.launchpadIds.join(", ")}]`,
        `W3 on-chain: đã quét tới block ${status.w3.cursor != null ? status.w3.cursor - 1 : "?"}${status.w3.err ? " (⚠️ " + status.w3.err + ")" : ""}`,
        `Token index đã lưu: ${status.found.length}`,
        `Lỗi liên tiếp: ${status.consecutiveErrors}${status.lastError ? ` (${status.lastError}, ${ago(status.lastErrorAt)})` : ""}`,
        `Scan gần nhất: ${ago(status.lastScanAt)} | Heartbeat: ${ago(status.lastHeartbeatAt)}`,
      ].join("\n");
    }
    case "/health": {
      const t0 = Date.now();
      let a = false, p = false, o = false, aErr = "", pErr = "", oErr = "";
      try { await theindex.getIntegrationState(); a = true; } catch (e) { aErr = e.message; }
      try { await poolstrade.getValidCategories(); p = true; } catch (e) { pErr = e.message; }
      try { await onchain.getSafeTip(); o = true; } catch (e) { oErr = e.message; }
      const freshMs = status.lastScanAt ? Date.now() - status.lastScanAt : Infinity;
      const freshOk = freshMs <= POLL_MS * 3 + 30000;
      const up = [a, p, o].filter(Boolean).length;
      const verdict = up === 0 ? "🔴 UNHEALTHY" : (up < 3 || !freshOk || status.consecutiveErrors > 0) ? "🟡 DEGRADED" : "🟢 HEALTHY";
      return [
        `${verdict}  (index-tracker, probe ${Date.now() - t0}ms)`,
        `Uptime: ${uptime()}`,
        `${a ? "🟢" : "🔴"} W1 theindex app.js: ${a ? "OK" : "LỖI (" + aErr + ")"}`,
        `${p ? "🟢" : "🔴"} W2 pools.trade API: ${p ? "OK" : "LỖI (" + pErr + ")"}`,
        `${o ? "🟢" : "🔴"} W3 on-chain (RPC/Blockscout): ${o ? "OK" : "LỖI (" + oErr + ")"}`,
        `${freshOk ? "🟢" : "🟡"} Scan gần nhất: ${ago(status.lastScanAt)}`,
        `${status.consecutiveErrors === 0 ? "🟢" : "🔴"} Lỗi liên tiếp: ${status.consecutiveErrors}`,
      ].join("\n");
    }
    case "/ping":
      return "🏓 pong — index-tracker đang chạy, uptime " + uptime();
    case "/watchers":
      return [
        "🔭 Watchers:",
        `W1 theindex app.js — launchpad gốc: [${status.w1.nativeLaunchpads.join(", ")}]`,
        `   pools.trade là native? ${status.w1.poolstradeNative ? "✅ RỒI (tích hợp!)" : "chưa"} | parser: ${status.w1.parserOk === false ? "⚠️ lỗi" : "ok"} (${ago(status.w1.at)})`,
        `W2 pools.trade — category: [${status.w2.categories.join(", ")}]`,
        `   launchpadId: [${status.w2.launchpadIds.join(", ")}] (${ago(status.w2.at)})`,
        `W3 on-chain — quét launcher ${onchain.LAUNCHER}`,
        `   đã tới block ${status.w3.cursor != null ? status.w3.cursor - 1 : "?"}, launch chu kỳ cuối ${status.w3.lastLaunches}, stock-asset ${status.w3.stockCount} (${ago(status.w3.at)})`,
        `Tín hiệu tích hợp: ${status.integrationDetected ? "🚨 ĐÃ CÓ" : "chưa"} | token index đã lưu: ${status.found.length}`,
      ].join("\n");
    case "/assets": {
      try {
        const s = await theindex.getStockAssets();
        const active = s.filter((x) => !x.halted).length;
        return `📈 theindex có ${s.length} stock-asset (${active} đang mở). Vài mã: ${s.slice(0, 12).map((x) => x.sym).join(", ")}…`;
      } catch (e) { return "Không lấy được /api/assets: " + e.message; }
    }
    case "/token":
    case "/tokens":
      if (!status.found.length) {
        return status.integrationDetected
          ? "Đã có tín hiệu tích hợp nhưng chưa lưu token index nào (đang quét)."
          : "Chưa có token index nào — chưa phát hiện tích hợp pools.trade↔index.";
      }
      return `🪙 Token index đã launch trên pools.trade (${status.found.length}):\n` +
        status.found.slice(-20).map((t, i) =>
          `${status.found.length - Math.min(20, status.found.length) + i + 1}. ${t.tokenAddress}` +
          `${t.tokenSymbol ? ` (${t.tokenSymbol})` : ""}${t.pair ? ` ↔${symbolOfPair(t.pair)}` : ""} [${t.via}]`
        ).join("\n");
    case "/help":
    case "/start":
      return "Lệnh: /status  /health  /ping  /watchers  /assets  /token  /help";
    default:
      return null;
  }
}

async function main() {
  loadState();
  listen(onCommand);

  await send(
    `🟢 Index-tracker khởi động — canh theindex ↔ pools.trade (W1 app.js + W2 tRPC + W3 on-chain).\n` +
    `   Baseline đã biết: native [${KNOWN_NATIVE.join(", ")}], category [${KNOWN_CATEGORIES.join(", ")}], launchpad [${KNOWN_LAUNCHPADS.join(", ")}].\n` +
    `   ${status.integrationDetected ? "🚨 ĐÃ tích hợp (từ trạng thái lưu)" : "Sẽ báo ngay khi có tín hiệu tích hợp."} | token đã lưu: ${status.found.length}`
  );

  while (true) {
    try {
      await runW1();
      await runW2();
      await scanIndexTokens();
      try { await runW3(); } catch (e) { status.w3.err = e.message; console.error("W3 err:", e.message); } // W3 lỗi không làm hỏng W1/W2
      saveState();
      status.lastScanAt = Date.now();
      if (status.downAlerted) {
        await alert(`🟢 Đã phục hồi — canh bình thường trở lại (sau ${status.consecutiveErrors} lỗi liên tiếp).`);
        status.downAlerted = false;
      }
      status.consecutiveErrors = 0;
    } catch (e) {
      status.consecutiveErrors++;
      status.lastError = e.message;
      status.lastErrorAt = Date.now();
      console.error("scan err:", e.message);
      if (status.consecutiveErrors >= ERR_THRESHOLD && !status.downAlerted) {
        await alert(`🔴 CẢNH BÁO: index-tracker lỗi ${status.consecutiveErrors} lần liên tiếp.\n   Lỗi: ${e.message}`);
        status.downAlerted = true;
      }
    }

    if (Date.now() - status.lastHeartbeatAt >= HEARTBEAT_MS) {
      status.lastHeartbeatAt = Date.now();
      await alert(`💓 Heartbeat (index) — uptime ${uptime()}, tích hợp: ${status.integrationDetected ? "🚨 CÓ" : "chưa"}, token index lưu ${status.found.length}, lỗi liên tiếp ${status.consecutiveErrors}.`);
    }

    await sleep(POLL_MS);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("Lỗi:", e.message); process.exit(1); });
}

module.exports = { onCommand, status, runW1, runW2, runW3, scanIndexTokens, recordToken, symbolOfPair, KNOWN_CATEGORIES, KNOWN_LAUNCHPADS };
