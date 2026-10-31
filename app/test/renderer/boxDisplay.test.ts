import { describe, expect, it } from "vitest";
import { createI18n } from "../../src/core/i18n/factory";
import {
  localizedBoxName,
  translateBoxDropName,
  translateBoxEventTier,
} from "../../src/renderer/lib/boxDisplay";

// The renderer helpers take a `TFunction<"lookup">`; the factory's `t` is
// signature-compatible with react-i18next's, so a real i18next instance keeps
// the key names honest (a typo would surface as the raw key).
function makeT() {
  const i = createI18n({
    language: "en",
    fallback: "en",
    resources: {
      en: {
        lookup: {
          box: {
            categoryCommon: "Common Treasure Chest",
            categoryStageBoss: "Stage Treasure Chest",
            categoryActBoss: "Act Boss Treasure Chest",
            categoryDefault: "Chest",
            categoryPlagueNormal: "Contaminated Common Treasure Chest",
            categoryPlagueStageBoss: "Contaminated Stage Treasure Chest",
            categoryPlagueActBoss: "Contaminated Act Boss Treasure Chest",
            categoryEventNormal: "Halloween Common Treasure Chest",
            categoryEventStage: "Halloween Stage Treasure Chest",
            levelSuffix: "{{base}} Lv{{level}}",
            difficultyNormal: "Normal",
            difficultyNightmare: "Nightmare",
            difficultyHell: "Hell",
            difficultyTorment: "Torment",
          },
        },
      },
    },
  });
  // `getFixedT` pins the namespace the way `useTranslation("lookup")` does in
  // the renderer — without it i18next would look the keys up in `common`.
  return i.getFixedT(null, "lookup") as Parameters<typeof translateBoxDropName>[0];
}

const t = makeT();

describe("translateBoxEventTier", () => {
  it("maps the event tiers to their own labels", () => {
    expect(translateBoxEventTier(t, "eventNormal")).toBe("Halloween Common Treasure Chest");
    expect(translateBoxEventTier(t, "eventStage")).toBe("Halloween Stage Treasure Chest");
  });
});

describe("localizedBoxName — Halloween event boxes", () => {
  it("renders 940xxx as a Halloween common chest, not the generic common chest", () => {
    const name = localizedBoxName(
      t,
      { name: "Halloween Normal Box (Nightmare)", category: "common", level: null },
      940001,
    );
    expect(name).toBe("Halloween Common Treasure Chest (Nightmare)");
    expect(name).not.toContain("Common Treasure Chest Lv");
  });

  it("renders 941xxx as a Halloween stage chest, not the generic stage chest", () => {
    const name = localizedBoxName(
      t,
      { name: "Halloween Stage Box (Torment)", category: "stage_boss", level: null },
      941201,
    );
    expect(name).toBe("Halloween Stage Treasure Chest (Torment)");
  });

  it("keeps the difficulty suffix for every event difficulty", () => {
    for (const [key, difficulty] of [
      [940001, "Nightmare"],
      [940101, "Hell"],
      [940201, "Torment"],
      [941001, "Nightmare"],
      [941101, "Hell"],
      [941201, "Torment"],
    ] as const) {
      const name = localizedBoxName(
        t,
        { name: `Halloween Box (${difficulty})`, category: "common", level: null },
        key,
      );
      expect(name).toContain(`(${difficulty})`);
    }
  });

  it("does not apply the event label to non-event boxes", () => {
    expect(
      localizedBoxName(t, { name: "Normal Monster Box 2", category: "common", level: 15 }, 910015),
    ).toBe("Common Treasure Chest Lv15");
    expect(
      localizedBoxName(
        t,
        { name: "Stage Boss Box Lv20", category: "stage_boss", level: 20 },
        920020,
      ),
    ).toBe("Stage Treasure Chest Lv20");
  });

  it("does not apply the event label to plague boxes", () => {
    const name = localizedBoxName(
      t,
      { name: "Contaminated Normal Box Lv40", category: "unknown", level: 40 },
      915040,
    );
    expect(name).toBe("Contaminated Common Treasure Chest Lv40");
  });
});

describe("translateBoxDropName — Halloween event boxes", () => {
  it("renders the drop row of a Halloween normal box with the event label", () => {
    expect(
      translateBoxDropName(t, { via: "monster_box", boxName: "Halloween Normal Box (Nightmare)" }),
    ).toBe("Halloween Common Treasure Chest (Nightmare)");
  });

  it("renders the drop row of a Halloween stage box with the event label", () => {
    expect(
      translateBoxDropName(t, { via: "boss_box", boxName: "Halloween Stage Box (Hell)" }),
    ).toBe("Halloween Stage Treasure Chest (Hell)");
  });

  it("never falls back to the generic common / stage chest for an event box", () => {
    const normal = translateBoxDropName(t, {
      via: "monster_box",
      boxName: "Halloween Normal Box (Torment)",
    });
    expect(normal).not.toBe("Common Treasure Chest");
    expect(normal.startsWith("Halloween ")).toBe(true);
  });

  it("keeps the existing common / stage behaviour for normal boxes", () => {
    expect(translateBoxDropName(t, { via: "monster_box", boxName: "Normal Monster Box 2" })).toBe(
      "Common Treasure Chest",
    );
    expect(translateBoxDropName(t, { via: "boss_box", boxName: "Stage Boss Box Lv20" })).toBe(
      "Stage Treasure Chest Lv20",
    );
  });
});
