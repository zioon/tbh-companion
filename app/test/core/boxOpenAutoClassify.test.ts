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
    expect(queue[0]?.expiresAtMs).toBe(now + 1_230_000);
    expect(queue[0]?.autoOpenAtMs).toBe(now + 600_000);
  });
  it("queues same-boxKey chests serially (each opens one cycle after the previous)", () => {
    // Three common chests dropped at 1000, 1100, 1200 — all with autoOpen=300s.
    // Without serial queuing, all three would compute autoOpenAtMs=301000/301100/301200
    // (essentially simultaneous). With serial queuing:
    //   1st: 1000 + 300*1000 = 301000
    //   2nd: 301000 + 300*1000 = 601000
    //   3rd: 601000 + 300*1000 = 901000
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
    expect(q.map((i) => i.autoOpenAtMs)).toEqual([301_000, 601_000, 901_000]);
    // Order is still insertion order (each new one has a later autoOpenAtMs).
    expect(q.map((i) => i.droppedAtMs)).toEqual([1000, 1100, 1200]);
  });

  it("does NOT chain across different boxKeys (different chest types open independently)", () => {
    // common:5 and rare:5 are different boxKeys — their autoOpenAtMs are
    // computed from their own drop times, not chained.
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
    // rare:5   → 1100 + 600*1000 = 601100 (NOT chained to common's autoOpenAtMs)
    expect(q2[0]).toMatchObject({ boxKey: "common:5", autoOpenAtMs: 301_000 });
    expect(q2[1]).toMatchObject({ boxKey: "rare:5", autoOpenAtMs: 601_100 });
  });

  it("keeps queue sorted by autoOpenAtMs ascending across categories", () => {
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
      autoOpenAtMs: 5000,
    };
    const b: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 2000,
      stageKey: 2,
      expiresAtMs: 9999,
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
      autoOpenAtMs: 1000,
    };
    const live: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 600,
      stageKey: 2,
      expiresAtMs: 9999,
      autoOpenAtMs: 2000,
    };
    const { queue, item } = dequeue([expired, live], 1000);
    expect(item).toBe(live);
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
      autoOpenAtMs: 1000,
    };
    const b: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 0,
      stageKey: 2,
      expiresAtMs: 1500,
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
      autoOpenAtMs: 2000,
    };
    expect(pruneExpired([a], 1000)).toEqual([a]);
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
