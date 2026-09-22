# Save format - TBH: Task Bar Hero

This is the hard-won, reverse-engineered knowledge about the save file. If
decryption or parsing breaks after a game update, start here.

## File location

```
%USERPROFILE%\AppData\LocalLow\TesseractStudio\TaskbarHero\SaveFile_Live.es3
```

The game writes this file periodically (every ~1-2 minutes while playing), not
on every XP tick. All rate math is therefore keyed off the file's modification
time (`mtime`), not poll time - see `tracker`.

## Encryption (Easy Save 3 / ES3)

The save is an ES3-encrypted blob:

- **Layout:** `[16-byte IV/salt][AES-CBC ciphertext]`
- **Key derivation:** PBKDF2-HMAC-**SHA1**, password + salt=IV, **100**
  iterations, 16-byte key (AES-128).
- **Cipher:** AES-128-**CBC**, PKCS7 padding.
- **Plaintext:** UTF-8 JSON.

### Password

```
emuMqG3bLYJ938ZDCfieWJ
```

This is the ES3 password baked into TBH builds. It is **not secret** - it is
published in the community Save Inspector's client-side JS
(https://taskbarhero.wiki/save-inspector). The developer can rotate it in a
patch; if decryption starts failing, the status line reads "wrong password or
not a TaskbarHero save" and the password in `config.json` (`es3Password`) must
be updated. The wiki inspector usually tracks the current value.

### Node implementation note

Port target is Node's built-in `crypto` (no native deps):

```ts
const iv = buf.subarray(0, 16);
const ct = buf.subarray(16);                       // length must be % 16 === 0
const key = crypto.pbkdf2Sync(password, iv, 100, 16, "sha1");
const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
d.setAutoPadding(false);                            // strip PKCS7 manually so a
let out = Buffer.concat([d.update(ct), d.final()]); // wrong password -> clean error
```

A ciphertext length that is not a multiple of 16 almost always means the game
was caught mid-write - treat as a transient error and retry.

## Decrypted JSON layout (relevant parts)

Top level is an ES3 object map. Each entry is wrapped as
`{ "__type": ..., "value": <data> }`, and `value` is frequently itself a JSON
**string** that must be parsed again (see `_unwrap_es3_entry`).

```
PlayerSaveData.value (nested JSON string) ->
  heroSaveDatas: [ { heroKey, HeroLevel, HeroExp, IsUnLock, ... }, ... ]
  cubeSaveLevelData: { Level, Exp }
  currenySaveDatas: [ { Key, Quantity }, ... ]   # note: game's spelling
  commonSaveData: { playTime, currentStageKey, currentStageWave,
                    maxCompletedStage, ... }
  inventorySaveDatas / stashSaveDatas / tradingStashSaveDatas:
      [ { Index, ItemUniqueId, IsUnlock|IsUnLock, Quantity }, ... ]  # slots, ref items by id
                                                                     # Quantity = per-slot stack size
                                                                     # (materials stack up to 5/slot)
  itemSaveDatas: [ { ItemKey, UniqueId, PrevUniqueId, IsChaotic, IsBlocked,
                     IsServerPendingItem, EnchantCount[3], EnchantData[6], ... },
                   ... ]                            # master list of instances
                                                   # (field order: see note below)
  BoxData: { BoxTypes[], BoxUniqueId[], BoxQuantity[] }  # held (unopened) chests (removed in v1.2.2)
  BoxBucketGetBoxList: string[]   # v1.2.2+: UniqueIds of UNOPENED chests (into itemSaveDatas)
  BoxBucketUseBoxList: string[]   # v1.2.2+: UniqueIds of already-opened chests
  aggregateSaveDatas: [ { Type, SubKey, Value }, ... ]   # lifetime counters
  PetSaveData: [ { PetKey, IsUnlock, IsViewed }, ... ]   # companion unlock state
```

`commonSaveData` also includes **`ArrangedPetKey`** — the cosmetic pet shown in
formation (passives apply whether equipped or not).

### Key facts

- **Gold** is currency `Key == 100001` in `currenySaveDatas` (`Quantity`).
  Gold is spent as well as earned, so only positive deltas are counted ("gold
  earned").
- **Hero XP** (`HeroExp`) resets on level-up, so it is not monotonic. Gains are
  accumulated from positive deltas only; a drop is treated as a reset.
- **Stage keys** are 4-digit `Difficulty|Act|Stage` (e.g. `3205` = Hell 2-5).
  Difficulties: `1 Normal, 2 Nightmare, 3 Hell, 4 Torment`. See `stages`.
- **Hero keys** -> names: `101 Knight, 201 Ranger, 301 Sorcerer, 401 Priest,
  501 Hunter, 601 Slayer`.

## Items (for the inventory/market features)

- **`itemSaveDatas` is the master list of every owned item instance** -
  inventory + stash + trading + equipped. Verified: all non-empty
  `inventorySaveDatas`/`stashSaveDatas`/`tradingStashSaveDatas` slot
  `ItemUniqueId` refs resolve into it. The slot arrays are mostly capacity
  (`IsUnlock` flags) and only say *where* an instance sits.
- The inventory feature reads `itemSaveDatas` directly and groups by `ItemKey`.
  It does **not** join slots to instances by `UniqueId`.
- **Field order is not guaranteed.** Game v1.00.28+ inserts `PrevUniqueId`,
  `IsBlocked`, `IsServerPendingItem` between `UniqueId` and `IsChaotic`. The
  parser (`core/inventory/parse.ts:parseItemsFromPlayerString`) splits each
  top-level `{...}` object by brace depth and extracts `ItemKey` / `UniqueId` /
  `IsChaotic` independently, so future field insertions do not silently empty
  the inventory tab. Do **not** reintroduce a "three adjacent fields" regex.
- **`UniqueId` precision warning:** `UniqueId` / `ItemUniqueId` (e.g.
  `514119247889201000`) exceed `Number.MAX_SAFE_INTEGER`. `JSON.parse` rounds
  them, so distinct ids can collide (~6/185 observed). Any future slot->instance
  join must parse these as strings/bigints losslessly (the numeric form is
  unsafe).
- **Material stack counts (per-slot `Quantity`).** Materials stack inside one bag
  slot, up to **5 per slot**. The per-slot size lives on the **slot objects**
  (`inventorySaveDatas` / `stashSaveDatas` / `remakeTradingStashSaveDatas`) as a
  `Quantity` field — **not** on `itemSaveDatas` (verified on a live save: the
  `itemSaveDatas` field union contains no quantity field at all). Multiple slots
  may reference the same material by `ItemUniqueId`; the **total owned quantity is
  the sum of every non-empty slot's `Quantity`** (e.g. 7 = 5 + 2). Empty slots
  (`ItemUniqueId === "0"`) and `Quantity <= 0` are ignored. A stacked slot still
  counts as **one** used bag slot.
  - **Slot occupancy (`used`) is dual-criterion.** `capacity` counts only
    `IsUnlock === true` slots. For `used`: if **any** slot on the array carries a
    `Quantity` field (new format), a slot counts as used iff `Quantity > 0`; if
    **no** slot carries `Quantity` at all (old save), it falls back to
    `ItemUniqueId !== "0"`. The game also zeroes empty slots' `ItemUniqueId`, so on
    new saves both criteria agree (measured: 3/140 either way, no `UID≠0 ∧
    Quantity=0` slot) — but the fallback is required so a pre-stacking save does not
    collapse `used` to 0 (measured old save: `UID≠0` = 104/176, `Quantity>0` = 0/0).
  - **`itemSaveDatas` material rows are stack templates, not per-instance rows:**
    the same `ItemKey`/`UniqueId` can repeat many times (observed a single id
    repeated 24×) — one template per holding slot. Counting those rows would
    inflate the total; the slot sum is authoritative.
  - Parser: `core/inventory/stacks.ts` (`materialStacksFromSlots`,
    `MAX_STACK_PER_SLOT`), wired via `parseInventory`. The lifetime
    `aggregateSaveDatas` path is a **fallback only**, used when slots lack
    `Quantity` (old save / field removed).
- `ItemKey` itself is small and safe; it equals the `id` in the bundled catalogs
  (`data/gamedata.json` for GEAR/MATERIAL, `data/stage_boxes.json` for STAGEBOX).
- **`BoxData`** holds *unopened* chests as three parallel arrays
  (`BoxTypes[i]`, `BoxQuantity[i]`). Opened stage-box instances also appear in
  `itemSaveDatas` at `910xxx` / `920xxx` / `930xxx` ItemKeys (see
  `docs/findings/item-mapping.md`).
  **v1.2.2 removed `BoxData`**: unopened chests are ordinary STAGEBOX entries in
  `itemSaveDatas` whose `UniqueId` is listed in `BoxBucketGetBoxList`
  (`BoxBucketUseBoxList` = already opened). Classify by `ItemKey` → gamedata
  name prefix (`Normal Monster Box*`→common, `Stage Boss Box*`→rare,
  `Act Boss Box*`→act). Parser: `core/inventory/parse.ts:parseChests`
  (string-exact `UniqueId` match per the precision warning above). History:
  `docs/findings/v1.2.2-box-data-migration.md`.
- **`aggregateSaveDatas`** are lifetime counters `{ Type, SubKey, Value }`.
  Type `0` rows with mappable SubKeys were the historical **material stack count**
  source (`core/inventory/aggregates.ts`). Since the stacking update they are a
  **fallback only** — the authoritative material quantity is the per-slot
  `Quantity` on the slot arrays (see below). Many SubKeys (e.g. `10021`) are still
  undecoded. The same Type `0` rows also store **per-monster kill counts** when
  `SubKey` is a monster id (e.g. `10031` = Bat) — used for pet unlock progress
  (`core/pets/`). Do not run those SubKeys through the material
  `aggregateSubKeyToItemKey()` mapper.
- **`PetSaveData`** lists all companions: `PetKey` (`1001`–`1005` farmable,
  `6001`–`6003` DLC), `IsUnlock`, `IsViewed`. Kill progress toward the 5,000
  unlock is **not** on this array — read monster kills from `aggregateSaveDatas`.
  Static pet metadata (bonuses, farm stages) lives in bundled `data/pets.json`.
- **`9xxxxx` ItemKeys** in `itemSaveDatas` are **stage boxes** (STAGEBOX). They
  are named via `data/stage_boxes.json`, omitted from the inventory tab, and show
  location `unknown` when not referenced by a slot array.
- Steam pricing uses `ItemKey -> market_hash_name` rules in `core/marketName.ts`
  (gear uses market hash suffix `A` only). See `docs/findings/item-mapping.md`.
