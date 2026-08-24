// rpc.js — nhiều RPC có failover (#7) + tự tái tạo WebSocket khi rớt (#6).
// Dùng cho poller: mọi lời gọi qua rpc.call(fn) sẽ thử provider hiện tại, lỗi thì
// xoay sang RPC kế tiếp; nếu provider hỏng là WebSocket thì huỷ và tạo lại.
const { ethers } = require("ethers");

function makeProvider(url) {
  if (!/^wss?:/i.test(url)) return new ethers.JsonRpcProvider(url);
  // WebSocket: gắn sẵn handler 'error' để lỗi socket KHÔNG ném 'unhandled error'
  // làm sập tiến trình — nó chỉ khiến các call thất bại, và Rpc.call sẽ xoay sang RPC khác.
  const WebSocket = require("ws");
  return new ethers.WebSocketProvider(() => {
    const ws = new WebSocket(url);
    ws.on("error", () => {}); // nuốt lỗi kết nối (530, refused, reset...)
    return ws;
  });
}

class Rpc {
  constructor(urls) {
    this.urls = urls;
    this.i = 0;
    this.rotations = 0;
    this.providers = urls.map(makeProvider);
  }
  get current() { return this.urls[this.i]; }
  provider() { return this.providers[this.i]; }

  rotate() {
    const from = this.urls[this.i];
    this.i = (this.i + 1) % this.providers.length;
    this.rotations++;
    return { from, to: this.urls[this.i] };
  }

  // Thử fn(provider) lần lượt trên các RPC; trả kết quả đầu tiên OK, hoặc ném lỗi
  // cuối nếu MỌI RPC đều lỗi trong một lượt.
  async call(fn, onRotate) {
    let lastErr;
    for (let k = 0; k < this.providers.length; k++) {
      const idx = this.i;
      try {
        return await fn(this.providers[idx]);
      } catch (e) {
        lastErr = e;
        // #6: nếu là WebSocket, huỷ và tạo lại kết nối đã hỏng
        if (this.urls[idx].startsWith("wss")) {
          try { await this.providers[idx].destroy?.(); } catch (_) {}
          this.providers[idx] = makeProvider(this.urls[idx]);
        }
        const r = this.rotate();
        if (onRotate) onRotate(r, e);
      }
    }
    throw lastErr;
  }

  getBlockNumber(onRotate) { return this.call((p) => p.getBlockNumber(), onRotate); }

  async destroy() {
    for (const p of this.providers) { try { await p.destroy?.(); } catch (_) {} }
  }
}

function parseUrls(env) {
  const raw = env.RPC_URLS || env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

module.exports = { Rpc, makeProvider, parseUrls };
