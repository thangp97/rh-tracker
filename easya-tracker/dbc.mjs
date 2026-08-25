// dbc.mjs — hằng số chương trình + giải mã 1 tx launch EasyA/Kickstart (chạy trên Meteora DBC).
// Mọi ID chương trình đều CÔNG KHAI (nhìn thấy trên Solscan), KHÔNG phải bí mật.

export const DBC_PROGRAM    = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"; // Meteora Dynamic Bonding Curve
export const EASYA_CONFIG   = "DD3y1mi4yeQSLNbNGZTxUwdwbEm4Gh2injjx1N9HPCqQ"; // "danh tính" launchpad EasyA/Kickstart (mentions filter)
export const POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"; // PDA pool authority (accounts[1])
export const METADATA_PROG  = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"; // mpl-token-metadata
export const TOKEN_PROG     = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // SPL Token
export const TOKEN2022_PROG = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // Token-2022
export const WSOL           = "So11111111111111111111111111111111111111112";
export const STREAMFLOW     = "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m"; // program khoá token (lock)

// Phụ trợ (chỉ để tham chiếu/đối chiếu thêm — không bắt buộc):
export const EASYA_MEMO     = "easya-kickstart";                              // memo trong tx launch EasyA
export const EASYA_COSIGNER = "HtrbuJZV5K6FTbrMCxuWXoeEC1V5NwsqiToXtqtZVtxQ"; // ví co-signer của EasyA

// Marker trong logs để CHỈ giữ sự kiện launch (bỏ swap và spam khác).
export const LAUNCH_MARKERS = ["InitializeVirtualPoolWithSplToken", "InitializeVirtualPoolWithToken2022"];

// ---- base58 decode (không phụ thuộc thư viện) ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58MAP = (() => { const m = {}; for (let i = 0; i < B58.length; i++) m[B58[i]] = i; return m; })();
export function base58Decode(str) {
  const bytes = [];
  for (const ch of str) {
    let carry = B58MAP[ch];
    if (carry === undefined) throw new Error("ký tự base58 không hợp lệ: " + ch);
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0); // byte 0 dẫn đầu ('1' trong base58)
  return Uint8Array.from(bytes.reverse());
}

// ---- Borsh: đọc name/symbol/uri từ data của CreateMetadataAccountV3 (mpl-token-metadata) ----
// byte đầu === 33 (mã CreateMetadataAccountV3); sau đó mỗi field = u32 LE (độ dài) + utf8.
export function parseMetadataBytes(d) {
  if (!d || d[0] !== 33) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let off = 1;
  const readStr = () => {
    const len = dv.getUint32(off, true); off += 4;
    const s = new TextDecoder().decode(d.subarray(off, off + len)); off += len;
    return s.replace(/\0+$/, "").trim();
  };
  const name = readStr(), symbol = readStr(), uri = readStr();
  return { name, symbol, uri };
}

// Gom instruction top-level + inner (CPI) thành 1 mảng phẳng.
function allInstructions(tx) {
  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((x) => x.instructions || []);
  return [...top, ...inner];
}
const pid = (ix) => (ix?.programId?.toBase58 ? ix.programId.toBase58() : String(ix?.programId || ""));
const acc = (a) => (a?.toBase58 ? a.toBase58() : String(a));

// Tính SOL dev bỏ ra + token dev giữ + % supply từ postTokenBalances.
export function computeBuy(post, mint, creator) {
  const num = (b) => Number(b?.uiTokenAmount?.uiAmount) || 0;
  const wsol = post.filter((b) => b.mint === WSOL).map(num);
  const buySol = wsol.length ? Math.max(0, ...wsol) : 0;               // vault WSOL của pool = SOL dev đã tiêu (0 = không mua)
  const devTokens = num(post.find((b) => b.mint === mint && b.owner === creator));
  const totalSupply = post.filter((b) => b.mint === mint).reduce((s, b) => s + num(b), 0); // ≈ 1e9
  const pctSupply = totalSupply ? (devTokens / totalSupply) * 100 : null;
  return { buySol, devTokens, totalSupply, pctSupply };
}

// Giải mã 1 parsed-tx thành thông tin launch, hoặc null nếu không phải launch DBC.
export function parseLaunch(tx) {
  if (!tx || !tx.meta) return null;
  const ixs = allInstructions(tx);

  // 1) instruction DBC InitializeVirtualPool: programId===DBC & accounts.length>5.
  //    Thứ tự account (đã kiểm chứng on-chain):
  //    [0]=config [1]=pool_authority [2]=creator(dev) [3]=base_mint [4]=quote_mint [5]=pool
  const dbcIx = ixs.find((ix) => pid(ix) === DBC_PROGRAM && Array.isArray(ix.accounts) && ix.accounts.length > 5);
  if (!dbcIx) return null;
  const creator = acc(dbcIx.accounts[2]);
  const mint = acc(dbcIx.accounts[3]);
  const pool = acc(dbcIx.accounts[5]);

  // 2) name/symbol/uri từ CreateMetadataAccountV3 (mpl-token-metadata, thường là inner CPI).
  let meta = null;
  for (const ix of ixs) {
    if (pid(ix) !== METADATA_PROG || typeof ix.data !== "string") continue;
    try { const m = parseMetadataBytes(base58Decode(ix.data)); if (m) { meta = m; break; } } catch (_) {}
  }

  const post = tx.meta.postTokenBalances || [];
  const { buySol, devTokens, totalSupply, pctSupply } = computeBuy(post, mint, creator);

  return {
    mint, creator, pool,
    name: meta?.name || null,
    symbol: meta?.symbol || null,
    uri: meta?.uri || null,
    buySol, devTokens, totalSupply, pctSupply,
  };
}
