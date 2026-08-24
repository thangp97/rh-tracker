// notify.js — giữ tương thích ngược; chuyển tiếp sang bot.js
// (gửi Telegram cấu hình qua .env: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)
const { send, configured } = require("./bot");
module.exports = { notify: send, configured };
