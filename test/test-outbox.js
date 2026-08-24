// test-outbox.js — chứng minh hàng đợi cảnh báo KHÔNG mất tin khi Telegram lỗi
// tạm thời, và gửi lại được khi hồi phục. (Giả lập fetch, không gọi Telegram thật.)
process.env.TELEGRAM_BOT_TOKEN = "test:token";
process.env.TELEGRAM_CHAT_ID = "1";

const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mode = "fail"; // "fail" = Telegram lỗi tạm (503), "ok" = thành công
let sent = 0;
global.fetch = async () => {
  if (mode === "fail") return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  sent++;
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
};

const bot = require("../lib/bot");

(async () => {
  bot.queueAlert("token-alert-1"); // gửi lúc Telegram đang lỗi
  await sleep(300);
  assert(bot._test.outbox.length === 1, "❌ tin bị mất khi Telegram lỗi (phải giữ lại)");
  console.log("✅ giữ tin khi Telegram lỗi tạm thời (outbox=1, không mất)");

  mode = "ok"; // Telegram hồi phục
  await bot._test.drain();
  assert(bot._test.outbox.length === 0, "❌ chưa gửi hết sau khi hồi phục");
  assert(sent >= 1, "❌ không gửi được sau hồi phục");
  console.log("✅ gửi lại thành công sau khi Telegram hồi phục (outbox=0)");

  console.log("\n✅ KHÔNG MẤT CẢNH BÁO.");
  process.exit(0);
})().catch((e) => { console.error("❌ FAIL:", e.message); process.exit(1); });
