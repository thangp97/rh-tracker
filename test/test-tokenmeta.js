// test-tokenmeta.js — kiểm LOGIC thuần của lib/tokenmeta (OFFLINE): pctOf / humanSupply / usd / renderEnrichment.
// (Phần gọi Blockscout getTokenInfo/getTopHolders cần mạng -> không test ở đây.)
const assert = require("assert");
const tm = require("../lib/tokenmeta");

// (1) pctOf bằng BigInt (chính xác, không lệ thuộc float)
assert.strictEqual(tm.pctOf("250", "1000"), 25, "250/1000 = 25%");
assert.strictEqual(tm.pctOf("1", "8"), 12.5, "1/8 = 12.5%");
assert.strictEqual(tm.pctOf(null, "1000"), null, "thiếu value -> null");
assert.strictEqual(tm.pctOf("5", "0"), null, "total 0 -> null");
console.log("✅ (1) pctOf: % chính xác bằng BigInt");

// (2) humanSupply: rút gọn B/M/K
assert.strictEqual(tm.humanSupply("1000000000000000000000000000", 18), "1.00B");
assert.strictEqual(tm.humanSupply("5000000000000000000000000", 18), "5.00M");
console.log("✅ (2) humanSupply: rút gọn B/M/K");

// (3) usd: định dạng + bỏ 0
assert.strictEqual(tm.usd("0"), null);
assert.ok(String(tm.usd("12345")).startsWith("$"), "usd có $");
console.log("✅ (3) usd: định dạng + bỏ 0");

// (4) renderEnrichment: supply/holders/market + top-holder %
const meta = { totalSupplyRaw: "1000000000000000000000000000", decimals: 18, holdersCount: 1234, marketCap: "12345", price: "0.0000123", volume24h: "4567" };
const holders = [
  { address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", isContract: true, pct: 25.3 },
  { address: "0x5E2855de9E7E7bEDB405206bff6c648000337a30", isContract: false, pct: 12.1 },
];
const out = tm.renderEnrichment(meta, holders, (s) => s);
assert.ok(out.includes("Supply 1.00B") && out.includes("Holders 1,234"), "supply/holders");
assert.ok(out.includes("MCap") && out.includes("Top 2 holder"), "market + top header");
assert.ok(out.includes("25.30%") && out.includes("12.10%"), "pct 2 chữ số");
assert.ok(out.includes("📄"), "đánh dấu contract");
console.log("✅ (4) renderEnrichment: supply/holders/market + top-holder %");

console.log("\n✅ TOKENMETA ĐẠT.");
process.exitCode = 0;
