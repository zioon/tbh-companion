// QA independent regression — material stacking + dual-caliber occupancy.
//
// Written by QA (Edward), NOT the engineer. Deliberately duplicates coverage so
// failures cannot be hidden by a test that mirrors the implementation. Real save
// copies live in `.tmp-qa-fixtures/` (gitignored `*.es3`), so the whole real-save
// block skips cleanly on CI while still running on the QA machine.
//
// Fixture copies are PINNED and immutable (the live save is rewritten by the game
// continuously — see QA recon report). Golden values below were derived by an
// independent Node probe, never copied from the engineer's report.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseInventory, resolveInventory } from "../../src/core/inventory";
import type { GameItem } from "../../src/core/gamedata";
import { readAndDecrypt } from "../../src/main/io/saveFile";

const fixtureDir = join(__dirname, "../../../.tmp-qa-fixtures");
const newSavePath = join(fixtureDir, "newsave.es3");
const oldSavePath = join(fixtureDir, "oldsave.es3");
const haveFixtures = existsSync(newSavePath) && existsSync(oldSavePath);

// Real catalog so MATERIAL classification is the production one (not a stub).
const gdPath = join(__dirname, "../../dist/data/gamedata.json");
const gd = JSON.parse(readFileSync(gdPath, "utf-8")) as { items: GameItem[] };
const byId = new Map<number, GameItem>();
for (const it of gd.items) byId.set(Number(it.id), it);
const lookup = (key: number): GameItem | undefined => byId.get(key);
const isMaterial = (key: number) => lookup(key)?.type === "MATERIAL";

const runReal = haveFixtures ? describe : describe.skip;

runReal("QA independent — pinned real saves (immutable copies)", () => {
  it("P0-2 NEW save via real parseInventory: inventory 104/3, stash material split sane", () => {
    const { text, mtime } = readAndDecrypt(newSavePath);
    const snap = parseInventory(text, mtime, isMaterial);
    // Golden from QA probe on the pinned copy.
    expect(snap.inventoryCapacity).toBe(104);
    expect(snap.inventoryUsed).toBe(3);

    // Material grand totals — LOSSLESS string-path golden (QA probe v2).
    //
    // IMPORTANT: UniqueId exceeds 2^53, so a JSON.parse-based golden rounds the
    // digits (551278195918962671 -> ...700) and collapses distinct materials onto
    // one key. The golden below was derived with the SAME lossless string regex
    // path the parser uses, never from JSON.parse. (An earlier lossy golden
    // mis-reported 190004=29 / 111003=3; the lossless values are 26 / 2.)
    const expected: Record<number, number> = {
      190004: 26,
      116004: 13,
      116001: 9,
      134001: 9,
      116002: 7,
      115004: 6,
      116003: 6,
      125003: 6,
      126001: 6,
      126004: 6,
      145001: 6,
      115003: 5,
      125004: 5,
      131001: 5,
      115001: 4,
      115002: 4,
      125002: 3,
      126003: 3,
      133001: 3,
      111003: 2,
      160006: 2,
      124004: 2,
      145002: 2,
      141001: 2,
      121003: 1,
      132001: 1,
      135001: 2,
      146001: 1,
      146002: 1,
    };
    const stacks = snap.materialStacks!;
    for (const [key, total] of Object.entries(expected)) {
      expect(stacks.get(Number(key))?.total, `material ${key}`).toBe(total);
    }
    // Spot-check the flag-ship multi-slot cases.
    expect(stacks.get(190004)!.total).toBe(26); // multi slots [5,5,5,4,4,3]
    expect(stacks.get(116002)!.total).toBe(7); // [5,2]
    expect(stacks.get(116004)!.total).toBe(13); // [5,5,3]
    expect(stacks.get(116001)!.total).toBe(9); // [5,4]

    // resolveInventory must surface the same totals on the rows.
    const res = resolveInventory(snap, lookup, true);
    const soul = res.rows.find((r) => r.itemKey === 190004)!;
    expect(soul.count).toBe(26);
    const ingot = res.rows.find((r) => r.itemKey === 116002)!;
    expect(ingot.count).toBe(7);
  });

  it("P0-1 OLD save via real parseInventory: used must NOT collapse (inv 104/104)", () => {
    const { text, mtime } = readAndDecrypt(oldSavePath);
    const snap = parseInventory(text, mtime, isMaterial);
    expect(snap.inventoryCapacity).toBe(104);
    // Pre-stacking save: no Quantity anywhere -> UID fallback keeps 104.
    expect(snap.inventoryUsed).toBe(104);
    // No slot Quantity -> the slot-stack path is empty, so the aggregate
    // fallback engages and yields the 3 material keys the lifetime counters
    // map to (140001/140002/140003). This is the legacy path, not a regression.
    // (QA probe on the pinned copy: {140001:162, 140003:42, 140002:15}.)
    expect(snap.materialStacks?.size ?? 0).toBe(3);
    // Full pipeline must not throw on the legacy shape.
    expect(() => resolveInventory(snap, lookup, true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Handwritten fixtures — independent of any real save, cover the exact edges.
// ---------------------------------------------------------------------------

function wrap(inner: string): string {
  return JSON.stringify({ PlayerSaveData: { value: inner } });
}

describe("QA independent — dual-caliber occupancy", () => {
  it("MIXED array (whole-array switch): slot w/ Quantity:3 + slot w/o field -> used=1, not 2", () => {
    // The one case the engineer did NOT cover. Whole-array switch means the
    // array is interpreted as NEW format, so the field-less slot reads as empty.
    // A per-slot/greedy implementation would count it -> used=2. This is the
    // sentinel against that regression.
    const inner = `{
      "inventorySaveDatas":[
        {"Index":0,"ItemUniqueId":514119247889201002,"IsUnlock":true,"Quantity":3},
        {"Index":1,"ItemUniqueId":514119247889201003,"IsUnlock":true}
      ]
    }`;
    const snap = parseInventory(wrap(inner), 0);
    expect(snap.inventoryCapacity).toBe(2);
    expect(snap.inventoryUsed).toBe(1);
  });

  it("MIXED array via object path agrees with string path (both =1)", () => {
    const obj = parseInventory(
      JSON.stringify({
        PlayerSaveData: {
          value: {
            inventorySaveDatas: [
              { Index: 0, ItemUniqueId: "514119247889201002", IsUnlock: true, Quantity: 3 },
              { Index: 1, ItemUniqueId: "514119247889201003", IsUnlock: true },
            ],
          },
        },
      }),
      0,
    );
    expect(obj.inventoryCapacity).toBe(2);
    expect(obj.inventoryUsed).toBe(1);
  });

  it("sentinel: UID != 0 but Quantity:0 must NOT count as used", () => {
    const inner = `{
      "inventorySaveDatas":[
        {"Index":0,"ItemUniqueId":514119247889201002,"IsUnlock":true,"Quantity":5},
        {"Index":1,"ItemUniqueId":514119247889201099,"IsUnlock":true,"Quantity":0}
      ]
    }`;
    const snap = parseInventory(wrap(inner), 0);
    expect(snap.inventoryUsed).toBe(1);
  });

  it("stacked slot counts once (Quantity:5 in one slot -> used=1)", () => {
    const inner = `{
      "inventorySaveDatas":[
        {"Index":0,"ItemUniqueId":514119247889201002,"IsUnlock":true,"Quantity":5},
        {"Index":1,"ItemUniqueId":0,"IsUnlock":true,"Quantity":0}
      ]
    }`;
    const snap = parseInventory(wrap(inner), 0);
    expect(snap.inventoryCapacity).toBe(2);
    expect(snap.inventoryUsed).toBe(1);
  });

  it("locked slot never counts toward capacity or used", () => {
    const inner = `{
      "inventorySaveDatas":[
        {"Index":0,"ItemUniqueId":514119247889201002,"IsUnlock":true,"Quantity":2},
        {"Index":1,"ItemUniqueId":514119247889201003,"IsUnlock":false,"Quantity":4}
      ]
    }`;
    const snap = parseInventory(wrap(inner), 0);
    expect(snap.inventoryCapacity).toBe(1);
    expect(snap.inventoryUsed).toBe(1);
  });
});

describe("QA independent — material stacking math", () => {
  it("cross-slot sum 7 = 5 + 2 (not slot count, not max)", () => {
    const inner = `{
      "stashSaveDatas":[
        {"Index":0,"ItemUniqueId":514119247889201002,"IsUnLock":true,"Quantity":5},
        {"Index":1,"ItemUniqueId":514119247889201002,"IsUnLock":true,"Quantity":2}
      ],
      "itemSaveDatas":[{"ItemKey":141002,"UniqueId":514119247889201002,"IsChaotic":false}]
    }`;
    const snap = parseInventory(wrap(inner), 0, isMaterial);
    expect(snap.materialStacks!.get(141002)!.total).toBe(7);
  });

  it("empty slots (UID 0) and Quantity<=0 are ignored", () => {
    const inner = `{
      "stashSaveDatas":[
        {"Index":0,"ItemUniqueId":0,"IsUnLock":true,"Quantity":5},
        {"Index":1,"ItemUniqueId":514119247889201002,"IsUnLock":true,"Quantity":0},
        {"Index":2,"ItemUniqueId":514119247889201002,"IsUnLock":true,"Quantity":2},
        {"Index":3,"ItemUniqueId":0,"IsUnLock":true}
      ],
      "itemSaveDatas":[{"ItemKey":141002,"UniqueId":514119247889201002,"IsChaotic":false}]
    }`;
    const snap = parseInventory(wrap(inner), 0, isMaterial);
    expect(snap.materialStacks!.get(141002)!.total).toBe(2);
  });

  it("per-slot clamp: Quantity 9 -> 5, plus 2 -> 7 (never > MAX per slot)", () => {
    const inner = `{
      "stashSaveDatas":[
        {"Index":0,"ItemUniqueId":514119247889201002,"IsUnLock":true,"Quantity":9},
        {"Index":1,"ItemUniqueId":514119247889201002,"IsUnLock":true,"Quantity":2}
      ],
      "itemSaveDatas":[{"ItemKey":141002,"UniqueId":514119247889201002,"IsChaotic":false}]
    }`;
    const snap = parseInventory(wrap(inner), 0, isMaterial);
    expect(snap.materialStacks!.get(141002)!.total).toBe(7);
  });

  it("inventory vs stash split is attributed correctly", () => {
    const inner = `{
      "inventorySaveDatas":[{"Index":0,"ItemUniqueId":514119247889201002,"IsUnlock":true,"Quantity":3}],
      "stashSaveDatas":[{"Index":0,"ItemUniqueId":514119247889201002,"IsUnLock":true,"Quantity":4}],
      "itemSaveDatas":[{"ItemKey":141002,"UniqueId":514119247889201002,"IsChaotic":false}]
    }`;
    const snap = parseInventory(wrap(inner), 0, isMaterial);
    const st = snap.materialStacks!.get(141002)!;
    expect(st.total).toBe(7);
    expect(st.inventory).toBe(3);
    expect(st.stash).toBe(4);
  });

  it("clamp does NOT contaminate used occupancy (independent logic)", () => {
    // Quantity 9 clamps to 5 for the material total, but the slot is still ONE
    // used slot.
    const inner = `{
      "inventorySaveDatas":[{"Index":0,"ItemUniqueId":514119247889201002,"IsUnlock":true,"Quantity":9}],
      "itemSaveDatas":[{"ItemKey":141002,"UniqueId":514119247889201002,"IsChaotic":false}]
    }`;
    const snap = parseInventory(wrap(inner), 0, isMaterial);
    expect(snap.materialStacks!.get(141002)!.total).toBe(5);
    expect(snap.inventoryCapacity).toBe(1);
    expect(snap.inventoryUsed).toBe(1);
  });

  it("field absent (old save) degrades gracefully: no throw, no phantom stack", () => {
    const inner = `{
      "stashSaveDatas":[{"Index":0,"ItemUniqueId":514119247889201002,"IsUnLock":true}],
      "itemSaveDatas":[{"ItemKey":141002,"UniqueId":514119247889201002,"IsChaotic":false}]
    }`;
    const snap = parseInventory(wrap(inner), 0, isMaterial);
    expect(snap.materialStacks?.has(141002) ?? false).toBe(false);
    expect(() => resolveInventory(snap, lookup, true)).not.toThrow();
  });

  it("non-material gear is unaffected by stacking logic", () => {
    const inner = `{
      "stashSaveDatas":[{"Index":0,"ItemUniqueId":514119247889201004,"IsUnLock":true,"Quantity":3}],
      "itemSaveDatas":[{"ItemKey":303071,"UniqueId":514119247889201004,"IsChaotic":false}]
    }`;
    const snap = parseInventory(wrap(inner), 0, isMaterial);
    // 303071 is GEAR; it must not appear in material stacks.
    expect(snap.materialStacks?.has(303071) ?? false).toBe(false);
    const res = resolveInventory(snap, lookup, true);
    expect(res.rows.find((r) => r.itemKey === 303071)!.count).toBe(1);
  });
});
