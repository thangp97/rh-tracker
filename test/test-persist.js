// test-persist.js — kiểm chứng #10 (lưu lịch sử JSON) và #11 (alert không chặn).
require("../lib/env");
const assert = require("assert");
const fs = require("fs");
const { loadJson, saveJson } = require("../lib/store");
const { queueAlert } = require("../lib/bot");

// ---- #10: store load/save + fallback ----
const f = "./.tokens_test.tmp.json";
saveJson(f, [{ token: "0xabc", symbol: "X" }]);
const back = loadJson(f, null);
assert(Array.isArray(back) && back[0].token === "0xabc", "store round-trip hỏng");
assert(loadJson("./khong-ton-tai.json", "FB") === "FB", "fallback hỏng");
fs.unlinkSync(f);
console.log("✅ #10 store load/save + fallback OK");

// ---- #11: queueAlert trả NGAY (đồng bộ, không phải Promise) => không chặn caller ----
const r = queueAlert("test-noblock (không cấu hình Telegram nên chỉ log)");
assert(r === true, "queueAlert phải trả true");
assert(!(r instanceof Promise), "queueAlert KHÔNG được trả Promise (phải không chặn)");
console.log("✅ #11 queueAlert trả ngay, không chặn caller");

console.log("\n✅ #10 + #11 ĐẠT.");
process.exit(0);
