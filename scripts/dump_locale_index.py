#!/usr/bin/env python3
"""Dump game's Locale metadata: idx -> LocaleCode mapping.

Reads `localization-locales_assets_all.bundle` (Unity Localization package's
Locale metadata asset) and prints the idx field of each Locale MonoBehaviour,
ordered by idx.

The game's `tbh_lang_idx` Windows registry value (REG_DWORD) selects the
active language; this script reveals which idx maps to which Locale code so
`GAME_LANG_IDX_TO_RESOLVED` in `app/shared/language.ts` can stay in sync.

Investigation result (2026-07-19, game v1.00.28): the idx field is stored as
`m_SortOrder` (int32) on the Locale MonoBehaviour, alongside `m_Identifier.m_Code`
(the BCP-47 code) and `m_Name` (human-readable label).

Output (stderr): human-readable table.
Output (stdout): JSON `{ "idx": "code", ... }` for programmatic use.
"""
import json
import sys
from pathlib import Path
import UnityPy

GAME_DIR = Path(
    r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data\StreamingAssets\aa\StandaloneWindows64"
)
LOCALES_BUNDLE = "localization-locales_assets_all.bundle"


def main() -> None:
    bundle_path = GAME_DIR / LOCALES_BUNDLE
    if not bundle_path.exists():
        print(f"ERROR: {bundle_path} not found", file=sys.stderr)
        sys.exit(1)

    env = UnityPy.load(str(bundle_path))
    locales: list[dict] = []
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception as e:
            print(f"WARN: failed to read_typetree on {obj.path_id}: {e}", file=sys.stderr)
            continue

        # Unity Localization Locale MonoBehaviour fields:
        # - m_Name: human-readable label (e.g. "English (United States)")
        # - m_Identifier.m_Code: BCP-47 code (e.g. "en-US")
        # - m_SortOrder: int32 used by the game as the language idx
        #                 (matches the registry `tbh_lang_idx` value)
        identifier = tree.get("m_Identifier") or {}
        code = identifier.get("m_Code") if isinstance(identifier, dict) else None
        name = tree.get("m_Name")
        sort_order = tree.get("m_SortOrder")
        if code is None or sort_order is None:
            continue
        locales.append(
            {
                "idx": int(sort_order),
                "code": str(code),
                "name": str(name) if name else "",
            }
        )

    locales.sort(key=lambda x: x["idx"])
    print(f"Found {len(locales)} Locale entries:\n", file=sys.stderr)
    for loc in locales:
        print(
            f"  idx={loc['idx']:>3}  code={loc['code']:<12}  name={loc['name']}",
            file=sys.stderr,
        )

    out = {str(loc["idx"]): loc["code"] for loc in locales}
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
