// app/src/core/unityAssets/textAsset.ts
// Port of scripts/build_catalog.py:parse_textasset_raw.
// IL2CPP TextAssets have no type tree, so UnityPy's obj.read() doesn't always
// populate m_Text/m_Script. We parse the raw serialization bytes directly:
//   [4B name_len][name bytes][pad to 4][4B script_len][script bytes][pad to 4]

const MAX_NAME_LEN = 256;
const MAX_SCRIPT_LEN = 50_000_000;

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function parseTextAssetRaw(raw: Buffer): [string | null, string | null] {
  if (raw.length < 8) return [null, null];
  const nameLen = raw.readUInt32LE(0);
  if (nameLen > MAX_NAME_LEN || 4 + nameLen > raw.length) return [null, null];
  let name: string;
  try {
    name = raw.subarray(4, 4 + nameLen).toString("utf-8");
  } catch {
    return [null, null];
  }
  const off = align4(4 + nameLen);
  if (off + 4 > raw.length) return [name, null];
  const scriptLen = raw.readUInt32LE(off);
  if (scriptLen > MAX_SCRIPT_LEN || off + 4 + scriptLen > raw.length) return [name, null];
  try {
    const script = raw.subarray(off + 4, off + 4 + scriptLen).toString("utf-8");
    return [name, script];
  } catch {
    return [name, null];
  }
}
