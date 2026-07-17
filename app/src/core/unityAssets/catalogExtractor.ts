// app/src/core/unityAssets/catalogExtractor.ts
// Port of scripts/build_catalog.py. Extracts gamedata.json content from three
// in-memory buffers: sharedassets0.assets (CSV), shared_assets.bundle
// (ItemName_ keys), en_stringtable.bundle (localized strings).
//
// All three inputs are pure buffers — no node:fs. The main-layer caller is
// responsible for reading the files. This keeps the extractor unit-testable.

import { parseBundle } from "./bundleParser";
import { parseSerializedFile } from "./serializedFile";
import { parseTextAssetRaw } from "./textAsset";
import { scanMarkerEntries } from "./monobehaviourEntries";
import type { GameItem } from "../gamedata";

export interface CatalogExtractorInput {
  sharedassets0: Buffer;
  sharedBundle: Buffer;
  enBundle: Buffer;
}

export interface CatalogExtractionStats {
  csvRows: number;
  resolvedNames: number;
  unresolvedNameKey: number;
  literalNames: number;
  skipped: number;
  nameKeyOnlyAdded: number;
}

export interface ExtractedCatalog {
  gameVersion: string;
  items: GameItem[];
  stats: CatalogExtractionStats;
}

const TYPE_TEXTASSET = 49;
const TYPE_MONOBEHAVIOUR = 114;

function loadNameMap(input: CatalogExtractorInput): Map<string, string> {
  // SharedTableData: smaller MonoBehaviour in sharedBundle.
  const sharedBundle = parseBundle(input.sharedBundle);
  const sharedSf = parseSerializedFile(sharedBundle.data);
  const sharedMonoBehaviours = sharedSf.objects.filter((o) => o.classID === TYPE_MONOBEHAVIOUR);
  const sharedMono = sharedMonoBehaviours
    .map((o) => ({ info: o, raw: sharedSf.getObjectRaw(o, sharedBundle.data) }))
    .sort((a, b) => a.raw.length - b.raw.length)[0];
  if (!sharedMono) throw new Error("no MonoBehaviour in shared_assets bundle");
  const sharedEntries = scanMarkerEntries(sharedMono.raw);

  // EN StringTable: smaller MonoBehaviour in enBundle.
  const enBundle = parseBundle(input.enBundle);
  const enSf = parseSerializedFile(enBundle.data);
  const enMonoBehaviours = enSf.objects.filter((o) => o.classID === TYPE_MONOBEHAVIOUR);
  const enMono = enMonoBehaviours
    .map((o) => ({ info: o, raw: enSf.getObjectRaw(o, enBundle.data) }))
    .sort((a, b) => a.raw.length - b.raw.length)[0];
  if (!enMono) throw new Error("no MonoBehaviour in EN stringtable bundle");
  const enEntries = scanMarkerEntries(enMono.raw);

  // Hash is the linker.
  const sharedByHash = new Map<number, string>();
  for (const e of sharedEntries) sharedByHash.set(e.hash, e.str);
  const enByHash = new Map<number, string>();
  for (const e of enEntries) enByHash.set(e.hash, e.str);

  const nameMap = new Map<string, string>();
  for (const [hash, k] of sharedByHash) {
    const v = enByHash.get(hash);
    if (v === undefined) continue;
    if (k.startsWith("ItemName_")) nameMap.set(k, v);
  }
  return nameMap;
}

function loadCsvText(input: CatalogExtractorInput): string {
  // sharedassets0.assets might be a raw SerializedFile or a UnityFS bundle.
  // Detect by magic bytes.
  let sfData: Buffer;
  if (input.sharedassets0.subarray(0, 7).toString("utf-8") === "UnityFS") {
    const bundle = parseBundle(input.sharedassets0);
    sfData = bundle.data;
  } else {
    sfData = input.sharedassets0;
  }
  let sf;
  try {
    sf = parseSerializedFile(sfData);
  } catch (e) {
    throw new Error(
      `ItemInfoData TextAsset not found in sharedassets0.assets (parse failed: ${e instanceof Error ? e.message : String(e)})`,
      { cause: e },
    );
  }
  for (const obj of sf.objects) {
    if (obj.classID !== TYPE_TEXTASSET) continue;
    const raw = sf.getObjectRaw(obj, sfData);
    const [name, script] = parseTextAssetRaw(raw);
    if (name === "ItemInfoData" && script) return script;
  }
  throw new Error("ItemInfoData TextAsset not found in sharedassets0.assets");
}

function parseBool(s: string | undefined): boolean {
  if (!s) return false;
  return s.trim().toLowerCase() === "true" || s.trim() === "1";
}

const ITEM_KEY_RE = /^\d+$/;

export function extractCatalog(input: CatalogExtractorInput): ExtractedCatalog {
  const nameMap = loadNameMap(input);
  const csvText = loadCsvText(input);

  // Strip BOM, parse CSV.
  const cleanText = csvText.replace(/^\uFEFF/, "");
  const lines = cleanText.split(/\r?\n/);
  if (lines.length < 2) throw new Error("ItemInfoData CSV has no rows");
  const header = lines[0].split(",");
  const rows = lines.slice(1).filter((l) => l.length > 0);

  const colIdx = (name: string): number => {
    const idx = header.findIndex((h) => h.trim() === name || h.trim() === "\uFEFF" + name);
    return idx;
  };
  const iItemKey = colIdx("ItemKey");
  const iNameKey = colIdx("NameKey");
  const iGrade = colIdx("GRADE");
  const iType = colIdx("ITEMTYPE");
  const iLevel = colIdx("Level");
  const iTradable = colIdx("IsCanExchangeMarketable");
  if (iItemKey < 0) throw new Error(`CSV missing ItemKey column; header=${header.join(",")}`);

  const items: GameItem[] = [];
  let resolved = 0;
  let unresolvedNameKey = 0;
  let literalNames = 0;
  let skipped = 0;

  for (const row of rows) {
    const cols = row.split(",");
    const ikStr = (cols[iItemKey] ?? "").trim();
    if (!ITEM_KEY_RE.test(ikStr)) {
      skipped += 1;
      continue;
    }
    const itemKey = parseInt(ikStr, 10);
    const nameKey = (cols[iNameKey] ?? "").trim();
    let name: string;
    if (nameKey.startsWith("ItemName_")) {
      const resolvedName = nameMap.get(nameKey);
      if (resolvedName === undefined) {
        name = nameKey;
        unresolvedNameKey += 1;
      } else {
        name = resolvedName;
        resolved += 1;
      }
    } else if (nameKey) {
      name = nameKey;
      literalNames += 1;
    } else {
      name = `#${itemKey}`;
      unresolvedNameKey += 1;
    }
    const levelStr = (cols[iLevel] ?? "").trim();
    const level = levelStr ? Number(levelStr) : null;
    items.push({
      id: itemKey,
      name,
      grade: (cols[iGrade] ?? "").trim(),
      type: (cols[iType] ?? "").trim(),
      level: Number.isFinite(level as number) ? (level as number) : null,
      marketTradable: parseBool(cols[iTradable]),
    });
  }

  // Add NameKey-only entries (base ids like 620017 in localization but not in CSV).
  const seenIds = new Set(items.map((it) => it.id));
  let nameKeyOnly = 0;
  for (const [nk, name] of nameMap) {
    const m = /^ItemName_(\d+)$/.exec(nk);
    if (!m) continue;
    const baseId = parseInt(m[1], 10);
    if (seenIds.has(baseId)) continue;
    items.push({ id: baseId, name, grade: "", type: "", level: null, marketTradable: false });
    nameKeyOnly += 1;
    seenIds.add(baseId);
  }

  return {
    gameVersion: "1.00.28", // overwritten by caller with the actual running version
    items,
    stats: {
      csvRows: rows.length,
      resolvedNames: resolved,
      unresolvedNameKey,
      literalNames,
      skipped,
      nameKeyOnlyAdded: nameKeyOnly,
    },
  };
}
