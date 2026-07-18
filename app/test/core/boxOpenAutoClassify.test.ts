import { describe, it, expect } from "vitest";
import {
  computeTtlMs,
  enqueue,
  dequeue,
  pruneExpired,
  promoteNextHead,
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
      serialKey: "rare",
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.boxKey).toBe("rare:3");
    expect(queue[0]?.droppedAtMs).toBe(now);
    // TTL is anchored to autoOpenAtMs (not droppedAtMs): for the head of a
    // chain, autoOpenAtMs = droppedAtMs + autoOpenSeconds*1000, so
    // expiresAtMs = autoOpenAtMs + ttlMs = (now + 600_000) + 1_230_000.
    expect(queue[0]?.autoOpenAtMs).toBe(now + 600_000);
    expect(queue[0]?.expiresAtMs).toBe(now + 600_000 + 1_230_000);
    expect(queue[0]?.autoOpenSeconds).toBe(600);
    expect(queue[0]?.serialKey).toBe("rare");
  });

  it("queues same-serialKey chests serially (only head is active; rest wait)", () => {
    // Three common chests dropped at 1000, 1100, 1200 — all with autoOpen=300s.
    // Serial per-category auto-open: only the first chest's timer is running;
    // the second and third wait until their predecessor is actually opened.
    //   1st: active, autoOpenAtMs = 1000 + 300*1000 = 301000
    //   2nd: waiting, autoOpenAtMs = null
    //   3rd: waiting, autoOpenAtMs = null
    let q = enqueue([], {
      boxKey: "common:5",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
      serialKey: "common",
    });
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1100,
      stageKey: 1101,
      autoOpenSeconds: 300,
      serialKey: "common",
    });
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1200,
      stageKey: 1101,
      autoOpenSeconds: 300,
      serialKey: "common",
    });
    expect(q.map((i) => i.autoOpenAtMs)).toEqual([301_000, null, null]);
    // Order within the chain is FIFO by drop time.
    expect(q.map((i) => i.droppedAtMs)).toEqual([1000, 1100, 1200]);
    // TTL also chains serially: each waiting chest's expiresAtMs is one
    // auto-open cycle after its predecessor's expiry, not its own drop time.
    //   ttlMs = max(300*2*1000, 60000) + 30000 = 630000
    //   1st expiresAtMs = 301000 + 630000 = 931000
    //   2nd expiresAtMs = 931000 + 300*1000 = 1231000
    //   3rd expiresAtMs = 1231000 + 300*1000 = 1531000
    expect(q.map((i) => i.expiresAtMs)).toEqual([931_000, 1_231_000, 1_531_000]);
  });

  it("queues same-serialKey chests of different boxKey levels serially", () => {
    // Two common chests of different levels (common:3 and common:5) share the
    // same serialKey "common" — they queue serially because the game opens one
    // common slot at a time regardless of level.
    let q = enqueue([], {
      boxKey: "common:3",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
      serialKey: "common",
    });
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1100,
      stageKey: 1105,
      autoOpenSeconds: 300,
      serialKey: "common",
    });
    // 1st: active, autoOpenAtMs = 1000 + 300*1000 = 301000
    // 2nd: waiting (different boxKey but same serialKey "common")
    expect(q.map((i) => `${i.boxKey}@${i.autoOpenAtMs ?? "null"}`)).toEqual([
      "common:3@301000",
      "common:5@null",
    ]);
  });

  it("does NOT chain across different serialKeys (different categories open independently)", () => {
    // common:5 (serialKey "common") and rare:5 (serialKey "rare") are different
    // categories — each is the head of its own chain, so both get a concrete
    // autoOpenAtMs from their own drop time.
    const q1 = enqueue([], {
      boxKey: "common:5",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
      serialKey: "common",
    });
    const q2 = enqueue(q1, {
      boxKey: "rare:5",
      droppedAtMs: 1100,
      stageKey: 1101,
      autoOpenSeconds: 600,
      serialKey: "rare",
    });
    // common:5 → 1000 + 300*1000 = 301000
    // rare:5   → 1100 + 600*1000 = 601100 (NOT chained to common's autoOpenAtMs)
    expect(q2[0]).toMatchObject({ boxKey: "common:5", autoOpenAtMs: 301_000 });
    expect(q2[1]).toMatchObject({ boxKey: "rare:5", autoOpenAtMs: 601_100 });
  });

  it("queues each of the three chest categories serially (common / rare / act)", () => {
    // Drop two of each category, all at the same wall time (1000ms). Each
    // category chains independently: only the first of each is active.
    //   common (300s): 1st=301000 (active), 2nd=null (waiting)
    //   rare   (600s): 1st=601000 (active), 2nd=null (waiting)
    //   act     (60s): 1st=61000  (active), 2nd=null (waiting)
    // Active heads sort first by autoOpenAtMs ascending:
    //   act(61000) → common(301000) → rare(601000)
    // Waiting items sort after all active heads, by droppedAtMs ascending
    // (all equal here → stable insertion order: common, rare, act):
    //   common(null) → rare(null) → act(null)
    let q: QueueItem[] = [];
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 300,
      serialKey: "common",
    });
    q = enqueue(q, {
      boxKey: "common:5",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 300,
      serialKey: "common",
    });
    q = enqueue(q, {
      boxKey: "rare:5",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 600,
      serialKey: "rare",
    });
    q = enqueue(q, {
      boxKey: "rare:5",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 600,
      serialKey: "rare",
    });
    q = enqueue(q, {
      boxKey: "act:1",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 60,
      serialKey: "act",
    });
    q = enqueue(q, {
      boxKey: "act:1",
      droppedAtMs: 1000,
      stageKey: 1105,
      autoOpenSeconds: 60,
      serialKey: "act",
    });

    expect(q.map((i) => `${i.boxKey}@${i.autoOpenAtMs ?? "null"}`)).toEqual([
      "act:1@61000",
      "common:5@301000",
      "rare:5@601000",
      "common:5@null",
      "rare:5@null",
      "act:1@null",
    ]);
  });

  it("keeps active heads sorted by autoOpenAtMs ascending across categories", () => {
    // common@1000s autoOpen=300s → autoOpenAtMs=301000
    // rare@2000s   autoOpen=600s → autoOpenAtMs=602000
    // Despite rare being enqueued first, common should sort to the head.
    const q1 = enqueue([], {
      boxKey: "rare:3",
      droppedAtMs: 2000,
      stageKey: 3303,
      autoOpenSeconds: 600,
      serialKey: "rare",
    });
    const q2 = enqueue(q1, {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1101,
      autoOpenSeconds: 300,
      serialKey: "common",
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
      serialKey: "common",
    });
    const q2 = enqueue(q1, {
      boxKey: "act",
      droppedAtMs: 5000,
      stageKey: 0,
      autoOpenSeconds: 60,
      serialKey: "act",
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
      serialKey: "common",
      autoOpenAtMs: 5000,
    };
    const b: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 2000,
      stageKey: 2,
      expiresAtMs: 9999,
      autoOpenSeconds: 600,
      serialKey: "rare",
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
      serialKey: "common",
      autoOpenAtMs: 1000,
    };
    const live: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 600,
      stageKey: 2,
      expiresAtMs: 9999,
      autoOpenSeconds: 600,
      serialKey: "rare",
      autoOpenAtMs: 2000,
    };
    const { queue, item } = dequeue([expired, live], 1000);
    expect(item).toBe(live);
    expect(queue).toEqual([]);
  });
  it("promotes the next waiting same-serialKey item to active head on dequeue", () => {
    // Two common chests queued serially: head active, second waiting (null).
    // On dequeue at now=5000, the second is promoted to active head with
    // autoOpenAtMs = 5000 + 300*1000 = 305000 and expiresAtMs recomputed
    // from that new autoOpenAtMs:
    //   ttlMs = max(300*2*1000, 60000) + 30000 = 630000
    //   expiresAtMs = 305000 + 630000 = 935000
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: 301000,
    };
    const b: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1100,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: null,
    };
    const { queue, item } = dequeue([a, b], 5000);
    expect(item).toBe(a);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.boxKey).toBe("common");
    expect(queue[0]?.autoOpenAtMs).toBe(305000);
    expect(queue[0]?.expiresAtMs).toBe(935000);
  });
  it("promotes a waiting same-serialKey item of a different boxKey level", () => {
    // common:3 (head, active) and common:5 (waiting) share serialKey "common".
    // On dequeue, common:5 is promoted even though its boxKey differs.
    const a: QueueItem = {
      boxKey: "common:3",
      droppedAtMs: 1000,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: 5000,
    };
    const b: QueueItem = {
      boxKey: "common:5",
      droppedAtMs: 1100,
      stageKey: 2,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: null,
    };
    const { queue, item } = dequeue([a, b], 1500);
    expect(item).toBe(a);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.boxKey).toBe("common:5");
    expect(queue[0]?.autoOpenAtMs).toBe(301500);
  });
  it("does not promote a different serialKey's waiting item on dequeue", () => {
    // Head is common (active), second is rare (active, different serialKey),
    // third is common (waiting). On dequeue, common's waiting item should be
    // promoted, rare's item should be untouched.
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: 5000,
    };
    const b: QueueItem = {
      boxKey: "rare",
      droppedAtMs: 2000,
      stageKey: 2,
      expiresAtMs: 9999,
      autoOpenSeconds: 600,
      serialKey: "rare",
      autoOpenAtMs: 6000,
    };
    const c: QueueItem = {
      boxKey: "common",
      droppedAtMs: 3000,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: null,
    };
    const { queue, item } = dequeue([a, b, c], 1500);
    expect(item).toBe(a);
    // b stays at autoOpenAtMs=6000 (untouched); c promoted to 1500+300000=301500.
    expect(queue).toHaveLength(2);
    expect(queue[0]).toMatchObject({ boxKey: "rare", autoOpenAtMs: 6000 });
    expect(queue[1]).toMatchObject({ boxKey: "common", autoOpenAtMs: 301500 });
  });
});

describe("promoteNextHead", () => {
  it("promotes the first waiting item of serialKey to active head and recomputes expiresAtMs", () => {
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1,
      expiresAtMs: 9999, // placeholder; promote recomputes from new autoOpenAtMs
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: null,
    };
    const result = promoteNextHead([a], "common", 5000);
    // autoOpenAtMs = 5000 + 300*1000 = 305000
    expect(result[0]?.autoOpenAtMs).toBe(305000);
    // ttlMs = max(300*2*1000, 60000) + 30000 = 630000
    // expiresAtMs = 305000 + 630000 = 935000 (anchored to new autoOpenAtMs)
    expect(result[0]?.expiresAtMs).toBe(935000);
  });
  it("leaves the queue unchanged when no matching serialKey exists", () => {
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: null,
    };
    const original = [a];
    const result = promoteNextHead(original, "rare", 5000);
    expect(result).toBe(original); // referentially equal — no copy
    expect(result).toEqual([a]);
  });
  it("leaves the queue unchanged when the next item is already active", () => {
    const a: QueueItem = {
      boxKey: "common",
      droppedAtMs: 1000,
      stageKey: 1,
      expiresAtMs: 9999,
      autoOpenSeconds: 300,
      serialKey: "common",
      autoOpenAtMs: 5000,
    };
    const original = [a];
    const result = promoteNextHead(original, "common", 9999);
    expect(result).toBe(original); // referentially equal — no copy
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
      serialKey: "common",
      autoOpenAtMs: 1000,
    };
    const b: QueueItem = {
      boxKey: "rare:3",
      droppedAtMs: 0,
      stageKey: 2,
      expiresAtMs: 1500,
      autoOpenSeconds: 600,
      serialKey: "rare",
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
      serialKey: "common",
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
