// theindex.js — đọc trạng thái tích hợp launchpad từ theindex.finance (watcher W1).
//  - app.js : tập launchpad TÍCH HỢP GỐC (mảng picker "wizard.you.lp*").
//             MARKER chính: khi "poolstrade" xuất hiện ở đây => theindex đã tích hợp gốc pools.trade.
//  - /api/assets : danh sách stock (pair-asset "index") — động, khỏi hardcode.
//
// Chỉ ĐỌC (fetch), không side-effect. Ném lỗi để caller (track-index) đếm lỗi + cảnh báo.
const APP_JS = process.env.THEINDEX_APP_JS || "https://indices.theindex.finance/app.js";
const POOLSTRADE_RE = /pools?[-_]?trade/i; // khớp "poolstrade"/"poolsTrade"/"pools-trade"…
const ASSETS_API = process.env.THEINDEX_ASSETS || "https://indices.theindex.finance/api/assets";

// pair-asset đặc biệt của theindex ngoài stock (từ app.js: mT, mainnet). Token ghép cặp = "tích hợp index".
const INDEX_ASSETS = {
  INDEX: "0x56910D4409F3a0C78C64DD8D0545FF0705389870",
  PONS: "0x39dBED3a2bd333467115dE45665cC57F813C4571",
  CASHCAT: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
};

async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": "rh-index-tracker" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "rh-index-tracker" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// Trích tập id launchpad TÍCH HỢP GỐC từ mảng picker của app.js:
//   [{id:"pons",label:X("wizard.you.lpPons")},{id:"letscash",label:X("wizard.you.lpLetscash")}]
// Neo theo khoá i18n ỔN ĐỊNH "wizard.you.lp<Name>" (tên hàm minify X thì để wildcard) nên bền
// qua các lần rebuild/đổi hash. Trả Set id, vd {"pons","letscash"}.
function parseNativeLaunchpads(appjs) {
  const ids = new Set();
  const re = /\{id:"([A-Za-z0-9_-]+)",label:[A-Za-z0-9$_]+\("wizard\.you\.lp[A-Za-z]+"\)\}/g;
  let m;
  while ((m = re.exec(appjs))) ids.add(m[1]);
  return ids;
}

// Cache theo ETag: app.js chỉ đổi khi theindex redeploy -> phần lớn thời gian trả 304 (rẻ),
// tránh tải lại 3.5MB + parse mỗi chu kỳ (đỡ egress + tránh bị chặn IP do hammer).
let _cache = { etag: null, state: null };
function buildState(appjs) {
  const native = parseNativeLaunchpads(appjs);
  const ids = [...native];
  return {
    nativeLaunchpads: ids.sort(),
    poolstradeNative: ids.some((id) => POOLSTRADE_RE.test(id)), // MARKER: pools.trade đã là launchpad gốc?
    parserOk: native.size > 0,                                 // false => regex vỡ do bundle đổi (cần cập nhật)
    appSize: appjs.length,
  };
}

// Trạng thái tích hợp phía theindex (dùng cho W1). Ném nếu app.js không tải được.
async function getIntegrationState() {
  const headers = { "user-agent": "rh-index-tracker" };
  if (_cache.etag) headers["If-None-Match"] = _cache.etag;
  const r = await fetch(APP_JS, { headers });
  if (r.status === 304 && _cache.state) return _cache.state;
  if (!r.ok) throw new Error(`HTTP ${r.status} ${APP_JS}`);
  const appjs = await r.text();
  const state = buildState(appjs);
  _cache = { etag: r.headers.get("etag"), state };
  return state;
}

// Danh sách stock (pair-asset "index") từ /api/assets. Trả [{sym,addr(lower),name,halted}].
async function getStockAssets() {
  const j = await fetchJson(ASSETS_API);
  const arr = j.assets || j || [];
  return arr.map((a) => ({
    sym: a.sym,
    addr: String(a.addr || "").toLowerCase(),
    name: a.name,
    halted: !!a.halted,
  })).filter((a) => a.addr);
}

// Tập TẤT CẢ địa chỉ pair-asset "index" (stock + INDEX/PONS/CASHCAT), lowercase. Dùng cho W2/W3.
async function getIndexPairAssets() {
  const stocks = await getStockAssets();
  const set = new Set(stocks.map((s) => s.addr));
  for (const a of Object.values(INDEX_ASSETS)) set.add(a.toLowerCase());
  return { set, stockCount: stocks.length, stocks };
}

module.exports = {
  getIntegrationState,
  getStockAssets,
  getIndexPairAssets,
  parseNativeLaunchpads,
  INDEX_ASSETS,
  APP_JS,
  ASSETS_API,
};
