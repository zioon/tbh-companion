import { describe, it, expect } from "vitest";
import {
  reconcileChestDropsFromRing,
  DROP_RECONCILE_WINDOW_SEC,
  type DropGrantLine,
  type RecordedDrop,
} from "../../src/core/chestDropReconcile";

/** Ring line shorthand. `t` is wallTime seconds; default 1_000_000 (far from now). */
function grant(
  ringSeq: number,
  t: number,
  name: string,
  opts: { raw?: string; bulk?: boolean } = {},
): DropGrantLine {
  return {
    ringSeq,
    wallTime: t,
    acquireName: name,
    acquireRaw: opts.raw ?? `获得了<color=#A69255>${name}</color>。(木乃伊)`,
    bulk: opts.bulk ?? false,
  };
}

function drop(wallTime: number, category: RecordedDrop["category"]): RecordedDrop {
  return { wallTime, category };
}

const T0 = 1_700_000_000;

describe("reconcileChestDropsFromRing", () => {
  it("reports a grant the tracker never recorded", () => {
    const res = reconcileChestDropsFromRing([grant(1, T0, "关卡宝箱")], [], { nowSec: T0 + 60 });
    expect(res.missed).toHaveLength(1);
    expect(res.missed[0]).toMatchObject({ category: "rare", ringSeq: 1, wallTime: T0 });
    expect(res.scanned).toBe(1);
  });

  it("maps each localized chest noun to its category", () => {
    const res = reconcileChestDropsFromRing(
      [grant(1, T0, "普通宝箱"), grant(2, T0 + 1, "关卡宝箱"), grant(3, T0 + 2, "章节首领宝箱")],
      [],
      { nowSec: T0 + 60 },
    );
    expect(res.missed.map((m) => m.category)).toEqual(["common", "rare", "act"]);
  });

  it("matches a recorded drop of the same category and does not double-report", () => {
    const res = reconcileChestDropsFromRing([grant(1, T0, "关卡宝箱")], [drop(T0 + 2, "rare")], {
      nowSec: T0 + 60,
    });
    expect(res.missed).toHaveLength(0);
    expect(res.alreadyTracked).toBe(1);
  });

  // The regression this module exists for: the two channels disagree about how
  // many of EACH kind landed in a minute, so only a per-category multiset
  // difference can tell a real loss from a redistribution. A per-total
  // comparison would have reported a loss here.
  it("treats the channels per category, not by total", () => {
    const res = reconcileChestDropsFromRing(
      [grant(1, T0, "关卡宝箱"), grant(2, T0 + 1, "关卡宝箱")],
      // Same number of drops overall, but both recorded as common.
      [drop(T0, "common"), drop(T0 + 1, "common")],
      { nowSec: T0 + 60 },
    );
    expect(res.missed).toHaveLength(2);
    expect(res.missed.every((m) => m.category === "rare")).toBe(true);
  });

  it("consumes each recorded drop once — two grants need two drops", () => {
    const res = reconcileChestDropsFromRing(
      [grant(1, T0, "关卡宝箱"), grant(2, T0 + 1, "关卡宝箱")],
      [drop(T0, "rare")],
      { nowSec: T0 + 60 },
    );
    expect(res.missed).toHaveLength(1);
    expect(res.missed[0]!.ringSeq).toBe(2);
  });

  it("does not let a nearby drop of another category absorb the grant", () => {
    const res = reconcileChestDropsFromRing([grant(1, T0, "章节首领宝箱")], [drop(T0, "act")], {
      nowSec: T0 + 60,
    });
    expect(res.missed).toHaveLength(0);
  });

  it("ignores a recorded drop outside the window", () => {
    const res = reconcileChestDropsFromRing(
      [grant(1, T0, "关卡宝箱")],
      [drop(T0 - DROP_RECONCILE_WINDOW_SEC - 10, "rare")],
      { nowSec: T0 + 60 },
    );
    expect(res.missed).toHaveLength(1);
  });

  it("recovers the stageKey from the nearest clear", () => {
    const res = reconcileChestDropsFromRing([grant(1, T0 + 5, "关卡宝箱")], [], {
      nowSec: T0 + 60,
      clears: [
        { wallTime: T0, stageKey: 4309 },
        { wallTime: T0 + 500, stageKey: 4310 },
      ],
    });
    expect(res.missed[0]!.stageKey).toBe(4309);
  });

  // A wrong stage is worse than none: a guessed level would corrupt the
  // per-box drop rate it feeds.
  it("leaves the stageKey undefined when no clear resolves", () => {
    const res = reconcileChestDropsFromRing([grant(1, T0, "关卡宝箱")], [], {
      nowSec: T0 + 60,
      clears: [{ wallTime: T0 }],
    });
    expect(res.missed[0]!.stageKey).toBeUndefined();
  });

  it("excludes bulk replays — their wallTime is the ingest moment", () => {
    const res = reconcileChestDropsFromRing([grant(1, T0, "关卡宝箱", { bulk: true })], [], {
      nowSec: T0 + 60,
    });
    expect(res.missed).toHaveLength(0);
    expect(res.excluded).toBe(1);
  });

  it("excludes stage-clear lines", () => {
    const res = reconcileChestDropsFromRing(
      [grant(1, T0, "关卡 3-10", { raw: "通关了关卡 3-10。(4秒)" })],
      [],
      { nowSec: T0 + 60 },
    );
    expect(res.missed).toHaveLength(0);
  });

  it("excludes non-chest grants (they are chest contents, not drops)", () => {
    const res = reconcileChestDropsFromRing(
      [grant(1, T0, "永恒权杖", { raw: "获得了<color=#519FFF>永恒权杖</color>。" })],
      [],
      { nowSec: T0 + 60 },
    );
    expect(res.missed).toHaveLength(0);
  });

  it("excludes an unknown chest noun rather than guessing a category", () => {
    const res = reconcileChestDropsFromRing([grant(1, T0, "神秘宝箱")], [], {
      nowSec: T0 + 60,
    });
    expect(res.missed).toHaveLength(0);
  });

  it("is idempotent — a second pass over recorded output finds nothing", () => {
    const grants = [grant(1, T0, "关卡宝箱"), grant(2, T0 + 1, "普通宝箱")];
    const first = reconcileChestDropsFromRing(grants, [], { nowSec: T0 + 60 });
    expect(first.missed).toHaveLength(2);

    const afterRecording: RecordedDrop[] = first.missed.map((m) => ({
      wallTime: m.wallTime,
      category: m.category,
    }));
    const second = reconcileChestDropsFromRing(grants, afterRecording, { nowSec: T0 + 60 });
    expect(second.missed).toHaveLength(0);
  });

  it("does not mutate the caller's recorded array", () => {
    const recorded: RecordedDrop[] = [drop(T0, "rare")];
    reconcileChestDropsFromRing([grant(1, T0, "关卡宝箱")], recorded, { nowSec: T0 + 60 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.wallTime).toBe(T0);
  });

  it("skips grants older than maxAgeSec", () => {
    const res = reconcileChestDropsFromRing([grant(1, T0, "关卡宝箱")], [], {
      nowSec: T0 + 1000,
      maxAgeSec: 100,
    });
    expect(res.missed).toHaveLength(0);
    expect(res.excluded).toBe(1);
  });

  // The measured 2026-10-15 case: 11 grants in the ring, 6 recorded live
  // (rare 3 / common 3). The pass must recover exactly the 5 lost drops and
  // leave the recorded ones alone.
  it("recovers the measured 45% loss end to end", () => {
    const grants: DropGrantLine[] = [
      grant(1, T0, "关卡宝箱"),
      grant(2, T0 + 60, "普通宝箱"),
      grant(3, T0 + 180, "关卡宝箱"),
      grant(4, T0 + 240, "普通宝箱"),
      grant(5, T0 + 420, "普通宝箱"),
      grant(6, T0 + 540, "关卡宝箱"),
      grant(7, T0 + 660, "普通宝箱"),
      grant(8, T0 + 780, "关卡宝箱"),
      grant(9, T0 + 900, "普通宝箱"),
      grant(10, T0 + 1020, "普通宝箱"),
      grant(11, T0 + 1080, "关卡宝箱"),
    ];
    // Live channel caught rare at 3 points and common at 3 points.
    const recorded: RecordedDrop[] = [
      drop(T0 + 181, "rare"),
      drop(T0 + 421, "common"),
      drop(T0 + 781, "rare"),
      drop(T0 + 901, "common"),
      drop(T0 + 1021, "common"),
      drop(T0 + 1081, "rare"),
    ];
    const res = reconcileChestDropsFromRing(grants, recorded, { nowSec: T0 + 1200 });
    expect(res.missed).toHaveLength(5);
    const counts = res.missed.reduce<Record<string, number>>((acc, m) => {
      acc[m.category] = (acc[m.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ rare: 2, common: 3 });
  });
});
