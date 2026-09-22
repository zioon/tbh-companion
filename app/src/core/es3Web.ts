// Easy Save 3 (ES3) AES decryption — WebCrypto implementation for the browser.
//
// Byte-for-byte equivalent of `core/es3.ts` (which uses `node:crypto`):
//   - Layout: [16-byte IV/salt][AES-CBC ciphertext]
//   - Key:    PBKDF2-HMAC-SHA1(password, salt=IV, iterations=100, dklen=16)
//   - Cipher: AES-128-CBC with PKCS7 padding
//   - Plaintext: UTF-8 JSON
//
// Kept as a separate module rather than a runtime branch inside `es3.ts` so the
// desktop decrypt path stays exactly as shipped; the web bundle aliases
// `core/es3` to this file at build time.
//
// WebCrypto has no synchronous API, so `decrypt`/`decryptToText` return
// promises. Unlike `es3.ts`, WebCrypto's AES-CBC does NOT expose a "no
// auto-padding" mode: it always validates and strips PKCS7 padding, throwing an
// OperationError when the padding is invalid. A wrong password therefore fails
// one step earlier than on desktop, and the plaintext is returned already
// unpadded.

export { DEFAULT_PASSWORD, Es3Error } from "./es3Constants";

import { DEFAULT_PASSWORD, Es3Error } from "./es3Constants";

const IV_SIZE = 16;
const PBKDF2_ITERATIONS = 100;
const KEY_LEN = 16; // AES-128

const WRONG_PASSWORD =
  "Decryption failed: wrong password or not a TaskbarHero save. " +
  "The password can change after a game update.";

function bytesOf(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Copy a view's bytes into a standalone ArrayBuffer.
 *
 *  Two hazards this avoids:
 *   1. `subarray()` views carry a non-zero `byteOffset` and a `byteLength`
 *      shorter than their backing ArrayBuffer; WebCrypto then sees the wrong
 *      length (e.g. "iv must contain exactly 16 bytes").
 *   2. `view.slice().buffer` is NOT a safe way to copy. When the view is a Node
 *      `Buffer` (what `node:fs` and Electron IPC hand back), `Buffer.prototype
 *      .slice` returns another *view over the same allocation* rather than a
 *      copy, so `.buffer` still points at the original multi-hundred-KB
 *      ArrayBuffer — `slice()` only resets `byteOffset`. WebCrypto then derives
 *      from a completely wrong salt and every decrypt fails with a bogus
 *      "wrong password".
 *
 *  `new Uint8Array(view)` is safe: the TypedArray constructor copies
 *  element-wise and is not affected by `Buffer`'s `slice` override. */
function toOwnedBuffer(view: Uint8Array): ArrayBuffer {
  return new Uint8Array(view).buffer;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: toOwnedBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-1",
    },
    baseKey,
    KEY_LEN * 8,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-CBC" }, false, ["decrypt"]);
}

/** Decrypt raw ES3 bytes and return the plaintext bytes. */
export async function decrypt(
  data: Uint8Array | ArrayBuffer,
  password: string = DEFAULT_PASSWORD,
): Promise<Uint8Array> {
  const bytes = bytesOf(data);
  if (!bytes || bytes.length <= IV_SIZE) {
    throw new Es3Error("File is too small to be an .es3 save.");
  }

  const iv = bytes.subarray(0, IV_SIZE);
  const ciphertext = bytes.subarray(IV_SIZE);

  // A partial block almost always means we caught the game mid-write.
  if (ciphertext.length % 16 !== 0) {
    throw new Es3Error(
      "Ciphertext length is not a multiple of the AES block size (save may be mid-write).",
    );
  }

  const key = await deriveKey(password, iv);

  // WebCrypto's AES-CBC verifies and strips PKCS7 padding itself, so a wrong
  // password surfaces here as a thrown OperationError. That is the *opposite* of
  // `es3.ts`, which turns auto-padding off and strips it by hand — do NOT strip
  // again below, or valid saves fail with a bogus "wrong password" because the
  // last plaintext byte (usually `}` = 0x7D) gets read as a padding length.
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: toOwnedBuffer(iv) },
        key,
        toOwnedBuffer(ciphertext),
      ),
    );
  } catch {
    throw new Es3Error(WRONG_PASSWORD);
  }

  if (plaintext.length === 0) {
    throw new Es3Error("Decryption produced no data.");
  }
  return plaintext;
}

/** Decrypt raw ES3 bytes and return the plaintext as UTF-8 text. */
export async function decryptToText(
  data: Uint8Array | ArrayBuffer,
  password: string = DEFAULT_PASSWORD,
): Promise<string> {
  return new TextDecoder("utf-8").decode(await decrypt(data, password));
}
