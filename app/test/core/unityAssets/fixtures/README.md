# Unity Asset Test Fixtures

These binary fixtures are sliced from a real TBH game install (v1.00.28) so
unit tests exercise the actual on-disk byte layout.

## Regenerating

```powershell
$root = "D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
$aa = "$root\StreamingAssets\aa\StandaloneWindows64"
$fixtures = "d:\Project\TBH\tbh-companion\app\test\core\unityAssets\fixtures"
New-Item -ItemType Directory -Force -Path $fixtures | Out-Null

# SharedTableData (ItemName_ keys) — ~24KB
Copy-Item "$aa\localization-assets-shared_assets_all.bundle" "$fixtures\shared_assets.bundle"

# EN StringTable (localized strings) — ~45KB
Copy-Item "$aa\localization-string-tables-english(unitedstates)(en-us)_assets_all.bundle" "$fixtures\en_stringtable.bundle"

# Raw SerializedFile with ItemInfoData CSV — ~18MB
Copy-Item "$root\sharedassets0.assets" "$fixtures\sharedassets0.assets"
```

These fixtures are committed (not LFS). The two localization bundles total
~70KB; `sharedassets0.assets` is ~18MB (the full sharedassets0 from the game
install — the catalog extractor reads the ItemInfoData TextAsset directly out
of it). LFS adds friction for contributors, and the large file is stable
across patch versions (only the CSV content changes, not the SerializedFile
layout). If the game's bundle format changes in a future release, regenerate
the fixtures and the corresponding tests.
