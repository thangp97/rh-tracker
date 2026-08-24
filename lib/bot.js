// bot.js — Telegram: gửi cảnh báo + LẮNG NGHE lệnh chat (/status, /health, ...).
// Cấu hình qua .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   - send(msg)       : gửi CHẶN (log + chờ gửi xong) — dùng cho startup/reply/test
//   - queueAlert(msg) : gửi KHÔNG CHẶN (#11) — log ngay, xếp hàng gửi nền theo thứ tự
require("./env");

const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";
const configured = Boolean(BOT && CHAT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Escape HTML cho phần text động (dùng khi parse_mode=HTML).
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Gửi 1 lần. Trả về {ok} | {skip} (chưa cấu hình) | {retryAfter} (429) | {permanent}
// (lỗi 4xx như token/chat sai -> đừng thử lại) | {} (lỗi tạm thời -> thử lại).
async function sendOnce(text, chatId, opts = {}) {
  if (!BOT || !chatId) return { skip: true };
  try {
    const body = { chat_id: chatId, text, disable_web_page_preview: true };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    let desc = "", retryAfter = 0;
    try { const j = await r.json(); desc = j.description || ""; retryAfter = j.parameters?.retry_after || 0; } catch (_) {}
    if (r.status === 429) return { retryAfter: retryAfter || 1 };
    if (r.status >= 400 && r.status < 500) { console.error("Telegram lỗi vĩnh viễn (bỏ tin):", r.status, desc); return { permanent: true }; }
    console.error("Telegram lỗi tạm (sẽ thử lại):", r.status, desc);
    return {}; // 5xx tạm thời
  } catch (e) { console.error("Telegram lỗi mạng (sẽ thử lại):", e.message); return {}; }
}

// Gửi CHẶN (reply/startup/test): thử vài lần cho 429/tạm thời, không lặp vô hạn.
async function send(text, chatId = CHAT, opts = {}) {
  console.log(text);
  for (let i = 0; i < 4; i++) {
    const res = await sendOnce(text, chatId, opts);
    if (res.ok) return true;
    if (res.skip || res.permanent) return false;
    await sleep(res.retryAfter ? res.retryAfter * 1000 : 500 * (i + 1));
  }
  return false;
}

// #11 — hàng đợi gửi nền (không chặn caller), giữ đúng thứ tự, KHÔNG mất tin khi
// Telegram lỗi tạm thời: giữ tin ở đầu hàng và thử lại sau (backoff).
const outbox = [];
let sending = false;
async function drain() {
  if (sending) return;
  sending = true;
  while (outbox.length) {
    const j = outbox[0];
    const res = await sendOnce(j.text, CHAT, j.opts);
    if (res.ok || res.skip || res.permanent) { outbox.shift(); continue; }
    // tạm thời -> giữ tin, hẹn thử lại (backoff, tối đa 60s)
    j.tries = (j.tries || 0) + 1;
    const wait = res.retryAfter ? res.retryAfter * 1000 : Math.min(60000, 1000 * 2 ** Math.min(j.tries, 6));
    sending = false;
    setTimeout(() => drain().catch(() => {}), wait);
    return;
  }
  sending = false;
}
function queueAlert(text, opts = {}) {
  console.log(text);            // hiện ngay trên console, đúng thứ tự
  outbox.push({ text, opts });  // xếp hàng gửi Telegram ở nền
  drain().catch(() => {});      // không await -> caller không bị chặn
  return true;
}

// Lắng nghe lệnh chat qua long-poll getUpdates. Chỉ nhận tin từ TELEGRAM_CHAT_ID.
async function listen(onCommand) {
  if (!configured) { console.log("Telegram chưa cấu hình -> không lắng nghe lệnh chat."); return; }
  try { await fetch(`https://api.telegram.org/bot${BOT}/deleteWebhook`); } catch (_) {}

  let offset = 0;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT}/getUpdates?timeout=0`);
    const j = await r.json();
    if (j.ok && j.result.length) offset = j.result[j.result.length - 1].update_id + 1;
  } catch (_) {}

  console.log("Đang lắng nghe lệnh Telegram (/status, /health, /ping, /help ...)");
  while (true) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT}/getUpdates?timeout=50&offset=${offset}`);
      const j = await r.json();
      if (j.ok) {
        for (const u of j.result) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text) continue;
          if (String(m.chat.id) !== String(CHAT)) continue;
          const parts = m.text.trim().split(/\s+/);
          const cmd = parts[0].toLowerCase().replace(/@.*$/, "");
          let reply = null;
          try { reply = await onCommand(cmd, parts.slice(1)); }
          catch (e) { reply = "Lỗi xử lý lệnh: " + e.message; }
          if (reply) await send(reply, m.chat.id);
        }
      } else if (j.error_code === 409) {
        console.error("getUpdates 409 (một bot khác đang chạy cùng token) — chờ...");
        await sleep(5000);
      }
    } catch (e) { await sleep(3000); }
  }
}

module.exports = { send, queueAlert, listen, configured, escapeHtml, _test: { outbox, drain } };
