// guard.js — bắt lỗi toàn cục để bot không chết âm thầm trên VPS.
// unhandledRejection: chỉ log (không thoát). uncaughtException: log + báo Telegram
// + thoát mã 1 để process manager (pm2/systemd) khởi động lại sạch.
const { send } = require("./bot");

process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection:", e && (e.stack || e.message || e));
});

process.on("uncaughtException", (e) => {
  console.error("uncaughtException:", e && (e.stack || e.message || e));
  try { send(`🔴 Tracker lỗi nghiêm trọng, thoát để khởi động lại:\n${e && e.message}`); } catch (_) {}
  setTimeout(() => process.exit(1), 1500);
});
