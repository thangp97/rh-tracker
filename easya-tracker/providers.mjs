// providers.mjs — pool nhiều endpoint Solana có FAILOVER (chống điểm chết đơn Helius).
// Nguồn endpoint (ưu tiên trên xuống): SOLANA_RPC_URLS (nhiều URL, cách nhau dấu phẩy) -> HELIUS_API_KEY.
// wsEndpoint suy ra bằng cách đổi http(s):// -> ws(s)://. Dùng cho cả RPC (getParsedTransaction/getBalance/
// getSlot, thử lần lượt) lẫn websocket (onLogs/onSlotChange trên endpoint hiện tại, xoay khi chết).
import { Connection } from "@solana/web3.js";

// Trả [{http, ws}]. Rỗng nếu không cấu hình endpoint nào.
export function parseProviders(env = process.env) {
  const raw = (env.SOLANA_RPC_URLS || env.RPC_URLS || "").trim();
  let http = [];
  if (raw) http = raw.split(",").map((s) => s.trim()).filter(Boolean);
  else if (env.HELIUS_API_KEY) http = [`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`];
  return http.map((u) => ({ http: u, ws: u.replace(/^http/i, "ws") })); // https->wss, http->ws
}

// Che api-key khi log/cảnh báo.
export const maskUrl = (u) => String(u || "").replace(/(api-key=)[^&\s]+/i, "$1***");

export class Pool {
  constructor(providers, commitment = "confirmed") {
    if (!providers.length) throw new Error("Không có endpoint Solana (đặt HELIUS_API_KEY hoặc SOLANA_RPC_URLS trong .env).");
    this.providers = providers;
    this.commitment = commitment;
    this.i = 0;
    this.rotations = 0;
    this.conns = providers.map((p) => new Connection(p.http, { commitment, wsEndpoint: p.ws }));
  }
  get size() { return this.conns.length; }
  get current() { return this.providers[this.i].http; }
  conn() { return this.conns[this.i]; }
  rotate() { this.i = (this.i + 1) % this.conns.length; this.rotations++; return this.current; }

  // Thử fn(conn) lần lượt trên các endpoint (bắt đầu từ endpoint hiện tại); trả kết quả đầu OK,
  // hoặc ném lỗi cuối nếu MỌI endpoint đều lỗi trong một lượt.
  async call(fn) {
    let last;
    for (let k = 0; k < this.conns.length; k++) {
      try { return await fn(this.conns[this.i]); }
      catch (e) { last = e; this.rotate(); }
    }
    throw last;
  }
}
