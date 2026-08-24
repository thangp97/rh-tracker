// poolstrade-onchain.js — Watcher W3: bắt token launch trên pools.trade NGAY TRÊN CHUỖI.
//
// pools.trade (launchpad "uniswap-bonding-curve") phát sự kiện TokenLaunched từ launcher cố định.
// key là Uniswap-v4 PoolKey (currency0, currency1, ...); CẶP GHÉP = currency KHÁC token.
//   - pair = 0x0 (ETH) hoặc USDG  -> token thường
//   - pair ∈ địa chỉ STOCK/INDEX  -> TOKEN TÍCH HỢP INDEX (đây là thứ ta canh)
//
// Dùng lại lib/rpc (nhiều RPC failover) + lib/blockscout (dự phòng khi mọi RPC chết),
// getLogs "thích nghi" (chia đôi khi range lớn) giống track-ws.
const { ethers } = require("ethers");
const { Rpc, parseUrls } = require("./rpc");
const blockscout = require("./blockscout");

// Launcher pools.trade (bonding-curve). Có thể override nếu pools.trade đổi contract.
const LAUNCHER = (process.env.POOLSTRADE_LAUNCHER || "0x23f8209572b4a1C2AD88A42749E830791Fb027f1").toLowerCase();
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 5);
const SPLIT_BUDGET = Number(process.env.LOG_SPLIT_BUDGET || 4000);

const iface = new ethers.Interface([
  "event TokenLaunched(bytes32 indexed poolId, address indexed token, address indexed finalPositionRecipient, (address,address,uint24,int24,address) key)",
]);
const T_LAUNCHED = iface.getEvent("TokenLaunched").topicHash;

const rpc = new Rpc(parseUrls(process.env));
const onRotate = () => {};

function isRangeError(e) {
  const m = String((e && (e.error?.message || e.info?.error?.message || e.shortMessage || e.message)) || "").toLowerCase();
  if (/rate.?limit|compute unit|too many request|throttl|quota|capacity|429/.test(m)) return false;
  return /block range|range is too|out of range|exceed.{0,20}range|10 block range|too many (results|logs)|more than \d+ results|query returned more|result set|response size|max(imum)? results|payload too large|log.{0,20}limit/.test(m);
}
async function splitLogs(filter, from, to, depth, budget) {
  if (++budget.n > SPLIT_BUDGET) throw new Error(`getLogs: vượt ngân sách chia nhỏ ${SPLIT_BUDGET}`);
  try {
    return await rpc.call((p) => p.getLogs({ ...filter, fromBlock: from, toBlock: to }), onRotate);
  } catch (e) {
    if (!isRangeError(e) || to <= from || depth >= 40) throw e;
    const mid = Math.floor((from + to) / 2);
    return (await splitLogs(filter, from, mid, depth + 1, budget)).concat(await splitLogs(filter, mid + 1, to, depth + 1, budget));
  }
}
// getLogs: RPC (failover) -> Blockscout REST khi RPC hỏng hẳn.
async function getLogs(filter, from, to) {
  try { return await splitLogs(filter, from, to, 0, { n: 0 }); }
  catch (e) { return await blockscout.getLogs(filter, from, to); }
}

// tip an toàn (lùi CONFIRMATIONS). RPC -> Blockscout fallback.
async function getSafeTip() {
  let tip;
  try { tip = await rpc.getBlockNumber(onRotate); }
  catch (_) { tip = await blockscout.latestBlock(); }
  return Math.max(0, tip - CONFIRMATIONS);
}

// pair (currency ghép cặp) của 1 launch = currency KHÁC token trong PoolKey.
function pairOf(args) {
  const token = args.token.toLowerCase();
  const c0 = String(args.key[0]).toLowerCase();
  const c1 = String(args.key[1]).toLowerCase();
  return c0 === token ? c1 : c0;
}

// Quét launch pools.trade trong [from,to]. Trả các launch đã chuẩn hoá:
//   {token, pair, poolId, tx, block, index}
async function scanLaunches(from, to) {
  if (to < from) return [];
  const logs = await getLogs({ address: LAUNCHER, topics: [T_LAUNCHED] }, from, to);
  return logs.map((l) => {
    const a = iface.parseLog(l).args;
    return {
      token: a.token,
      pair: pairOf(a),
      poolId: a.poolId,
      tx: l.transactionHash,
      block: l.blockNumber,
      index: l.index,
    };
  });
}

module.exports = { scanLaunches, getSafeTip, pairOf, iface, T_LAUNCHED, LAUNCHER, CONFIRMATIONS, rpc };
