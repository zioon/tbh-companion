// Unified record-log tracker.
//
// Merges the three in-memory `LogManager` event buckets — chest drops (GetBox),
// box opens (GetItemWithBoxOpen), stage clears (StageClear) — onto a single
// newest-first list, and persists it long-term. This is the source of truth for
// the "Record" tab and survives session resets and the per-bucket 5000-entry
// in-memory wipeout that caused lost recordings.
//
// Pure: no Electron / fs / React, so it is unit-testable over synthetic feeds.

import type {
  RecordLogEntry,
  RecordLogKind,
  RecordLogStats,
  RecordLogTrackerSnapshot,
} from "../../shared/types";

export interface RecordLogTrackerOptions {
  /** Max archived entries kept in memory and on disk (oldest dropped). */
  capacity?: number;
  /** Newest entries exposed to the renderer in `getStats()`. */
  recentWindow?: number;
}

const DEFAULT_CAPACITY = 10_000;
const DEFAULT_RECENT_WINDOW = 200;

type KindCounts = Record<RecordLogKind, number>;

function emptyCounts(): KindCounts {
  return { drop: 0, open: 0, clear: 0, acquire: 0 };
}

export class RecordLogTracker {
  private entries: RecordLogEntry[] = [];
  private nextSeq = 0;
  private total = 0;
  private byKind: KindCounts = emptyCounts();
  /** Output cache — invalidated on every mutation so 5 Hz `getStats()` is cheap. */
  private cache: RecordLogStats | null = null;
  /**
   * Signatures of every acquire entry ever recorded (`acquireTime|acquireRaw`).
   * Lets the ingestion layer dedupe a re-attach initial full sync against the
   * already-archived backlog (companion restart in the same game session), so
   * the same "获得记录" ring lines are never appended twice. Rebuilt from
   * `entries` in `recomputeCounts` (applySnapshot / reset), so it survives
   * disk restore. Only entries carrying a non-empty `acquireRaw` are indexed.
   */
  private acquireSeen = new Set<string>();
  /**
   * Ring indices (`ringSeq`) of the archived acquire entries. THE re-attach
   * dedupe key: the ring's `[HH:MM]` stamp is rewritten by the game (measured
   * 2026-09-15: the same untouched slot reported 14:07 and later 14:40) and the
   * text repeats verbatim hundreds of times, but the ring index is exact. A
   * re-attach initial batch is deduped by "already archived?" per ring index,
   * which tolerates both mutated stamps and sporadic delivery gaps (a gap's
   * ring index is simply not in the set → the missed line is delivered).
   * Rebuilt from `entries` in `recomputeCounts`; cleared on `reset`.
   */
  private ringSeqSeen = new Set<number>();

  private readonly capacity: number;
  private readonly recentWindow: number;

  constructor(opts: RecordLogTrackerOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.recentWindow = opts.recentWindow ?? DEFAULT_RECENT_WINDOW;
  }

  /**
   * Append one event. Assigns the next `seq`, trims to `capacity` when full, and
   * updates the running counts. `payload` carries the kind-specific fields.
   */
  feed(kind: RecordLogKind, wallTime: number, payload: Partial<RecordLogEntry> = {}): void {
    this.nextSeq += 1;
    const entry: RecordLogEntry = { seq: this.nextSeq, kind, wallTime, ...payload };
    this.entries.push(entry);
    this.total += 1;
    this.byKind[kind] += 1;
    if (kind === "acquire" && typeof entry.acquireRaw === "string" && entry.acquireRaw) {
      this.acquireSeen.add(this.acquireKey(entry.acquireTime, entry.acquireRaw));
      if (typeof entry.ringSeq === "number") this.ringSeqSeen.add(entry.ringSeq);
    }
    if (this.entries.length > this.capacity) {
      const excess = this.entries.length - this.capacity;
      const dropped = this.entries.splice(0, excess); // oldest at the front
      this.total -= dropped.length;
      for (const d of dropped) this.byKind[d.kind] -= 1;
      for (const d of dropped) {
        if (d.kind === "acquire" && d.acquireRaw) {
          this.acquireSeen.delete(this.acquireKey(d.acquireTime, d.acquireRaw));
        }
        if (typeof d.ringSeq === "number") this.ringSeqSeen.delete(d.ringSeq);
      }
    }
    this.cache = null;
  }

  /** Whether an acquire line with this (game-time, raw text) pair is already archived. */
  hasAcquireSignature(time: string | undefined, raw: string | undefined): boolean {
    if (!raw) return false;
    return this.acquireSeen.has(this.acquireKey(time, raw));
  }

  /** Whether an acquire line with this ring index is already archived (the re-attach dedupe key). */
  hasRingSeq(ringSeq: number): boolean {
    return this.ringSeqSeen.has(ringSeq);
  }

  private acquireKey(time: string | undefined, raw: string): string {
    return `${time ?? ""}|${raw}`;
  }

  /** Newest-first window over the log for the renderer. */
  getStats(): RecordLogStats {
    if (this.cache) return this.cache;
    // `sources` is filled in by the main layer's stats builder (the fit needs
    // the event buckets, which this pure tracker does not see) — empty here.
    this.cache = {
      entries: this.entries.slice(-this.recentWindow).reverse(),
      total: this.total,
      byKind: { ...this.byKind },
      nextSeq: this.nextSeq,
      sources: {},
    };
    return this.cache;
  }

  /**
   * One archived page, newest-first, for the record panel's pagination.
   * Page 0 is the newest `pageSize` entries — identical to the `getStats()`
   * window when `pageSize === recentWindow`; page N walks further back in
   * time. The slice spans ALL kinds (the same series `getStats()` exposes),
   * so the renderer's per-kind filtering stays consistent across pages.
   * Returns `total` (the live archive count) so the renderer can size the
   * page bar even while paging a static snapshot.
   */
  getPage(page: number, pageSize: number): { entries: RecordLogEntry[]; total: number } {
    const size = Math.max(1, Math.floor(pageSize));
    const safePage = Math.max(0, Math.floor(page));
    const end = this.entries.length - safePage * size;
    if (end <= 0) return { entries: [], total: this.total };
    const start = Math.max(0, end - size);
    return { entries: this.entries.slice(start, end).reverse(), total: this.total };
  }

  /** Full durable snapshot for `record_log.json`. */
  snapshot(): RecordLogTrackerSnapshot {
    return { nextSeq: this.nextSeq, entries: this.entries.slice() };
  }

  /**
   * Restore from a persisted snapshot. Merges by `seq` (dedupes a partial overlap
   * after a crash, never double-records), advances `nextSeq` past the max seen,
   * and re-trims to `capacity`.
   */
  applySnapshot(snap: RecordLogTrackerSnapshot | null | undefined): void {
    if (!snap || !Array.isArray(snap.entries)) return;
    const merged = new Map<number, RecordLogEntry>(this.entries.map((e) => [e.seq, e]));
    let maxSeq = this.nextSeq;
    for (const e of snap.entries) {
      if (e == null || typeof e.seq !== "number") continue;
      merged.set(e.seq, e);
      if (e.seq > maxSeq) maxSeq = e.seq;
    }
    this.nextSeq = maxSeq;
    this.entries = [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-this.capacity);
    this.recomputeCounts();
  }

  /** Drop everything (used by Settings → clear record log / all-except-config). */
  reset(): void {
    this.entries = [];
    this.nextSeq = 0;
    this.recomputeCounts();
  }

  private recomputeCounts(): void {
    const byKind = emptyCounts();
    const seen = new Set<string>();
    const ringSeqs = new Set<number>();
    for (const e of this.entries) {
      byKind[e.kind] += 1;
      if (e.kind === "acquire" && e.acquireRaw) {
        seen.add(this.acquireKey(e.acquireTime, e.acquireRaw));
      }
      if (typeof e.ringSeq === "number") ringSeqs.add(e.ringSeq);
    }
    this.byKind = byKind;
    this.total = this.entries.length;
    this.acquireSeen = seen;
    this.ringSeqSeen = ringSeqs;
    this.cache = null;
  }
}
