// test-index-watchers.js — kiểm W1/W2 trên API THẬT (cần mạng). Chạy: node test/test-index-watchers.js
// Xác nhận bot đọc đúng hiện trạng: pools.trade CHƯA tích hợp gốc, và các nguồn dữ liệu còn sống.
const assert = require("assert");
const theindex = require("../lib/theindex");
const poolstrade = require("../lib/poolstrade");
const onchain = require("../lib/poolstrade-onchain");

(async () => {
  // ---- W1: theindex app.js ----
  const st = await theindex.getIntegrationState();
  assert(st.parserOk, "W1 parser phải đọc được app.js (nếu fail: bundle đổi cấu trúc, cần cập nhật)");
  assert(st.nativeLaunchpads.includes("pons"), "phải thấy 'pons' trong launchpad gốc");
  assert(!st.poolstradeNative, "hiện tại pools.trade CHƯA tích hợp gốc (poolstradeNative=false)");
  console.log(`✅ W1 theindex: launchpad gốc [${st.nativeLaunchpads.join(", ")}], pools.trade native=${st.poolstradeNative}`);

  const assets = await theindex.getStockAssets();
  assert(assets.length > 100, "phải lấy được danh sách stock (>100), có: " + assets.length);
  assert(assets.every((a) => /^0x[0-9a-f]{40}$/.test(a.addr)), "mọi stock phải có địa chỉ hợp lệ");
  console.log(`✅ W1 /api/assets: ${assets.length} stock-asset`);

  // ---- W2: pools.trade tRPC ----
  const cats = await poolstrade.getValidCategories();
  assert(Array.isArray(cats) && cats.length >= 3, "phải đọc được enum category, có: " + JSON.stringify(cats));
  assert(cats.includes("trending") && cats.includes("recency"), "category phải gồm trending+recency");
  console.log(`✅ W2 category enum: [${cats.join(", ")}]`);

  const { launchpadIds } = await poolstrade.collectLaunchpadIds();
  assert(launchpadIds.length >= 1, "phải thấy ít nhất 1 launchpadId");
  assert(launchpadIds.includes("uniswap-bonding-curve"), "phải có 'uniswap-bonding-curve'");
  console.log(`✅ W2 launchpadIds: [${launchpadIds.join(", ")}]`);

  // xác nhận category "index/stock" chưa tồn tại (tức chưa tích hợp)
  const idx = cats.filter((c) => /index|stock|equit|linked-?index/i.test(c));
  console.log(`   category kiểu index hiện có: ${idx.length ? idx.join(", ") : "(chưa có — đúng như kỳ vọng)"}`);

  // ---- W3: on-chain (launcher pools.trade) ----
  const tip = await onchain.getSafeTip();
  assert(tip > 40000000, "getSafeTip phải trả block hợp lệ, có: " + tip);
  const launches = await onchain.scanLaunches(tip - 15000, tip);
  assert(Array.isArray(launches), "scanLaunches phải trả mảng");
  assert(launches.every((l) => /^0x[0-9a-fA-F]{40}$/.test(l.token) && /^0x[0-9a-fA-F]{40}$/.test(l.pair)), "mỗi launch phải có token+pair hợp lệ");
  const stockPaired = launches.filter((l) => l.pair !== "0x0000000000000000000000000000000000000000");
  console.log(`✅ W3 on-chain: ${launches.length} launch/15k block; stock-paired ${stockPaired.length} (chưa tích hợp -> kỳ vọng 0)`);

  console.log("\n✅ WATCHERS W1+W2+W3 SỐNG & ĐỌC ĐÚNG HIỆN TRẠNG (pools.trade chưa tích hợp index).");
  process.exit(0);
})().catch((e) => { console.error("❌ FAIL:", e.message); process.exit(1); });
