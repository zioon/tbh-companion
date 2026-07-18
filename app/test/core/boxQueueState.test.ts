import { describe, it, expect } from "vitest";
import {
  BoxQueueState,
  applyConsumption,
  type BoxQueueConsumption,
} from "../../src/core/liveMemory/boxQueueState";
import type { RawBoxQueue } from "../../src/core/liveMemory/boxQueueScanner";

// ── Helpers ──────────────────────────────────────────────────────────────────

function rawQueue(buckets: Array<{ eboxType: number; items: number[] }>): RawBoxQueue {
  return {
    buckets: buckets.map((b) => ({
      eboxType: b.eboxType,
      items: b.items.map((itemKey) => ({ itemKey })),
    })),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("applyConsumption", () => {
  it("removes N items from the head of the matching category", () => {
    const out = applyConsumption(
      {
        common: [{ itemKey: 1 }, { itemKey: 2 }, { itemKey: 3 }],
        rare: [{ itemKey: 10 }],
        act: [],
      },
      [{ category: "common", count: 2 }],
    );
    expect(out.common.map((i) => i.itemKey)).toEqual([3]);
    expect(out.rare.map((i) => i.itemKey)).toEqual([10]);
    expect(out.act).toEqual([]);
  });

  it("clears the bucket when count >= queue length", () => {
    const out = applyConsumption({ common: [{ itemKey: 1 }], rare: [], act: [] }, [
      { category: "common", count: 5 },
    ]);
    expect(out.common).toEqual([]);
  });

  it("accumulates counts for the same category across events", () => {
    const out = applyConsumption(
      {
        common: [{ itemKey: 1 }, { itemKey: 2 }, { itemKey: 3 }, { itemKey: 4 }],
        rare: [],
        act: [],
      },
      [
        { category: "common", count: 1 },
        { category: "common", count: 2 },
      ],
    );
    expect(out.common.map((i) => i.itemKey)).toEqual([4]);
  });

  it("treats negative counts as 0 (no-op)", () => {
    const out = applyConsumption({ common: [{ itemKey: 1 }], rare: [], act: [] }, [
      { category: "common", count: -3 },
    ]);
    expect(out.common.map((i) => i.itemKey)).toEqual([1]);
  });

  it("doesn't affect other categories", () => {
    const out = applyConsumption(
      {
        common: [{ itemKey: 1 }, { itemKey: 2 }],
        rare: [{ itemKey: 10 }, { itemKey: 11 }],
        act: [{ itemKey: 20 }],
      },
      [{ category: "rare", count: 1 }],
    );
    expect(out.common.map((i) => i.itemKey)).toEqual([1, 2]);
    expect(out.rare.map((i) => i.itemKey)).toEqual([11]);
    expect(out.act.map((i) => i.itemKey)).toEqual([20]);
  });
});

describe("BoxQueueState.advance", () => {
  it("emits the raw queue on first successful read", () => {
    const s = new BoxQueueState();
    const snap = s.advance(rawQueue([{ eboxType: 0, items: [1, 2] }]), "ok", [], 1000);
    expect(snap.status).toBe("ok");
    expect(snap.fetchedAt).toBe(1000);
    expect(snap.common.map((i) => i.itemKey)).toEqual([1, 2]);
    expect(snap.rare).toEqual([]);
    expect(snap.act).toEqual([]);
  });

  it("deduplicates identical reads (same snapKey = no re-base)", () => {
    const s = new BoxQueueState();
    const raw = rawQueue([{ eboxType: 0, items: [1, 2] }]);
    s.advance(raw, "ok", [], 1000);
    // Same raw → snapKey matches → predicted stays the same object identity
    // (we still apply consumption, but no re-base).
    const snap2 = s.advance(raw, "ok", [], 2000);
    expect(snap2.common.map((i) => i.itemKey)).toEqual([1, 2]);
  });

  it("re-bases when the snapKey changes (game appended an item)", () => {
    const s = new BoxQueueState();
    s.advance(rawQueue([{ eboxType: 0, items: [1, 2] }]), "ok", [], 1000);
    // New item appended at the tail → snapKey changes (length differs).
    const snap = s.advance(rawQueue([{ eboxType: 0, items: [1, 2, 3] }]), "ok", [], 2000);
    expect(snap.common.map((i) => i.itemKey)).toEqual([1, 2, 3]);
  });

  it("consumes the head on box-open events", () => {
    const s = new BoxQueueState();
    s.advance(rawQueue([{ eboxType: 0, items: [1, 2, 3] }]), "ok", [], 1000);
    const events: BoxQueueConsumption[] = [{ category: "common", count: 1 }];
    const snap = s.advance(
      rawQueue([{ eboxType: 0, items: [1, 2, 3] }]), // same snapKey
      "ok",
      events,
      2000,
    );
    expect(snap.common.map((i) => i.itemKey)).toEqual([2, 3]);
  });

  it("preserves predicted queues when the scan fails (status != ok)", () => {
    const s = new BoxQueueState();
    s.advance(rawQueue([{ eboxType: 0, items: [1, 2] }]), "ok", [], 1000);
    // Next tick: scan failed → rawQueue=null, status="instance_lost".
    const snap = s.advance(null, "instance_lost", [], 2000);
    expect(snap.status).toBe("instance_lost");
    // Predicted queues are preserved (UI stays stable).
    expect(snap.common.map((i) => i.itemKey)).toEqual([1, 2]);
  });

  it("applies consumption even when the scan fails (player opened chests)", () => {
    const s = new BoxQueueState();
    s.advance(rawQueue([{ eboxType: 0, items: [1, 2, 3] }]), "ok", [], 1000);
    // Player opens 1 chest + scan fails this tick.
    const snap = s.advance(null, "instance_lost", [{ category: "common", count: 1 }], 2000);
    expect(snap.status).toBe("instance_lost");
    expect(snap.common.map((i) => i.itemKey)).toEqual([2, 3]);
  });

  it("reset() clears all state", () => {
    const s = new BoxQueueState();
    s.advance(rawQueue([{ eboxType: 0, items: [1, 2] }]), "ok", [], 1000);
    s.reset();
    const snap = s.advance(rawQueue([{ eboxType: 0, items: [9] }]), "ok", [], 2000);
    expect(snap.common.map((i) => i.itemKey)).toEqual([9]);
  });

  it("handles consumption across multiple categories simultaneously", () => {
    const s = new BoxQueueState();
    s.advance(
      rawQueue([
        { eboxType: 0, items: [1, 2] },
        { eboxType: 1, items: [10, 11] },
        { eboxType: 2, items: [20] },
      ]),
      "ok",
      [],
      1000,
    );
    const snap = s.advance(
      rawQueue([
        { eboxType: 0, items: [1, 2] },
        { eboxType: 1, items: [10, 11] },
        { eboxType: 2, items: [20] },
      ]),
      "ok",
      [
        { category: "common", count: 1 },
        { category: "rare", count: 2 },
        { category: "act", count: 1 },
      ],
      2000,
    );
    expect(snap.common.map((i) => i.itemKey)).toEqual([2]);
    expect(snap.rare).toEqual([]);
    expect(snap.act).toEqual([]);
  });
});
