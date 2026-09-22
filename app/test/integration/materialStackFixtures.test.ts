import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInventory } from "../../src/core/inventory";
import { readAndDecrypt } from "../../src/main/io/saveFile";

// Integration test against fixed save copies produced by QA. Both files are
// gitignored fixtures, so the whole block is skipped when they are absent
// (e.g. CI) — the suite stays deterministic and never touches the live save.
//
// The skip is reported explicitly (synthetic `it` + stdout banner) because a
// silent `describe.skip` made it impossible to tell "verified and passing" from
// "never ran" in CI output. See docs/agent/QA.md.
const fixtureDir = join(__dirname, "../../../.tmp-qa-fixtures");
const newSavePath = join(fixtureDir, "newsave.es3");
const oldSavePath = join(fixtureDir, "oldsave.es3");

const haveFixtures = existsSync(newSavePath) && existsSync(oldSavePath);

/**
 * Placeholder suite used when the fixtures are missing. Emits a visible
 * warning and one synthetic test so the CI log shows WHY nothing was asserted
 * (rather than a suite that silently does not exist).
 */
function skippedFixtureSuite(reason: string): void {
  describe("material stack fixtures (QA fixed copies)", () => {
    it.skip(`SKIPPED — ${reason}`, () => {});
  });
  console.warn(`\n[SKIP] material stack fixtures: ${reason}\n`);
}

/**
 * Mirror of the dual occupancy criterion in `parse.ts`'s `slotCapacityFromEntries`,
 * applied directly to the raw (undecrypted) player JSON string. `capacity` always
 * counts only unlocked slots; `used` uses per-slot `Quantity > 0` on the new
 * format and falls back to `ItemUniqueId !== "0"` only when no slot carries a
 * `Quantity` field at all (old format).
 *
 * Kept local to the test so it exercises the *data* independently of the parser
 * implementation and can surface a stash-slot count the snapshot does not expose.
 */
function slotStatsFromArray(arrText: string): {
  capacity: number;
  used: number;
  withQuantity: number;
} {
  const objects = arrText.match(/\{[^{}]*\}/g) ?? [];
  let capacity = 0;
  let used = 0;
  let withQuantity = 0;
  const quantityBySlot: Array<number | null> = [];
  const idBySlot: string[] = [];
  const unlockBySlot: boolean[] = [];
  for (const obj of objects) {
    const idMatch = obj.match(/"ItemUniqueId"\s*:\s*"?(\d+)"?/);
    const qtyMatch = obj.match(/"Quantity"\s*:\s*(-?\d+)/);
    const unlockMatch = obj.match(/"(?:IsUnlock|IsUnLock)"\s*:\s*(true|false)/);
    idBySlot.push(idMatch ? idMatch[1] : "0");
    quantityBySlot.push(qtyMatch ? Number(qtyMatch[1]) : null);
    unlockBySlot.push(unlockMatch ? unlockMatch[1] === "true" : false);
    if (qtyMatch) withQuantity++;
  }
  for (let i = 0; i < objects.length; i++) {
    if (!unlockBySlot[i]) continue;
    capacity++;
    if (withQuantity > 0) {
      const q = quantityBySlot[i];
      if (q != null && q > 0) used++;
    } else if (idBySlot[i] !== "0") {
      used++;
    }
  }
  return { capacity, used, withQuantity };
}

/** Slice a top-level JSON array value out of the raw player JSON string. */
function sliceArray(text: string, key: string): string {
  const at = text.indexOf(key);
  if (at === -1) return "";
  const open = text.indexOf("[", at);
  if (open === -1) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return "";
}

/** Extract the nested player JSON string from the decrypted top-level save JSON. */
function playerStringFromSave(es3Text: string): string {
  const root = JSON.parse(es3Text) as { PlayerSaveData?: { value?: unknown } };
  const inner = root.PlayerSaveData?.value;
  if (typeof inner !== "string") throw new Error("PlayerSaveData.value is not a string");
  return inner;
}

if (!haveFixtures) {
  skippedFixtureSuite(
    `fixed save copies not found at ${fixtureDir} (gitignored; run the fixture-producing step first)`,
  );
} else {
  describe("material stack fixtures (QA fixed copies)", () => {
    it("new save: computes inventory and stash occupancy with the Quantity criterion", () => {
      const { text, mtime } = readAndDecrypt(newSavePath);
      const snap = parseInventory(text, mtime);
      // Exposed inventory occupancy uses the new-format Quantity criterion.
      expect(snap.inventoryCapacity).toBe(104);
      expect(snap.inventoryUsed).toBe(3);

      const player = playerStringFromSave(text);
      const stash = slotStatsFromArray(sliceArray(player, '"stashSaveDatas":'));
      expect(stash.withQuantity).toBeGreaterThan(0);
      expect(stash.capacity).toBe(343);
      expect(stash.used).toBe(140);
    });

    it("old save: keeps the UID fallback for occupancy (does not collapse to 0)", () => {
      const { text, mtime } = readAndDecrypt(oldSavePath);
      const snap = parseInventory(text, mtime);
      // Old format carries no Quantity at all, so `used` must stay on the UID path.
      expect(snap.inventoryCapacity).toBe(104);
      expect(snap.inventoryUsed).toBe(104);

      const player = playerStringFromSave(text);
      const inventory = slotStatsFromArray(sliceArray(player, '"inventorySaveDatas":'));
      const stash = slotStatsFromArray(sliceArray(player, '"stashSaveDatas":'));
      expect(inventory.withQuantity).toBe(0);
      expect(stash.withQuantity).toBe(0);
      expect(inventory.capacity).toBe(104);
      expect(inventory.used).toBe(104);
      expect(stash.capacity).toBe(343);
      expect(stash.used).toBe(176);
    });
  });
}
