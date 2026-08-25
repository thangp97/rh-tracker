// socials.mjs — lấy metadata off-chain (twitter/website/description/image) từ URI (thường ipfs://).
// ĐUA nhiều IPFS gateway, lấy cái phản hồi ĐẦU TIÊN (Promise.any) — KHÔNG để IPFS chậm chặn cảnh báo
// (việc này chạy NỀN, ngoài đường tới hạn; thẻ đã gửi trước rồi).
const GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];
const TIMEOUT_MS = 3500;

// ipfs://CID[/path] -> phần path để ghép vào gateway. http(s) -> null (fetch trực tiếp).
function ipfsPath(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  return null;
}

async function fetchJsonTimed(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "easya-tracker" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Trả {twitter,website,description,image,createdOn} hoặc {} nếu không lấy được (không bao giờ ném).
export async function fetchSocials(uri) {
  if (!uri) return {};
  let json = null;
  try {
    const p = ipfsPath(uri);
    if (p) json = await Promise.any(GATEWAYS.map((g) => fetchJsonTimed(g + p)));
    else if (/^https?:\/\//i.test(uri)) json = await fetchJsonTimed(uri);
    else return {};
  } catch (_) { return {}; }
  if (!json || typeof json !== "object") return {};
  return {
    twitter: json.twitter || json.twitter_url || null,
    website: json.website || null,
    description: json.description || null,
    image: json.image || null,
    createdOn: json.createdOn || null,
  };
}
