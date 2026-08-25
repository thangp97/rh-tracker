// streamflow.mjs — nhận diện khoá token (lock) qua Streamflow để reply vào thẻ launch gốc.
import { WSOL } from "./dbc.mjs";

// logs của 1 tx là "lock" khi: có "Instruction: Create" VÀ ("SPL token stream" HOẶC "escrow").
export function isLockLogs(logs = []) {
  const blob = logs.join("\n");
  return /Instruction: Create/.test(blob) && /(SPL token stream|escrow)/i.test(blob);
}

// mint bị khoá + số lượng = balance KHÁC WSOL LỚN NHẤT trong postTokenBalances. Trả {mint,amount}|null.
export function lockedMint(tx) {
  const post = tx?.meta?.postTokenBalances || [];
  let best = null;
  for (const b of post) {
    if (b.mint === WSOL) continue;
    const amt = Number(b?.uiTokenAmount?.uiAmount) || 0;
    if (!best || amt > best.amount) best = { mint: b.mint, amount: amt };
  }
  return best;
}
