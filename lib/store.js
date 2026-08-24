// store.js — đọc/ghi JSON đơn giản, an toàn (lỗi -> trả fallback / bỏ qua).
const fs = require("fs");

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (_) {}
}

module.exports = { loadJson, saveJson };
