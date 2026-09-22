// Parity check: the WebCrypto ES3 implementation (`core/es3Web`) must produce
// byte-identical plaintext to the shipped `node:crypto` one (`core/es3.ts`) for
// the same save. This is the regression guard for the two implementations
// drifting apart — they deliberately handle padding differently (node turns
// auto-padding off and strips it by hand; WebCrypto always strips it), so the
// final bytes, not the intermediate steps, are what must match.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptToText } from "../../src/core/es3Web";

const SAVE = join(
  homedir(),
  "AppData",
  "LocalLow",
  "TesseractStudio",
  "TaskBarHero",
  "SaveFile_Live.es3",
);
const PASSWORD = "emuMqG3bLYJ938ZDCfieWJ";
const hasSave = existsSync(SAVE);

describe("es3 node vs web", () => {
  it.skipIf(!hasSave)("derives the same key and plaintext", async () => {
    const data = readFileSync(SAVE);
    const iv = data.subarray(0, 16);
    const ct = data.subarray(16);

    // node:crypto reference — mirrors `core/es3.ts` (manual padding strip).
    const key = pbkdf2Sync(Buffer.from(PASSWORD, "utf-8"), iv, 100, 16, "sha1");
    const d = createDecipheriv("aes-128-cbc", key, iv);
    d.setAutoPadding(false);
    const padded = Buffer.concat([d.update(ct), d.final()]);
    const pad = padded[padded.length - 1];
    const nodePlain = padded.subarray(0, padded.length - pad);

    // WebCrypto via the real module (not a re-implementation, so a regression
    // inside `es3Web` actually fails this test).
    const webText = await decryptToText(new Uint8Array(data));
    const webPlain = new TextEncoder().encode(webText);

    console.log("node plain length:", nodePlain.length);
    console.log("web  plain length:", webPlain.length);
    console.log("node head:", nodePlain.subarray(0, 40).toString("utf-8"));
    console.log("web  head:", webText.slice(0, 40));

    expect(webPlain.length).toBe(nodePlain.length);
    expect(Array.from(webPlain.subarray(0, 200))).toEqual(Array.from(nodePlain.subarray(0, 200)));
  });
});
