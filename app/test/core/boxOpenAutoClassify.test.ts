import { describe, it, expect } from "vitest";
import {
  computeTtlMs,
  enqueue,
  dequeue,
  pruneExpired,
  groupBoxOpenEvents,
  type QueueItem,
} from "../../src/core/boxOpenAutoClassify";

describe("computeTtlMs", () => {
  it("returns min 90s (60s floor + 30s buffer) when autoOpen is 0", () => {
    expect(computeTtlMs(0)).toBe(90_000);
  });
  it("returns 2*autoOpen + 30 for typical common (300s)", () => {
    expect(computeTtlMs(300)).toBe(630_000);
  });
  it("returns 2*autoOpen + 30 for stage boss (600s)", () => {
    expect(computeTtlMs(600)).toBe(1_230_000);
  });
  it("returns 2*autoOpen + 30 for act boss (60s)", () => {
    expect(computeTtlMs(60)).toBe(150_000);
  });
  it("handles very large autoOpen without overflow", () => {
    expect(computeTtlMs(86_400)).toBe(172_830_000);
  });
});

describe("enqueue", () => {
  it("inserts a new item with computed expiresAtMs and autoOpenAtMs", () => {
    const now = 1_000_000;
    const queue = enqueue([], {
      boxKey: "rare:3",
      droppedAtMs: now,
      stageKey: 3303,
      autoOpenSeconds: 600,
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.boxKey).toBe("rare:3");
    expect(queue[0]?.droppedAtMs).toBe(now);
    // Slot-parallel: autoOpenAtMs = droppedAtMs + autoOpenSeconds*1000.
    // TTL is anchored to autoOpenAtMs: expiresAtMs = autoOpenAtMs + ttlMs.
    //   autoOpenAtMs = 1000000 + 600*1000 = 1600000
    //   ttlMs = max(600*2*1000, 60000) + 30000 = 1230000
    //   expiresAtMs = 1600000 + 1230000 = 2830000
    expect(queue[0]?.autoOpenAtMs).toBe(now + 600_000);
    expect(queue[0]?.expiresAtMs).toBe(now + 600_000 + 1_230_000);
    expect(queue[0]?.autoOpenSeconds).toBe(600);
  });

  it("assigns every chest a concrete autoOpenAtMs (slot-parallel, no waiting)", () => {
    // Three common chests dropped at 1000, 1100, 1200 — all with autoOpen=300s.
    // Slot-parallel model: every chest gets its own timer at drop time; no
    // chest "waits" for another to open first.
    //   1st: autoOpenAtMs = 1000 + 300*1000 = 301000
    //   2nd: autoOpenAtMs = 1100 + 300*1000 = 301100
    //   3rd: autoOpenAtMs = 1200 + 300*1000 = 301200
    let q = enqueue([], {
      boxKey: "common:5",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
    });
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1100,
      stageKey: 1101,
      autoOpenSeconds: 300,
    });
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1200,
      stageKey: 1101,
      autoOpenSeconds: 300,
    });
    // All items have a concrete autoOpenAtMs (no null/waiting).
    expect(q.map((i) => i.autoOpenAtMs)).toEqual([301_000, 301_100, 301_200]);
    // Order is by autoOpenAtMs ascending (which matches drop order here).
    expect(q.map((i) => i.droppedAtMs)).toEqual([1000, 1100, 1200]);
    // Every item has a concrete expiresAtMs anchored to its own autoOpenAtMs.
    //   ttlMs = max(300*2*1000, 60000) + 30000 = 630000
    //   1st expiresAtMs = 301000 + 630000 = 931000
    //   2nd expiresAtMs = 301100 + 630000 = 931100
    //   3rd expiresAtMs = 301200 + 630000 = 931200
    expect(q.map((i) => i.expiresAtMs)).toEqual([931_000, 931_100, 931_200]);
  });

  it("assigns independent timers to same-category chests of different levels", () => {
    // Two common chests of different levels (common:3 and common:5) — both
    // get their own timer at drop time. The slot-parallel model does not
    // chain them.
    let q = enqueue([], {
      boxKey: "common:3",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
    });
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1100,
      stageKey: 1105,
      autoOpenSeconds: 300,
    });
    // Both have concrete autoOpenAtMs computed from their own drop time.
    expect(q.map((i) => `${i.boxKey}@${i.autoOpenAtMs}`)).toEqual([
      "common:3@301000",
      "common:5@301100",
    ]);
  });

  it("runs different categories fully in parallel (independent timers)", () => {
    // common:5 (autoOpen=300s) and rare:5 (autoOpen=600s) drop at 1000ms and
    // 1100ms respectively. Each gets its own timer from its own drop time;
    // neither waits for the other.
    const q1 = enqueue([], {
      boxKey: "common:5",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
    });
    const q2 = enqueue(q1, {
      boxKey: "rare:5",
      droppedAtMs: 1100,
      stageKey: 1101,
      autoOpenSeconds: 600,
    });
    // common:5 → 1000 + 300*1000 = 301000
    // rare:5   → 1100 + 600*1000 = 601100
    expect(q2[0]).toMatchObject({ boxKey: "common:5", autoOpenAtMs: 301_000 });
    expect(q2[1]).toMatchObject({ boxKey: "rare:5", autoOpenAtMs: 601_100 });
  });

  it("assigns independent timers across all three chest categories", () => {
    // Drop two of each category at the same wall time (1000ms). Under the
    // slot-parallel model, every chest gets its own timer — no waiting.
    //   common (300s): 1st=301000, 2nd=301000 (same drop time → same timer)
    //   rare   (600s): 1st=601000, 2nd=601000
    //   act     (60s): 1st=61000,  2nd=61000
    // Sorted by autoOpenAtMs ascending, ties broken by droppedAtMs (all
    // equal here → stable insertion order: common, common, rare, rare, act, act)
    // Wait — let me recompute: act(61000) < common(301000) < rare(601000),
    // so the expected order is: act, act, common, common, rare, rare.
    let q: QueueItem[] = [];
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 300,
    });
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 300,
    });
    q = enqueue(q, {
      boxKey: "rare:5",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 600,
    });
    q = enqueue(q, {
      boxKey: "rare:5",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 600,
    });
    q = enqueue(q, {
      boxKey: "act:1",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 60,
    });
    q = enqueue(q, {
      boxKey: "act:1",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 60,
    });

    // All items have concrete autoOpenAtMs (no null/waiting). Sorted by
    // autoOpenAtMs ascending: act(61000) x2, common(301000) x2, rare(601000) x2.
    expect(q.map((i) => `${i.boxKey}@${i.autoOpenAtMs}`)).toEqual([
      "act:1@61000",
      "act:1@61000",
      "common:5@301000",
      "common:5@301000",
      "rare:5@601000",
      "rare:5@601000",
    ]);
  });

  it("keeps the queue sorted by autoOpenAtMs ascending across categories", () => {
    // common@1000s autoOpen=300s → autoOpenAtMs=301000
    // rare@2000s   autoOpen=600s → autoOpenAtMs=602000
    // Despite rare being enqueued first, common should sort to the head.
    const q1 = enqueue([], {
      boxKey: "rare:3",
      droppedAtMs: 2000,
      stageKey: 3303,
      autoOpenSeconds: 600,
    });
    const q2 = enqueue(q1, {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
    });
    expect(q2.map((i) => i.boxKey)).toEqual(["common", "rare:3"]);
    expect(q2[0]?.autoOpenAtMs).toBeLessThan(q2[1]?.autoOpenAtMs ?? Infinity);
  });

  it("inserts act boss (short autoOpen) before common (long autoOpen) even when dropped later", () => {
    // common@1000s autoOpen=300s → autoOpenAtMs=301000
    // act@5000s    autoOpen=60s  → autoOpenAtMs=56000 (sooner despite later drop)
    const q1 = enqueue([], {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
    });
    const q2 = enqueue(q1, {
      boxKey: "act",
      droppedAtMs: 5000,
      stageKey: 0,
      autoOpenSeconds: 60,
    });
    expect(q2.map((i) => i.boxKey)).toEqual(["act", "common"]);
  });
});

describe("dequeue", () => {
  it("returns null and unchanged queue when empty", () => {
    const { queue, item } = dequeue([], 1000);
    expect(item).toBeNull();
    expect(queue).toEqual([]);
  });
  it("returns the head item and a queue without it", () => {
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      autoOpenAtMs: 5000,
    };
    const b: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 2000,
      stageKey: 2,
      expiresAtMs: 9999,
      autoOpenSeconds: 600,
      autoOpenAtMs: 6000,
    };
    const { queue, item } = dequeue([a, b], 1500);
    expect(item).toBe(a);
    expect(queue).toEqual([b]);
  });
  it("skips expired head items and returns the first live one", () => {
    const expired: QueueItem = {
      boxKey: "common",
      droppedAtMs: 0,
      stageKey: 1,
      expiresAtMs: 500,
      autoOpenSeconds: 300,
      autoOpenAtMs: 1000,
    };
    const live: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 600,
      stageKey: 2,
      expiresAtMs: 9999,
      autoOpenSeconds: 600,
      autoOpenAtMs: 2000,
    };
    const { queue, item } = dequeue([expired, live], 1000);
    expect(item).toBe(live);
    expect(queue).toEqual([]);
  });
  it("does not modify remaining items' autoOpenAtMs when dequeuing the head", () => {
    // Slot-parallel model: dequeuing the head does not promote or re-timer
    // any other item. Each remaining chest keeps its original autoOpenAtMs.
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      autoOpenAtMs: 5000,
    };
    const b: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1100,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      // b's timer was set at drop time and is independent of a's fate.
      autoOpenAtMs: 301100,
    };
    const { queue, item } = dequeue([a, b], 1500);
    expect(item).toBe(a);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.boxKey).toBe("common");
    // b's autoOpenAtMs is unchanged — no promotion, no re-timer.
    expect(queue[0]?.autoOpenAtMs).toBe(301100);
    expect(queue[0]?.expiresAtMs).toBe(9999);
  });
  it("returns null when all items are expired", () => {
    const expired: QueueItem = {
      boxKey: "common",
      droppedAtMs: 0,
      stageKey: 1,
      expiresAtMs: 500,
      autoOpenSeconds: 300,
      autoOpenAtMs: 1000,
    };
    const { queue, item } = dequeue([expired], 1000);
    expect(item).toBeNull();
    expect(queue).toEqual([]);
  });
});

describe("pruneExpired", () => {
  it("returns empty array for empty input", () => {
    expect(pruneExpired([], 1000)).toEqual([]);
  });
  it("drops items whose expiresAtMs <= now", () => {
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 0,
      stageKey: 1,
      expiresAtMs: 500,
      autoOpenSeconds: 300,
      autoOpenAtMs: 1000,
    };
    const b: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 0,
      stageKey: 2,
      expiresAtMs: 1500,
      autoOpenSeconds: 600,
      autoOpenAtMs: 2000,
    };
    expect(pruneExpired([a, b], 1000)).toEqual([b]);
  });
  it("keeps items whose expiresAtMs > now", () => {
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 0,
      stageKey: 1,
      expiresAtMs: 1001,
      autoOpenSeconds: 300,
      autoOpenAtMs: 2000,
    };
    expect(pruneExpired([a], 1000)).toEqual([a]);
  });
  it("returns the same array reference when no items are pruned", () => {
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 0,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      autoOpenAtMs: 2000,
    };
    const original = [a];
    expect(pruneExpired(original, 1000)).toBe(original);
  });
  it("does not modify remaining items' timers when pruning expired ones", () => {
    // Slot-parallel model: pruning expired items does not re-timer the
    // remaining ones. Each surviving chest keeps its original autoOpenAtMs.
    const expired: QueueItem = {
      boxKey: "common",
      droppedAtMs: 0,
      stageKey: 1,
      expiresAtMs: 500,
      autoOpenSeconds: 300,
      autoOpenAtMs: 1000,
    };
    const live: QueueItem = {
      boxKey: "common",
      droppedAtMs: 200,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      // live's timer was set at drop time and is independent of expired's fate.
      autoOpenAtMs: 300200,
    };
    const result = pruneExpired([expired, live], 1000);
    expect(result).toHaveLength(1);
    // autoOpenAtMs unchanged — no promotion.
    expect(result[0]?.autoOpenAtMs).toBe(300_200);
    expect(result[0]?.expiresAtMs).toBe(9999);
  });
});

describe("groupBoxOpenEvents", () => {
  it("returns empty array for empty input", () => {
    expect(groupBoxOpenEvents([])).toEqual([]);
  });
  it("groups entries within the gap into one event", () => {
    const events = groupBoxOpenEvents([
      { itemKey: 100, wallTime: 1.0 },
      { itemKey: 101, wallTime: 1.02 },
      { itemKey: 102, wallTime: 1.04 },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.itemKeys).toEqual([100, 101, 102]);
    expect(events[0]?.startMs).toBe(1.0);
    expect(events[0]?.endMs).toBe(1.04);
  });
  it("splits into two events when gap exceeds threshold", () => {
    const events = groupBoxOpenEvents([
      { itemKey: 100, wallTime: 1.0 },
      { itemKey: 101, wallTime: 1.1 },
      { itemKey: 200, wallTime: 5.0 }, // 3.9s gap > 2s default
      { itemKey: 201, wallTime: 5.05 },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]?.itemKeys).toEqual([100, 101]);
    expect(events[1]?.itemKeys).toEqual([200, 201]);
  });
  it("handles a single entry as one event", () => {
    const events = groupBoxOpenEvents([{ itemKey: 42, wallTime: 7.0 }]);
    expect(events).toHaveLength(1);
    expect(events[0]?.itemKeys).toEqual([42]);
  });
  it("sorts unsorted input by wallTime before grouping", () => {
    const events = groupBoxOpenEvents([
      { itemKey: 200, wallTime: 5.0 },
      { itemKey: 100, wallTime: 1.0 },
      { itemKey: 101, wallTime: 1.1 },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]?.itemKeys).toEqual([100, 101]);
    expect(events[1]?.itemKeys).toEqual([200]);
  });
  it("honors a custom gapMs", () => {
    const events = groupBoxOpenEvents(
      [
        { itemKey: 100, wallTime: 1.0 },
        { itemKey: 101, wallTime: 1.5 },
      ],
      400, // 0.4s gap; 0.5s difference > 0.4s → split
    );
    expect(events).toHaveLength(2);
  });
});
