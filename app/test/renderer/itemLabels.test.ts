import { describe, expect, it } from "vitest";
import { createI18n } from "../../src/core/i18n/factory";
import type { LookupStatRow, LookupMaterialOutcome } from "../../shared/types";
import { formatStatRow, formatMaterialOutcome } from "../../src/renderer/lib/itemLabels";

// Build a real i18next instance seeded with game-style stat templates so we
// can exercise the lookupStatTemplate + fillStatTemplate path. The instance's
// `t` method is signature-compatible with react-i18next's TFunction.
function makeT() {
  const i = createI18n({
    language: "en",
    fallback: "en",
    resources: {
      en: {
        common: {
          labels: {
            stats: {
              AttackDamage: "Attack Damage",
              AttackSpeed: "Attack Speed",
            },
            baseStatNames: {
              AttackSpeed: "Attack Per Second",
            },
            statTemplates: {
              Stat_AttackDamage_FLAT: "Attack Damage +{0}",
              Stat_AttackSpeed_FLAT: "Attack Speed +{0}",
              Stat_AttackDamage_ADDITIVE: "{0}% Increased Attack Damage",
              Stat_AttackSpeed_ADDITIVE_MinMax: "{0}~{1}% Increased Attack Speed",
            },
          },
        },
      },
      "zh-CN": {
        common: {
          labels: {
            stats: {
              AttackDamage: "攻击力",
              AttackSpeed: "攻击速度",
            },
            baseStatNames: {
              AttackSpeed: "每秒攻击",
            },
            statTemplates: {
              Stat_AttackDamage_FLAT: "攻击力 +{0}",
              Stat_AttackSpeed_FLAT: "攻击速度 +{0}",
              Stat_AttackDamage_ADDITIVE: "{0}% 增加攻击伤害",
            },
          },
        },
      },
    },
  });
  return i.t.bind(i) as Parameters<typeof formatStatRow>[1];
}

describe("formatStatRow", () => {
  it("uses the game template with the value extracted from display (AttackSpeed FLAT)", () => {
    // Regression: row.value=10 is the raw internal integer (1.00 attacks/sec);
    // row.display="Attack Per Second 1.00" is the game-formatted string.
    // Filling the template with row.value would produce "Attack Speed +10"
    // (missing decimal point). We must extract "1.00" from display instead.
    const row: LookupStatRow = {
      stat: "AttackSpeed",
      mod: "FLAT",
      value: 10,
      display: "Attack Per Second 1.00",
    };
    expect(formatStatRow(row, makeT())).toBe("Attack Speed +1.00");
  });

  it("extracts decimal values from display (AttackDamage ADDITIVE)", () => {
    // value=209 internally means +20.9%; display already shows "20.9%".
    const row: LookupStatRow = {
      stat: "AttackDamage",
      mod: "ADDITIVE",
      value: 209,
      display: "20.9% Increased Attack Damage",
    };
    expect(formatStatRow(row, makeT())).toBe("20.9% Increased Attack Damage");
  });

  it("extracts integer values from display (AttackDamage FLAT)", () => {
    const row: LookupStatRow = {
      stat: "AttackDamage",
      mod: "FLAT",
      value: 2,
      display: "Attack Damage 2",
    };
    expect(formatStatRow(row, makeT())).toBe("Attack Damage +2");
  });

  it("falls back to row.value when display is missing", () => {
    const row: LookupStatRow = {
      stat: "AttackDamage",
      mod: "FLAT",
      value: 5,
      display: "",
    };
    expect(formatStatRow(row, makeT())).toBe("Attack Damage +5");
  });

  it("falls back to row.value when display has no numeric token", () => {
    const row: LookupStatRow = {
      stat: "AttackDamage",
      mod: "FLAT",
      value: 7,
      display: "Attack Damage (see tooltip)",
    };
    expect(formatStatRow(row, makeT())).toBe("Attack Damage +7");
  });

  it("returns row.display verbatim when no template exists for the stat/mod", () => {
    const row: LookupStatRow = {
      stat: "UnknownStat",
      mod: "WEIRD",
      value: 99,
      display: "Custom Format 42",
    };
    expect(formatStatRow(row, makeT())).toBe("Custom Format 42");
  });

  it("returns row.display when t is undefined (no i18n provider)", () => {
    const row: LookupStatRow = {
      stat: "AttackSpeed",
      mod: "FLAT",
      value: 10,
      display: "Attack Per Second 1.00",
    };
    expect(formatStatRow(row)).toBe("Attack Per Second 1.00");
  });

  it("localizes via the active language template (zh-CN)", () => {
    const i = createI18n({
      language: "zh-CN",
      fallback: "en",
      resources: {
        en: {
          common: {
            labels: {
              statTemplates: {
                Stat_AttackDamage_FLAT: "Attack Damage +{0}",
              },
            },
          },
        },
        "zh-CN": {
          common: {
            labels: {
              statTemplates: {
                Stat_AttackDamage_FLAT: "攻击力 +{0}",
              },
            },
          },
        },
      },
    });
    const row: LookupStatRow = {
      stat: "AttackDamage",
      mod: "FLAT",
      value: 3,
      display: "Attack Damage 3",
    };
    expect(formatStatRow(row, i.t.bind(i) as never)).toBe("攻击力 +3");
  });
});

describe("formatStatRow (base kind)", () => {
  it("uses BaseStatName for AttackSpeed (Attack Per Second 1.00)", () => {
    // Regression: base AttackSpeed should render as "Attack Per Second 1.00"
    // (using BaseStatName_AttackSpeed), not "Attack Speed +1.00" (which is
    // the affix template Stat_AttackSpeed_FLAT). The game uses different
    // units for base AttackSpeed (attacks/sec) vs. the affix template.
    const row: LookupStatRow = {
      stat: "AttackSpeed",
      mod: "FLAT",
      value: 10,
      display: "Attack Per Second 1.00",
    };
    expect(formatStatRow(row, makeT(), "base")).toBe("Attack Per Second 1.00");
  });

  it("falls back to StatName when BaseStatName is absent (AttackDamage)", () => {
    // AttackDamage has no BaseStatName entry; base rendering should fall back
    // to StatName_AttackDamage ("Attack Damage") + naked value.
    const row: LookupStatRow = {
      stat: "AttackDamage",
      mod: "FLAT",
      value: 2,
      display: "Attack Damage 2",
    };
    expect(formatStatRow(row, makeT(), "base")).toBe("Attack Damage 2");
  });

  it("preserves decimal formatting from display (AttackSpeed 1.05)", () => {
    const row: LookupStatRow = {
      stat: "AttackSpeed",
      mod: "FLAT",
      value: 15,
      display: "Attack Per Second 1.05",
    };
    expect(formatStatRow(row, makeT(), "base")).toBe("Attack Per Second 1.05");
  });

  it("localizes BaseStatName via the active language (zh-CN)", () => {
    const i = createI18n({
      language: "zh-CN",
      fallback: "en",
      resources: {
        en: {
          common: {
            labels: {
              stats: { AttackSpeed: "Attack Speed" },
              baseStatNames: { AttackSpeed: "Attack Per Second" },
            },
          },
        },
        "zh-CN": {
          common: {
            labels: {
              stats: { AttackSpeed: "攻击速度" },
              baseStatNames: { AttackSpeed: "每秒攻击" },
            },
          },
        },
      },
    });
    const row: LookupStatRow = {
      stat: "AttackSpeed",
      mod: "FLAT",
      value: 15,
      display: "Attack Per Second 1.05",
    };
    expect(formatStatRow(row, i.t.bind(i) as never, "base")).toBe("每秒攻击 1.05");
  });

  it("falls back to row.display when neither BaseStatName nor StatName exists", () => {
    const row: LookupStatRow = {
      stat: "UnknownStat",
      mod: "FLAT",
      value: 42,
      display: "Custom Display 42",
    };
    expect(formatStatRow(row, makeT(), "base")).toBe("Custom Display 42");
  });

  it("falls back to row.display when t is undefined", () => {
    const row: LookupStatRow = {
      stat: "AttackSpeed",
      mod: "FLAT",
      value: 10,
      display: "Attack Per Second 1.00",
    };
    expect(formatStatRow(row, undefined, "base")).toBe("Attack Per Second 1.00");
  });
});

describe("formatMaterialOutcome", () => {
  it("uses the MinMax template with displayMin/displayMax", () => {
    const outcome: LookupMaterialOutcome = {
      stat: "AttackSpeed",
      mod: "ADDITIVE",
      tier: 2,
      rawMin: 50,
      rawMax: 60,
      displayMin: 5,
      displayMax: 6,
      displayText: "5~6% Increased Attack Speed",
    };
    expect(formatMaterialOutcome(outcome, makeT())).toBe("5~6% Increased Attack Speed");
  });

  it("uses the single-value template when displayMin === displayMax", () => {
    const outcome: LookupMaterialOutcome = {
      stat: "AttackDamage",
      mod: "FLAT",
      tier: 1,
      rawMin: 1,
      rawMax: 1,
      displayMin: 1,
      displayMax: 1,
      displayText: "Attack Damage +1",
    };
    expect(formatMaterialOutcome(outcome, makeT())).toBe("Attack Damage +1");
  });

  it("falls back to displayText when no template exists", () => {
    const outcome: LookupMaterialOutcome = {
      stat: "Unknown",
      mod: "MOD",
      tier: 1,
      rawMin: 1,
      rawMax: 2,
      displayMin: 1,
      displayMax: 2,
      displayText: "Weird 1~2",
    };
    expect(formatMaterialOutcome(outcome, makeT())).toBe("Weird 1~2");
  });

  it("falls back to displayText when t is undefined", () => {
    const outcome: LookupMaterialOutcome = {
      stat: "AttackDamage",
      mod: "FLAT",
      tier: 1,
      rawMin: 1,
      rawMax: 1,
      displayMin: 1,
      displayMax: 1,
      displayText: "Attack Damage +1",
    };
    expect(formatMaterialOutcome(outcome)).toBe("Attack Damage +1");
  });
});
