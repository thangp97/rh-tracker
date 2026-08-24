// test-index-detect.js — kiểm LOGIC bot index (offline, không mạng):
//   (1-4) parser marker W1 (poolstrade vào danh sách launchpad gốc) — bền qua đổi bundle
//   (5)   thu thập & LƯU token index + dedupe theo CA + lệnh /token
const assert = require("assert");
const { parseNativeLaunchpads } = require("../lib/theindex");

// (1) hiện trạng: chỉ pons + letscash (tên hàm minify = H1)
const now = `x=[{id:"pons",label:H1("wizard.you.lpPons")},{id:"letscash",label:H1("wizard.you.lpLetscash")}],y=1`;
const s1 = parseNativeLaunchpads(now);
assert(s1.has("pons") && s1.has("letscash"), "phải bắt được pons+letscash");
assert(!s1.has("poolstrade"), "chưa tích hợp -> KHÔNG có poolstrade");
assert(s1.size === 2, "đúng 2 launchpad gốc, có: " + [...s1].join(","));
console.log("✅ (1) hiện trạng: [pons, letscash], poolstrade CHƯA native");

// (2) SAU tích hợp: poolstrade thêm vào danh sách gốc — tên hàm minify ĐỔI (Zx) để test độ bền
const integrated = `x=[{id:"pons",label:Zx("wizard.you.lpPons")},{id:"letscash",label:Zx("wizard.you.lpLetscash")},{id:"poolstrade",label:Zx("wizard.you.lpPoolsTrade")}]`;
const s2 = parseNativeLaunchpads(integrated);
assert(s2.has("poolstrade") && s2.size === 3, "SAU tích hợp -> phải bắt được poolstrade (marker chính)");
console.log("✅ (2) sau tích hợp: marker poolstrade native FIRES (bền cả khi tên hàm minify đổi H1->Zx)");

// (3) bundle vỡ cấu trúc -> parser trả rỗng (bot cảnh báo 🟡 cần cập nhật, không im lặng)
assert(parseNativeLaunchpads("hoan toan khong lien quan {id:'x'} label foo").size === 0, "cấu trúc lạ -> rỗng");
console.log("✅ (3) bundle lạ -> parserOk=false (không nhận nhầm)");

// (4) KHÔNG nhầm poolstrade ở luồng "wizard.out.*" (launchpad ngoài) thành native
const withOut = `a={poolstrade:"wizard.out.nextPoolsTrade"};b=[{id:"pons",label:Q("wizard.you.lpPons")}]`;
const s4 = parseNativeLaunchpads(withOut);
assert(s4.has("pons") && !s4.has("poolstrade"), "KHÔNG được nhầm poolstrade ở wizard.out.* thành native");
console.log("✅ (4) bỏ qua wizard.out.* (pools.trade dạng 'launchpad ngoài' không tính là tích hợp)");

// (5) W3 pairOf: cặp ghép = currency KHÁC token trong PoolKey (currency0, currency1, ...)
const onchain = require("../lib/poolstrade-onchain");
const tok = "0x1aeb8d92fababe5320b48c571e36f7d7a39a51f1";
// ETH-paired: currency0=0x0, currency1=token -> pair = 0x0
assert(onchain.pairOf({ token: tok, key: ["0x0000000000000000000000000000000000000000", tok, 2500, 25, "0x0"] }).toLowerCase() === "0x0000000000000000000000000000000000000000", "ETH pair phải là 0x0");
// stock-paired: currency0=token, currency1=stock -> pair = stock
const STOCK = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"; // NVDA
assert(onchain.pairOf({ token: tok, key: [tok, STOCK, 2500, 25, "0x0"] }).toLowerCase() === STOCK, "stock pair phải là địa chỉ stock");
console.log("✅ (5) W3 pairOf: tách đúng cặp ghép (ETH vs stock) từ PoolKey");

(async () => {
  // (6) thu thập & LƯU token index + dedupe + /token (baseline CỨNG: 'index' không thuộc KNOWN)
  const pt = require("../lib/poolstrade");
  const idx = require("../track-index");
  idx.status.w2.categories = ["recency", "trending", "index"]; // 'index' là category mới (ngoài KNOWN)
  idx.status.w2.launchpadIds = ["uniswap-bonding-curve"];
  idx.status.found = [];

  pt.listLaunches = async (c) => c === "index"
    ? [{ tokenAddress: "0xAAA", tokenSymbol: "IDX1", launchpadId: "uniswap-bonding-curve" },
       { tokenAddress: "0xBBB", tokenSymbol: "IDX2", launchpadId: "uniswap-bonding-curve" }]
    : [];

  await idx.scanIndexTokens();
  assert(idx.status.found.length === 2, "phải lưu 2 token index, có: " + idx.status.found.length);
  console.log("✅ (6a) lưu token index từ category mới (2 token)");

  await idx.scanIndexTokens(); // quét lại cùng dữ liệu
  assert(idx.status.found.length === 2, "quét lại phải DEDUPE (vẫn 2), có: " + idx.status.found.length);
  console.log("✅ (6b) dedupe theo CA: quét lại không thêm trùng");

  pt.listLaunches = async (c) => c === "index" ? [{ tokenAddress: "0xAAA" }, { tokenAddress: "0xCCC", tokenSymbol: "IDX3" }] : [];
  await idx.scanIndexTokens();
  assert(idx.status.found.length === 3, "token MỚI phải được thêm (3), có: " + idx.status.found.length);
  console.log("✅ (6c) token mới xuất hiện -> lưu thêm");

  const out = await idx.onCommand("/token");
  assert(out.includes("0xAAA") && out.includes("0xCCC"), "/token phải liệt kê token đã lưu");
  console.log("✅ (6d) /token liệt kê token đã launch");

  try { require("fs").unlinkSync("./index_state.json"); } catch (_) {} // dọn file test tạo
  console.log("\n✅ LOGIC BOT INDEX ĐẠT (marker W1 + W3 pairOf + thu thập/dedupe token + /token).");
  process.exit(0);
})().catch((e) => { console.error("❌ FAIL:", e.stack || e.message); process.exit(1); });
