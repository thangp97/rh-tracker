// push.js — subscription eth_subscribe(logs) qua WebSocket để BÁO SỚM (0-conf), tự tái tạo khi ws rớt.
//
// QUAN TRỌNG: push chỉ để "báo nhanh" — KHÔNG phải nguồn chân lý. Vòng poll của track-ws mới là nguồn
// chân lý (quét theo cursor, failover, dự phòng Blockscout, giữ CONFIRMATIONS). Nếu push chết, poll vẫn
// bắt đủ (chỉ chậm hơn). Vì vậy độ bền của push để "best-effort": lỗi thì thử lại, không làm sập bot.
const { ethers } = require("ethers");

// startPush({ wsUrl, filters, onEvent, onStatus }) -> { stop() }
//   filters: mảng filter kiểu ethers {address?, topics?}. onEvent(log) gọi cho MỖI log khớp.
//   onStatus("connected"|"reconnecting") (tuỳ chọn) để bot cập nhật trạng thái.
function startPush({ wsUrl, filters, onEvent, onStatus }) {
  const WebSocket = require("ws");
  let provider = null, activeWs = null, stopped = false, timer = null;
  const emit = (s) => { try { onStatus && onStatus(s); } catch (_) {} };

  function cleanup() {
    try { provider && provider.destroy && provider.destroy(); } catch (_) {}
    provider = null;
  }
  function scheduleReconnect() {
    if (stopped || timer) return;
    emit("reconnecting");
    timer = setTimeout(() => { timer = null; connect(); }, 3000);
  }
  function connect() {
    if (stopped) return;
    cleanup();
    try {
      provider = new ethers.WebSocketProvider(() => {
        const ws = new WebSocket(wsUrl);
        activeWs = ws;
        ws.on("error", () => {});                                  // nuốt lỗi socket (530/refused/reset...)
        ws.on("close", () => { if (ws === activeWs) scheduleReconnect(); }); // chỉ ws hiện tại mới trigger reconnect
        return ws;
      });
      for (const f of filters) provider.on(f, (log) => { try { onEvent(log); } catch (_) {} });
      emit("connected");
    } catch (_) { scheduleReconnect(); }
  }

  connect();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); activeWs = null; cleanup(); } };
}

module.exports = { startPush };
