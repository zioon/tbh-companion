// app/src/core/unityAssets/monobehaviourEntries.ts
// Port of scripts/build_catalog.py:scan_marker_entries.
// Scans raw MonoBehaviour bytes for entries of the form:
//   [4B key_id][4B hash][4B marker=14][4B len][string bytes][padding to 4]
// Returns hits in position order. Stops cleanly at end of buffer.

export interface MarkerEntry {
  offset: number;
  keyId: number;
  hash: number;
  len: number;
  str: string;
}

const MAX_LEN = 256;

function isPrintable(s: string): boolean {
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0x80)) return false;
  }
  return true;
}

export function scanMarkerEntries(raw: Buffer, marker = 14): MarkerEntry[] {
  const hits: MarkerEntry[] = [];
  const n = raw.length;
  let i = 0;
  while (i < n - 16) {
    const m = raw.readUInt32LE(i + 8);
    if (m !== marker) {
      i += 1;
      continue;
    }
    const slen = raw.readUInt32LE(i + 12);
    if (slen === 0 || slen > MAX_LEN) {
      i += 1;
      continue;
    }
    const strStart = i + 16;
    const strEnd = strStart + slen;
    if (strEnd > n) {
      i += 1;
      continue;
    }
    let s: string;
    try {
      s = raw.subarray(strStart, strEnd).toString("utf-8");
    } catch {
      i += 1;
      continue;
    }
    if (!isPrintable(s)) {
      i += 1;
      continue;
    }
    const keyId = raw.readUInt32LE(i);
    const hash = raw.readUInt32LE(i + 4);
    hits.push({ offset: i, keyId, hash, len: slen, str: s });
    i = strEnd;
    while (i % 4 !== 0) i += 1;
  }
  return hits;
}
