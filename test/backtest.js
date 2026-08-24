// backtest.js — Kiểm chứng Cách B (REST getLogs) trên dữ liệu quá khứ đã biết đáp án.
// Chạy: node backtest.js
// Node >= 18 (có fetch sẵn).

const BASE = "https://robinhoodchain.blockscout.com";
const WALLET = "0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49";
const T0 = "0xf5e62f18207578ca90c9d19a15c6405c9b3b401917ba0ad7a443bc76dcdadb2d"; // AdapterDeployed
const creatorTopic = "0x" + "0".repeat(24) + WALLET.toLowerCase().slice(2);     // topic2 = creator

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch JSON có backoff cho rate-limit (HTTP 429)
async function api(url, tries = 8) {
  let lastMsg = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { lastMsg = "429"; await sleep(3000 * (i + 1)); continue; }
      const j = await r.json();
      return j;
    } catch (e) { lastMsg = String(e); }
    await sleep(1500 * (i + 1));
  }
  throw new Error("API failed (" + lastMsg + "): " + url);
}

// Phát hiện adapter mới do WALLET deploy trong khoảng block
async function detect(from, to, creator = creatorTopic) {
  const url = `${BASE}/api?module=logs&action=getLogs` +
    `&fromBlock=${from}&toBlock=${to}&topic0=${T0}&topic2=${creator}&topic0_2_opr=and`;
  const j = await api(url);
  if (j.status !== "1") {
    if (/No (logs|records) found/i.test(j.message || "")) return [];
    throw new Error("getLogs status=" + j.status + " msg=" + j.message);
  }
  return (j.result || []).map((l) => ({
    adapter: "0x" + l.topics[1].slice(26),
    router: "0x" + l.topics[3].slice(26),
    block: parseInt(l.blockNumber, 16),
    tx: l.transactionHash,
  }));
}

// Lấy địa chỉ token đã launch từ 1 adapter:
// token đầu tiên mà adapter đụng tới (dev-buy lúc launch) chính là token launch.
async function extractToken(adapter, startBlock) {
  const url = `${BASE}/api?module=account&action=tokentx` +
    `&address=${adapter}&startblock=${startBlock}&endblock=${startBlock + 500}&sort=asc`;
  const j = await api(url);
  if (j.status !== "1" || !Array.isArray(j.result) || j.result.length === 0) return null;
  const first = j.result[0];
  return { token: first.contractAddress, symbol: first.tokenSymbol, launchTx: first.hash };
}

const CASES = [
  {
    name: "POWERBALL",
    from: 34246000, to: 34246500,
    adapter: "0xe1fe0d5b2c2d39ab4cd716ca9966b05f8ca8241a",
    token: "0xb7ead5209ca970ad6326fa38ea10724fc6b8d3b9",
  },
  {
    name: "BANDS",
    from: 37236900, to: 37237400,
    adapter: "0x1ee88067828efb8175a3003ce01382974cf0f921",
    token: "0xf46c6e1144bb34b4d71142a2c6e201742395fcae",
  },
];

(async () => {
  console.log("=== BACKTEST CÁCH B (REST getLogs) ===");
  console.log("Ví theo dõi:", WALLET, "\n");
  let pass = 0, total = 0;

  // --- Test dương: phát hiện + giải mã token ---
  for (const c of CASES) {
    total += 2;
    let found = [];
    try { found = await detect(c.from, c.to); }
    catch (e) { console.log(`❌ ${c.name} detect lỗi: ${e.message}`); continue; }

    const hit = found.find((f) => f.adapter.toLowerCase() === c.adapter);
    if (hit) { pass++; console.log(`✅ PASS  ${c.name} detect adapter=${hit.adapter} (block ${hit.block}, tx ${hit.tx})`); }
    else     { console.log(`❌ FAIL  ${c.name} detect -> ${JSON.stringify(found)}`); }

    await sleep(1500);
    if (hit) {
      let tok = null;
      try { tok = await extractToken(hit.adapter, hit.block); }
      catch (e) { console.log(`   extractToken lỗi: ${e.message}`); }
      if (tok && tok.token.toLowerCase() === c.token) {
        pass++; console.log(`✅ PASS  ${c.name} token=${tok.token} (${tok.symbol})`);
      } else {
        console.log(`❌ FAIL  ${c.name} token -> ${JSON.stringify(tok)}  (kỳ vọng ${c.token})`);
      }
    }
    await sleep(1500);
  }

  // --- Test âm: creator sai phải ra 0 log ---
  total += 1;
  const wrong = "0x" + "0".repeat(24) + "3afced430483023fa308a3c1ebc79848e446495d"; // keeper
  try {
    const neg = await detect(34246000, 34246500, wrong);
    if (neg.length === 0) { pass++; console.log(`✅ PASS  Negative (creator sai) -> 0 log`); }
    else { console.log(`❌ FAIL  Negative -> ${neg.length} log (kỳ vọng 0)`); }
  } catch (e) { console.log(`❌ Negative lỗi: ${e.message}`); }

  console.log(`\nKẾT QUẢ: ${pass}/${total} bài đạt.`);
  process.exit(pass === total ? 0 : 1);
})();
