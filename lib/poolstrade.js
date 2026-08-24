// poolstrade.js — client tRPC của pools.trade (watcher W2).
// Tín hiệu tích hợp index:
//   (a) CATEGORY MỚI trong enum sortBy (hiện: volume/recency/linked-x/trending) — vd "index"/"stocks".
//   (b) launchpadId MỚI ngoài "uniswap-bonding-curve".
//   (c) token stock-paired đầu tiên (xác nhận qua pair-asset "index" — cần đối chiếu on-chain/W3).
// Chỉ ĐỌC. Ném lỗi để caller đếm lỗi + cảnh báo.
const BASE = process.env.POOLSTRADE_BASE || "https://pools.trade";

// gọi tRPC (batch=1). Trả về data của thủ tục đầu. Ném nếu HTTP lỗi / shape lạ / tRPC error.
async function trpc(proc, input) {
  const url = `${BASE}/api/trpc/${proc}?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": input }))}`;
  const r = await fetch(url, { headers: { "user-agent": "rh-index-tracker", "content-type": "application/json" } });
  const j = await r.json().catch(() => null);
  if (j && j[0] && j[0].error) {
    const e = new Error(`pools.trade ${proc}: ${j[0].error?.json?.message || j[0].error?.message || "tRPC error"}`);
    e.trpc = j[0].error;
    throw e;
  }
  if (!r.ok) throw new Error(`pools.trade ${proc} HTTP ${r.status}`);
  const data = j?.[0]?.result?.data;
  if (data == null) throw new Error(`pools.trade ${proc}: shape lạ`);
  return Array.isArray(data) ? data : (data.json || data.launches || data.items || data);
}

// listLaunchesDeep cho 1 category. Trả mảng launch (mỗi launch: {launchpadId,tokenAddress,tokenSymbol,
// tokenName,createdAt,creatorAddress,poolStats,...}).
async function listLaunches(sortBy = "recency") {
  return trpc("curve.listLaunchesDeep", { sortBy });
}

// Lấy danh sách CATEGORY hợp lệ hiện tại bằng cách gửi 1 giá trị SAI -> zod trả về enum hợp lệ.
// Baseline để phát hiện category mới (tín hiệu (a)). Trả mảng string đã sort.
async function getValidCategories() {
  const url = `${BASE}/api/trpc/curve.listLaunchesDeep?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { sortBy: "__probe__" } }))}`;
  const r = await fetch(url, { headers: { "user-agent": "rh-index-tracker" } });
  const j = await r.json().catch(() => null);
  const msg = j?.[0]?.error?.json?.message || j?.[0]?.error?.message || "";
  try {
    const issues = JSON.parse(msg);
    const vals = issues?.[0]?.values || issues?.[0]?.options || [];
    if (Array.isArray(vals) && vals.length) return [...vals].map(String).sort();
  } catch (_) {}
  throw new Error("pools.trade: không đọc được enum category (schema đổi?)");
}

// Thu thập tập launchpadId đang hiện diện (tín hiệu (b)). Quét nhiều category cho phủ.
// NÉM nếu MỌI category đều lỗi (để caller đếm lỗi thay vì coi nhầm "không có launchpad nào").
async function collectLaunchpadIds(categories = ["trending", "recency", "linked-x", "volume"]) {
  const ids = new Set();
  const sample = {};
  let fails = 0;
  for (const c of categories) {
    let arr = null;
    try { arr = await listLaunches(c); } catch (_) { fails++; continue; }
    for (const l of arr) {
      if (l && l.launchpadId) {
        ids.add(l.launchpadId);
        if (!sample[l.launchpadId]) sample[l.launchpadId] = { tokenAddress: l.tokenAddress, tokenSymbol: l.tokenSymbol, category: c };
      }
    }
  }
  if (fails === categories.length) throw new Error("pools.trade: mọi category đều lỗi khi collectLaunchpadIds");
  return { launchpadIds: [...ids].sort(), sample };
}

module.exports = { trpc, listLaunches, getValidCategories, collectLaunchpadIds, BASE };
