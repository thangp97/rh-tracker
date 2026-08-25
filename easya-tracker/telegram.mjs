// telegram.mjs — gửi/sửa/reply thẻ Telegram qua fetch (không cần thư viện).
// Mẫu "gửi nhanh, làm giàu bằng edit": send() thẻ với dữ liệu on-chain NGAY (giữ msg_id),
// rồi edit() thêm mô tả + socials sau khi có IPFS -> độ trễ cảnh báo không phụ thuộc IPFS.
import "./env.mjs"; // đảm bảo .env đã nạp trước khi đọc token

const tok = () => process.env.TELEGRAM_BOT_TOKEN || "";
const chat = () => process.env.TELEGRAM_CHAT_ID || "";
export function configured() { return Boolean(tok() && chat()); }

const API = (m) => `https://api.telegram.org/bot${tok()}/${m}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Chỉ cho phép http(s) trong href (twitter/website đến từ JSON off-chain KHÔNG tin cậy).
function safeUrl(u) { return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null; }

async function call(method, body) {
  const r = await fetch(API(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disable_web_page_preview: true, parse_mode: "HTML", ...body }),
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error(`Telegram ${method}: ${j?.description || r.status}`);
  return j.result;
}

// send -> trả message_id (hoặc null nếu chưa cấu hình / lỗi). KHÔNG ném (không làm hỏng handler).
export async function send(text, extra = {}) {
  if (!configured()) { console.log("[telegram chưa cấu hình]\n" + text); return null; }
  try { const res = await call("sendMessage", { chat_id: chat(), text, ...extra }); return res.message_id; }
  catch (e) { console.error("send lỗi:", e.message); return null; }
}
export async function edit(messageId, text, extra = {}) {
  if (!configured() || !messageId) return false;
  try { await call("editMessageText", { chat_id: chat(), message_id: messageId, text, ...extra }); return true; }
  catch (e) { console.error("edit lỗi:", e.message); return false; }
}
export async function reply(messageId, text, extra = {}) {
  return send(text, messageId ? { reply_to_message_id: messageId, ...extra } : extra);
}

// Lắng nghe lệnh chat qua long-poll getUpdates. CHỈ nhận tin từ TELEGRAM_CHAT_ID.
// getUpdates độc quyền theo token -> bot này phải dùng token RIÊNG (khác các bot khác), nếu không sẽ 409.
export async function listen(onCommand) {
  if (!configured()) { console.log("Telegram chưa cấu hình -> không lắng nghe lệnh chat."); return; }
  try { await fetch(API("deleteWebhook")); } catch (_) {}

  let offset = 0;
  try {
    const r = await fetch(API("getUpdates") + "?timeout=0");
    const j = await r.json();
    if (j.ok && j.result.length) offset = j.result[j.result.length - 1].update_id + 1; // bỏ tồn đọng cũ
  } catch (_) {}

  console.log("Đang lắng nghe lệnh Telegram (/status /health /ping /tokens /help)…");
  for (;;) {
    try {
      const r = await fetch(API("getUpdates") + `?timeout=50&offset=${offset}`);
      const j = await r.json();
      if (j.ok) {
        for (const u of j.result) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text) continue;
          if (String(m.chat.id) !== String(chat())) continue; // chỉ chủ sở hữu
          const parts = m.text.trim().split(/\s+/);
          const cmd = parts[0].toLowerCase().replace(/@.*$/, ""); // bỏ hậu tố @botname
          let out = null;
          try { out = await onCommand(cmd, parts.slice(1)); }
          catch (e) { out = "Lỗi xử lý lệnh: " + e.message; }
          if (out) await send(out);
        }
      } else if (j.error_code === 409) {
        console.error("getUpdates 409 (bot khác đang chạy cùng token) — chờ…");
        await sleep(5000);
      }
    } catch (_) { await sleep(3000); }
  }
}

// ---- định dạng thẻ ----
const solscanAcc = (a) => `https://solscan.io/account/${a}`;
const solscanTok = (a) => `https://solscan.io/token/${a}`;
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "?");

// hàng link: Solscan (luôn có) + Kickstart (nếu đặt KICKSTART_BASE trong .env).
function linkRow(mint) {
  const parts = [`<a href="${solscanTok(mint)}">Solscan</a>`];
  const kb = process.env.KICKSTART_BASE;
  if (kb) parts.push(`<a href="${escapeHtml(kb) + mint}">Kickstart</a>`);
  return "🔗 " + parts.join(" · ");
}

// Thẻ ban đầu — CHỈ dữ liệu on-chain (gửi ngay, độ trễ thấp).
export function formatCard(d, devBalanceSol) {
  const L = [];
  L.push(`🚀 <b>EASYA LAUNCH</b>${d.symbol ? " — $" + escapeHtml(d.symbol) : ""}`);
  if (d.name) L.push(escapeHtml(d.name));
  L.push(`Mint: <code>${d.mint}</code>`);
  L.push(`Dev: <a href="${solscanAcc(d.creator)}">${short(d.creator)}</a> · ví ${devBalanceSol != null ? devBalanceSol.toFixed(2) : "?"} SOL`);
  const pct = d.pctSupply != null ? ` (${d.pctSupply.toFixed(2)}% supply)` : "";
  L.push(d.buySol > 0 ? `Dev mua: ${d.buySol.toFixed(3)} SOL${pct}` : "Dev mua: 0 SOL (không mua)");
  L.push(linkRow(d.mint));
  return L.join("\n");
}

// Thẻ đã làm giàu — thêm mô tả + socials (dùng khi edit sau khi có IPFS).
export function formatEnriched(d, devBalanceSol, s = {}) {
  const base = formatCard(d, devBalanceSol);
  const extra = [];
  if (s.description) extra.push("", escapeHtml(String(s.description)).slice(0, 300));
  const soc = [];
  const tw = safeUrl(s.twitter), web = safeUrl(s.website);
  if (tw) soc.push(`<a href="${tw}">Twitter</a>`);
  if (web) soc.push(`<a href="${web}">Website</a>`);
  if (soc.length) extra.push("", soc.join(" · "));
  return base + (extra.length ? "\n" + extra.join("\n") : "");
}
