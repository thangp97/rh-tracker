// tokenmeta.js — làm giàu thẻ token cho 2 bot EVM bằng dữ liệu Blockscout (miễn phí, không key):
//   - getTokenInfo: name/symbol/decimals/totalSupply + market cap/giá/volume 24h/holders/icon.
//   - getTopHolders: top-N holder + % (từ /holders, đã sắp giảm dần).
// Socials (X/website) KHÔNG có on-chain lẫn ở Blockscout token API -> không lấy ở đây (cần pools.trade/Pons).
// Mọi hàm best-effort: ném lỗi để caller bắt và gửi thẻ "trơn" nếu Blockscout lỗi.
const BASE = process.env.BLOCKSCOUT_BASE || "https://robinhoodchain.blockscout.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch JSON có retry ngắn (token mới có thể chưa index ngay). Ném nếu vẫn hỏng.
async function api(path, tries = 3) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}${path}`);
      if (r.ok) return await r.json();
      last = "HTTP " + r.status;
      if (r.status === 404) await sleep(1500 * (i + 1)); // chưa index -> chờ chút
    } catch (e) { last = e.message; }
    await sleep(600 * (i + 1));
  }
  throw new Error("Blockscout " + path + ": " + last);
}

// Thông tin token (Blockscout token API). Chuẩn hoá về field gọn.
async function getTokenInfo(address) {
  const j = await api(`/api/v2/tokens/${address}`);
  return {
    name: j.name || null,
    symbol: j.symbol || null,
    decimals: j.decimals != null ? Number(j.decimals) : 18,
    totalSupplyRaw: j.total_supply || null,            // chuỗi wei
    holdersCount: j.holders_count != null ? Number(j.holders_count) : null,
    marketCap: j.circulating_market_cap || null,       // USD (chuỗi) | null
    price: j.exchange_rate || null,                    // USD/token | null
    volume24h: j.volume_24h || null,                   // USD | null
    iconUrl: j.icon_url || null,
  };
}

// Top-N holder + %. totalSupplyRaw để tính %. Trả [{address, isContract, pct}]. Ném nếu API lỗi.
async function getTopHolders(address, totalSupplyRaw, limit = 10) {
  const j = await api(`/api/v2/tokens/${address}/holders`);
  const items = (j.items || []).slice(0, limit);
  return items.map((it) => ({
    address: it.address?.hash || String(it.address || ""),
    isContract: !!it.address?.is_contract,
    pct: pctOf(it.value, totalSupplyRaw),
  }));
}

// % = value/total*100 (BigInt -> giữ 4 chữ số thập phân). Trả number | null.
function pctOf(valueRaw, totalRaw) {
  try {
    if (valueRaw == null || totalRaw == null) return null;
    const T = BigInt(totalRaw);
    if (T <= 0n) return null;
    return Number(BigInt(valueRaw) * 1000000n / T) / 10000;
  } catch (_) { return null; }
}

// ---- format ----
const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "?");
function usd(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  if (n >= 1) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return "$" + Number(n.toPrecision(3)); // giá rất nhỏ
}
function humanSupply(raw, decimals = 18) {
  try {
    const n = Number(BigInt(raw) / (10n ** BigInt(decimals)));
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return n.toLocaleString("en-US");
  } catch (_) { return null; }
}
function explorerToken(address) { return `${BASE}/token/${address}`; }

// Khối HTML làm giàu (supply/holders/market + top holder). esc = hàm escapeHtml của bot.
// Trả "" nếu không có gì để hiện.
function renderEnrichment(meta, holders, esc = (s) => s) {
  const L = [];
  if (meta) {
    const s1 = [];
    const sup = meta.totalSupplyRaw ? humanSupply(meta.totalSupplyRaw, meta.decimals) : null;
    if (sup) s1.push(`Supply ${sup}`);
    if (meta.holdersCount != null) s1.push(`Holders ${meta.holdersCount.toLocaleString("en-US")}`);
    if (s1.length) L.push(s1.join(" · "));
    const s2 = [];
    if (usd(meta.marketCap)) s2.push(`MCap ${usd(meta.marketCap)}`);
    if (usd(meta.price)) s2.push(`Giá ${usd(meta.price)}`);
    if (usd(meta.volume24h)) s2.push(`Vol24h ${usd(meta.volume24h)}`);
    if (s2.length) L.push(s2.join(" · "));
  }
  if (holders && holders.length) {
    L.push(`👥 Top ${holders.length} holder:`);
    holders.forEach((h, i) => {
      const pct = h.pct != null ? h.pct.toFixed(2) + "%" : "?";
      const addr = String(h.address || ""); // escape phòng Blockscout trả field lạ -> tránh vỡ HTML/rớt thẻ
      L.push(`${String(i + 1).padStart(2)}. <a href="${BASE}/address/${esc(addr)}">${esc(shortAddr(addr))}</a>${h.isContract ? " 📄" : ""} — ${pct}`);
    });
  }
  return L.join("\n");
}

module.exports = { getTokenInfo, getTopHolders, pctOf, humanSupply, usd, shortAddr, explorerToken, renderEnrichment, BASE };
