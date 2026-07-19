// CodeStage Anti-Cheat (ACTk) ObscuredLong decode — pure, unit-testable.
// Layout: hash +0x0, hiddenValue +0x8, currentCryptoKey +0x10, fakeValue +0x18 (32 bytes total).

import { plausibleGold } from "./offsets";

/** ACTk ObscuredLong decrypt (GameAssembly xsx/xsp): (hidden - crypto) ^ crypto. */
function actkDecryptLong(hidden: bigint, crypto: bigint): bigint {
  return (hidden - crypto) ^ crypto;
}

/** A decoded gold value must be a positive safe integer (reject zeroed/garbage reads). */
function plausibleDecodedGold(v: number): boolean {
  return Number.isSafeInteger(v) && v > 0 && plausibleGold(v);
}

/**
 * Decode a value from an ObscuredLong field. Tries the decrypted value, then the
 * fake shadow, then a raw XOR — returning the first plausible positive integer, or
 * null when the buffer is too short or every candidate is garbage (mid key-rotation).
 */
export function decodeObscuredLong(buf: Buffer | Uint8Array, off = 0): number | null {
  if (buf.length < off + 0x20) return null;
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  const hidden = view.readBigInt64LE(off + 8);
  const cryptoKey = view.readBigInt64LE(off + 0x10);
  const fake = view.readBigInt64LE(off + 0x18);
  const decrypted = actkDecryptLong(hidden, cryptoKey);

  for (const candidate of [decrypted, fake, hidden ^ cryptoKey]) {
    if (candidate <= 0n || candidate > 9007199254740991n) continue;
    const v = Number(candidate);
    if (plausibleDecodedGold(v)) return v;
  }
  return null;
}

/**
 * ACTk ObscuredInt decode — 8-byte struct: int32 hiddenValue + int32 currentCryptoKey.
 *
 * Used by BoxOpenLog fields on v1.00.28+ where the obfuscator renamed the fields
 * (e.g. `itemStringKey` → `bfne`) AND changed their type from plain int32 to
 * ObscuredInt. Decrypt formula is the same as ObscuredLong:
 * `(hidden - crypto) ^ crypto`, but with 32-bit operands.
 *
 * Returns the decoded int32 value, or null when the buffer is too short.
 * Returns 0 when both hidden and cryptoKey are 0 (uninitialized / value is 0).
 */
export function decodeObscuredInt(buf: Buffer | Uint8Array, off = 0): number | null {
  if (buf.length < off + 8) return null;
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  const hidden = BigInt(view.readInt32LE(off));
  const cryptoKey = BigInt(view.readInt32LE(off + 4));
  if (hidden === 0n && cryptoKey === 0n) return 0;
  const decrypted = actkDecryptLong(hidden, cryptoKey);
  // ObscuredInt decrypts to a 32-bit range; reject anything outside int32.
  if (decrypted < -2147483648n || decrypted > 2147483647n) return null;
  return Number(decrypted);
}
