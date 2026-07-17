# Unity Asset Test Fixtures

These binary fixtures are sliced from a real TBH game install (v1.00.28) so
unit tests exercise the actual on-disk byte layout.

## Regenerating

```powershell
$root = "D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
$fixtures = "d:\Project\TBH\tbh-companion\app\test\core\unityAssets\fixtures"
New-Item -ItemType Directory -Force -Path $fixtures | Out-Null
Copy-Item "$root\StreamingAssets\aa\StandaloneWindows64\localization-assets-shared_assets_all.bundle" "$fixtures\shared_assets.bundle"
```

These fixtures are committed (not LFS) because they total ~25KB and LFS adds
friction for contributors. If the game's bundle format changes in a future
release, regenerate the fixtures and the corresponding tests.
