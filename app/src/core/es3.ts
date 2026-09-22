// Easy Save 3 (ES3) AES decryption for TBH: Task Bar Hero save files.
//
// Scheme (see docs/SAVE_FORMAT.md):
//   - Layout: [16-byte IV/salt][AES-CBC ciphertext]
//   - Key:    PBKDF2-HMAC-SHA1(password, salt=IV, iterations=100, dklen=16)
//   - Cipher: AES-128-CBC with PKCS7 padding
//   - Plaintext: UTF-8 JSON
//
// Ported from the Python reference (tbh_xp/es3.py).

import crypto from "node:crypto";
import { DEFAULT_PASSWORD, Es3Error } from "./es3Constants";

export { DEFAULT_PASSWORD, Es3Error };

const IV_SIZE = 16;
const PBKDF2_ITERATIONS = 100;
const KEY_LEN = 16; // AES-128

const WRONG_PASSWORD =
  "Decryption failed: wrong password or not a TaskbarHero save. " +
  "The password can change after a game update.";

/** Decrypt raw ES3 bytes and return the plaintext bytes. */
export function decrypt(data: Buffer, password: string = DEFAULT_PASSWORD): Buffer {
  if (!data || data.length <= IV_SIZE) {
    throw new Es3Error("File is too small to be an .es3 save.");
  }

  const iv = data.subarray(0, IV_SIZE);
  const ciphertext = data.subarray(IV_SIZE);

  // A partial block almost always means we caught the game mid-write.
  if (ciphertext.length % 16 !== 0) {
    throw new Es3Error(
      "Ciphertext length is not a multiple of the AES block size (save may be mid-write).",
    );
  }

  const key = crypto.pbkdf2Sync(
    Buffer.from(password, "utf-8"),
    iv,
    PBKDF2_ITERATIONS,
    KEY_LEN,
    "sha1",
  );

  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  // Strip PKCS7 manually so a wrong password yields a clean Es3Error instead of
  // a library-specific "bad decrypt" exception.
  //
  // NOTE: the web build replaces this module with `core/es3Web.ts`, and WebCrypto
  // has no `setAutoPadding(false)` — it always validates and strips the padding
  // itself. So `es3Web` must NOT strip it again (the final plaintext byte is
  // usually `}` = 0x7D, which would be misread as a padding length of 125).
  // The two implementations intentionally differ here; `test/web/es3Parity.test.ts`
  // is what guarantees their final bytes still match.
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (padded.length === 0) {
    throw new Es3Error("Decryption produced no data.");
  }
  const pad = padded[padded.length - 1];
  if (pad < 1 || pad > 16 || pad > padded.length) {
    throw new Es3Error(WRONG_PASSWORD);
  }
  for (let i = padded.length - pad; i < padded.length; i++) {
    if (padded[i] !== pad) {
      throw new Es3Error(WRONG_PASSWORD);
    }
  }
  return padded.subarray(0, padded.length - pad);
}

/** Decrypt raw ES3 bytes and return the plaintext as UTF-8 text. */
export function decryptToText(data: Buffer, password: string = DEFAULT_PASSWORD): string {
  return decrypt(data, password).toString("utf-8");
}
