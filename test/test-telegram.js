// test-telegram.js — kiểm tra kênh cảnh báo trước khi dùng thật.
// Chạy: node test-telegram.js   (đọc TELEGRAM_* từ .env hoặc biến môi trường)
require("../lib/env"); // nạp .env trước khi đọc biến môi trường
const { notify, configured } = require("../lib/notify");

(async () => {
  if (!configured) {
    console.log("⚠️  Chưa cấu hình TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID -> chỉ in console, không gửi.");
  }
  const ok = await notify("✅ Test tracker Robinhood Chain: nếu thấy tin này trên Telegram, kênh cảnh báo OK.");
  console.log(configured
    ? (ok ? "✅ Đã gửi Telegram thành công." : "❌ Gửi Telegram thất bại — kiểm tra lại token/chat id.")
    : "ℹ️  Điền 2 biến môi trường rồi chạy lại để gửi thật.");
  process.exit(0);
})();
