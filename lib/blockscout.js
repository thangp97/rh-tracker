// blockscout.js — NGUỒN LOG DỰ PHÒNG độc lập qua REST Blockscout (không cần RPC node,
// không cần API key). Dùng khi mọi RPC chết để tracker không bị "mù".
//
// Trả về log ĐÃ CHUẨN HOÁ về đúng shape ethers-log (topics/data/transactionHash/
// blockNumber/index) => iface.parseLog() và key(tx:index) của track-ws dùng lại được,
// nhờ vậy vòng quét KHÔNG phải viết lại.
const BASE = process.env.BLOCKSCOUT_BASE || "https://robinhoodchain.blockscout.com";
const BS_CHUNK = Number(process.env.BLOCKSCOUT_CHUNK || 50000); // chia nhỏ range cho REST
const BS_CAP = Number(process.env.BLOCKSCOUT_CAP || 1000); // Blockscout cắt ~1000 log/lần (IM LẶNG) -> chạm cap thì chia đôi
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch JSON có backoff cho 429; NÉM lỗi nếu thất bại hẳn (để caller biết Blockscout cũng chết).
async function api(url, tries = 5) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { last = "429"; await sleep(2000 * (i + 1)); continue; }
      if (r.ok) return await r.json();
      last = "HTTP " + r.status;
    } catch (e) { last = e.message; }
    await sleep(1000 * (i + 1));
  }
  throw new Error("Blockscout không phản hồi (" + last + ")");
}

// block mới nhất theo Blockscout (dùng cho probe /health hoặc failover getBlockNumber)
async function latestBlock() {
  const j = await api(`${BASE}/api/v2/blocks?type=block`);
  const h = j?.items?.[0]?.height;
  if (h == null) throw new Error("Blockscout: không đọc được block mới nhất");
  return h;
}

// dịch filter kiểu ethers {address, topics:[t0,t1,t2,t3]} -> tham số getLogs của Blockscout.
// Các topic có mặt (khác null) được nối bằng AND (topicA_B_opr=and) đúng như Blockscout yêu cầu.
function toParams(filter) {
  const p = new URLSearchParams({ module: "logs", action: "getLogs" });
  if (filter.address) p.set("address", filter.address);
  const topics = filter.topics || [];
  const present = [];
  topics.forEach((t, i) => { if (t != null) { p.set("topic" + i, t); present.push(i); } });
  for (let a = 0; a < present.length; a++)
    for (let b = a + 1; b < present.length; b++)
      p.set(`topic${present[a]}_${present[b]}_opr`, "and");
  return p;
}

// parse số an toàn cả hex ("0x24") lẫn thập phân ("36") -> không lệch khoá dedup tx:index
function num(v) {
  const s = String(v);
  return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}

// chuẩn hoá 1 log REST -> shape ethers-log (đủ cho iface.parseLog + key = tx:index)
function normalize(l) {
  return {
    address: l.address,
    topics: (l.topics || []).filter((t) => t != null),
    data: l.data,
    transactionHash: l.transactionHash,
    blockNumber: num(l.blockNumber),
    index: num(l.logIndex),
  };
}

// 1 chunk [from,to]: nếu chạm cap (~1000 log, Blockscout cắt IM LẶNG) -> chia đôi lấy đủ.
async function getChunk(filter, from, to, depth = 0) {
  const p = toParams(filter);
  p.set("fromBlock", String(from));
  p.set("toBlock", String(to));
  const j = await api(`${BASE}/api?${p.toString()}`);
  if (j.status !== "1") {
    if (/No (logs|records) found/i.test(j.message || "")) return []; // rỗng
    throw new Error("Blockscout getLogs: " + (j.message || "status " + j.status));
  }
  const rows = j.result || [];
  if (rows.length >= BS_CAP && to > from && depth < 40) { // có thể bị cắt -> chia đôi
    const mid = Math.floor((from + to) / 2);
    const left = await getChunk(filter, from, mid, depth + 1);
    const right = await getChunk(filter, mid + 1, to, depth + 1);
    return left.concat(right);
  }
  return rows.map(normalize);
}

// getLogs qua Blockscout REST cho [from,to] (chia theo BS_CHUNK + tự chia đôi khi chạm cap).
// NÉM lỗi nếu Blockscout không phản hồi (để caller đếm lỗi + cảnh báo 🔴).
async function getLogs(filter, from, to) {
  const out = [];
  for (let start = from; start <= to; start += BS_CHUNK) {
    out.push(...await getChunk(filter, start, Math.min(start + BS_CHUNK - 1, to)));
  }
  return out;
}

module.exports = { getLogs, latestBlock, toParams, normalize, BASE };
