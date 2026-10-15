// Field regressions from the 2026-10-15 live session.
//
// Two distinct incidents, both driven by real data captured on the machine.
// They are kept together because they share one lesson: the two channels settle
// on different clocks, so a reconciliation must compare like with like.
//
// ── (A) RECOVERY, 13:44 ────────────────────────────────────────────────────
//   13:44:03.770  acquire ring granted 获得了普通宝箱。(电流的地狱祭司)  [common]
//   13:44:16.660  acquire ring granted 获得了关卡宝箱。(木乃伊)          [rare]
//   13:44:16.671  chest fastpoll: caught transient rare (pending=1)
//   13:44:16.688  chestAgg feed: in=[rare]        <- live fed RARE ONLY
//   13:44:17.239  chestAgg flushed: [rare]
//   13:44:24.815  chest-drop reconcile: recorded 1 missed drop(s)
//                 (scanned=33 tracked=32 excluded=164 levelled=1 byCategory=common=1)
//
// The common grant was never observed by the live GetBox channel, so the
// reconcile recovering exactly ONE common drop (with its level) is the
// intended behaviour — NOT a double count. These tests pin that the matcher
// reports it once and only once.
//
// ── (B) LEVEL LOSS, 13:39 ──────────────────────────────────────────────────
//   13:39:19.756  acquire ring granted 获得了关卡宝箱。(木乃伊)   [rare]
//   13:39:29.023  reconcile: recorded 1 missed rare drop(s)
//                 (deferred save slot increase, grace 5000ms, covered-live 0)
//   -> the tracker history entry was `itemKey=900920`, name "Stage boss chest":
//      the SYNTHETIC per-category bucket, i.e. NO level, minutes after the live
//      path had begun booking `920901` "Stage Boss Box Lv90".
//
// Who wrote it: AutoClassifyService's deferred save-slot recovery, which called
// `recordLiveChestDrop` and could only book the synthetic bucket. Because that
// entry already existed (category `rare`), the ring reconcile correctly saw the
// rare grant as *tracked* and stayed silent — so the level had to be fixed at
// the WRITER, not the reconciler. Test (B) documents that division of labour.

import { describe, expect, it } from "vitest";

import {
  reconcileChestDropsFromRing,
  type DropGrantLine,
  type RecordedDrop,
} from "../../src/core/chestDropReconcile";

// Wall-clock anchors relative to the 13:44:24 reconcile pass.
const T_PASS_ABS = 1_792_043_064.815; // 13:44:24.815
const T_COMMON_GRANT = -21.045; // 13:44:03.770
const T_RARE_GRANT = -8.155; // 13:44:16.660

const grant = (ringSeq: number, offsetSec: number, name: string, raw: string): DropGrantLine => ({
  ringSeq,
  wallTime: T_PASS_ABS + offsetSec,
  acquireName: name,
  acquireRaw: raw,
  bulk: false,
});

const recorded = (offsetSec: number, category: RecordedDrop["category"]): RecordedDrop => ({
  wallTime: T_PASS_ABS + offsetSec,
  category,
});

describe("chestDropReconcile matcher discipline", () => {
  it("does not re-report a grant the tracker already recorded", () => {
    const grants = [
      grant(2252, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(电流的地狱祭司)"),
      grant(2255, T_RARE_GRANT, "关卡宝箱", "获得了关卡宝箱。(木乃伊)"),
    ];
    const recorder = [recorded(T_COMMON_GRANT, "common"), recorded(T_RARE_GRANT, "rare")];

    const res = reconcileChestDropsFromRing(grants, recorder, {
      windowSec: 180,
      nowSec: T_PASS_ABS,
    });

    expect(res.scanned).toBe(2);
    expect(res.alreadyTracked).toBe(2);
    expect(res.missed).toEqual([]);
  });

  it("matches a recorded drop that lands slightly AFTER the grant (channel lag)", () => {
    // The live channel stamps a drop when its aggregator flushes, which can be
    // a beat after the ring grant. A one-directional match would invent misses.
    const grants = [grant(2255, T_RARE_GRANT, "关卡宝箱", "获得了关卡宝箱。(木乃伊)")];
    const recorder = [recorded(T_RARE_GRANT + 1.5, "rare")];

    const res = reconcileChestDropsFromRing(grants, recorder, {
      windowSec: 180,
      nowSec: T_PASS_ABS,
    });

    expect(res.missed).toEqual([]);
    expect(res.alreadyTracked).toBe(1);
  });

  it("counts by category, not by total", () => {
    // The real loss shape: 6 grants land but the live channel books only 4, and
    // the one drop it did see it filed under the WRONG bucket (the
    // single-category burst fallback). A total-count comparison (6 vs 4 = 2
    // missing) is blind to this; only the per-category difference exposes that
    // every rare grant is unaccounted for — which is exactly what the 45 %
    // loss looked like on the wire.
    const grants = [
      grant(1, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(a)"),
      grant(2, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(b)"),
      grant(3, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(c)"),
      grant(4, T_RARE_GRANT, "关卡宝箱", "获得了关卡宝箱。(x)"),
      grant(5, T_RARE_GRANT, "关卡宝箱", "获得了关卡宝箱。(y)"),
      grant(6, T_RARE_GRANT, "关卡宝箱", "获得了关卡宝箱。(z)"),
    ];
    const recorder = [
      recorded(T_COMMON_GRANT, "common"),
      recorded(T_COMMON_GRANT, "common"),
      recorded(T_COMMON_GRANT, "common"),
      // only ONE rare recorded, and it was filed under `common` by the
      // single-category burst fallback.
      recorded(T_RARE_GRANT, "common"),
    ];

    const res = reconcileChestDropsFromRing(grants, recorder, {
      windowSec: 180,
      nowSec: T_PASS_ABS,
    });

    // The 3 common grants consume 3 of the 4 `common` recordings; the leftover
    // recording (the mis-filed rare) matches no grant, because matching is
    // strictly per-category. So all 3 rare grants are reported — a total-count
    // comparison would say 2 and hide the fact that an entire category is gone.
    expect(res.missed.length).toBe(3);
    expect(res.missed.every((m) => m.category === "rare")).toBe(true);
  });

  it("consumes each recorded drop once — two grants need two drops", () => {
    const grants = [
      grant(2252, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(a)"),
      grant(2253, T_COMMON_GRANT + 2, "普通宝箱", "获得了普通宝箱。(b)"),
    ];
    const recorder = [recorded(T_COMMON_GRANT, "common")];

    const res = reconcileChestDropsFromRing(grants, recorder, {
      windowSec: 180,
      nowSec: T_PASS_ABS,
    });

    expect(res.alreadyTracked).toBe(1);
    expect(res.missed.length).toBe(1);
    expect(res.missed[0]!.ringSeq).toBe(2253);
  });

  it("excludes bulk replays and stage clears", () => {
    const grants: DropGrantLine[] = [
      grant(2252, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(a)"),
      { ...grant(2253, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(b)"), bulk: true },
      {
        ...grant(2254, T_COMMON_GRANT, "关卡 3-9", "通关了关卡 3-9。(72秒)"),
      },
    ];

    const res = reconcileChestDropsFromRing(grants, [], {
      windowSec: 180,
      nowSec: T_PASS_ABS,
    });

    expect(res.scanned).toBe(1);
    expect(res.excluded).toBe(2);
  });

  it("is idempotent", () => {
    const grants = [grant(2252, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(a)")];
    const nowSec = T_PASS_ABS;

    const first = reconcileChestDropsFromRing(grants, [], { windowSec: 180, nowSec });
    expect(first.missed.length).toBe(1);

    const second = reconcileChestDropsFromRing(
      grants,
      [{ wallTime: first.missed[0]!.wallTime, category: first.missed[0]!.category }],
      { windowSec: 180, nowSec },
    );
    expect(second.missed).toEqual([]);
    expect(second.alreadyTracked).toBe(1);
  });

  it("does not mutate the caller's recorded array", () => {
    const grants = [grant(2252, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(a)")];
    const recorder = [recorded(T_COMMON_GRANT, "common")];
    const snapshot = JSON.stringify(recorder);

    reconcileChestDropsFromRing(grants, recorder, { windowSec: 180, nowSec: T_PASS_ABS });

    expect(JSON.stringify(recorder)).toBe(snapshot);
  });
});

describe("chestDropReconcile field cases (2026-10-15)", () => {
  it("(A) recovers exactly the common drop the live channel never saw", () => {
    // Real 13:44 inputs: BOTH grants landed, but the live channel only ever fed
    // `rare` into the tracker (`chestAgg feed: in=[rare]`), so the common grant
    // had no counterpart. Recovering exactly one common — nothing more — is the
    // fix working, and this is what produced the log line
    // `byCategory=common=1 levelled=1`.
    const grants = [
      grant(2252, T_COMMON_GRANT, "普通宝箱", "获得了普通宝箱。(电流的地狱祭司)"),
      grant(2255, T_RARE_GRANT, "关卡宝箱", "获得了关卡宝箱。(木乃伊)"),
    ];
    const recorder = [recorded(T_RARE_GRANT, "rare")]; // rare only

    const res = reconcileChestDropsFromRing(grants, recorder, {
      windowSec: 180,
      nowSec: T_PASS_ABS,
    });

    expect(res.scanned).toBe(2);
    expect(res.alreadyTracked).toBe(1);
    expect(res.missed.length).toBe(1);
    expect(res.missed[0]!.category).toBe("common");
    expect(res.missed[0]!.ringSeq).toBe(2252);
  });

  it("(B) treats a synthetic-bucket entry as tracked, so the fix must live in the writer", () => {
    // 13:39: the save-slot recovery booked the rare drop as the synthetic
    // `900920` bucket. The category still says `rare`, so the matcher rightly
    // considers the grant accounted for. The LEVEL was lost at write time, not
    // at match time — hence AutoClassifyService now resolves a catalog id.
    const grants = [grant(2242, T_RARE_GRANT, "关卡宝箱", "获得了关卡宝箱。(木乃伊)")];
    const recorder = [recorded(T_RARE_GRANT, "rare")]; // 900920, levelless

    const res = reconcileChestDropsFromRing(grants, recorder, {
      windowSec: 180,
      nowSec: T_PASS_ABS,
    });

    expect(res.missed).toEqual([]);
    expect(res.alreadyTracked).toBe(1);
  });
});
