// Damage-per-second tracker using a 5-second rolling window.
// Ported from tbh-meter's DpsTracker concept — uses ADDRESS-BASED monster HP matching
// (matching by memory address, not array index) for accurate frame-by-frame damage.
// Address-based approach is robust to monsters dying mid-list and indices shifting.
// Also tracks monster kill count from dead monster list deltas,
// with per-map counters that reset on stage change.

export class DpsTracker {
  private windowSeconds: number;
  /** Rolling window: [timestamp, damage] pairs */
  private damageSamples: Array<[number, number]> = [];
  /** Session-cumulative damage (never resets). */
  sessionDamage = 0;
  /** Session-cumulative mobs killed (never resets). */
  sessionMobsKilled = 0;
  private lastDeadCount: number | null = null;

  // Address-keyed HP map (tbh-meter approach): monster addr -> last hpCurrent
  // Two maps are swapped each tick to avoid allocating a new Map at 25 Hz.
  private lastHp: Map<number, number> = new Map();
  private hpBuffer: Map<number, number> = new Map();

  // KPM: 60-second rolling window ported from tbh-meter's ProgressTracker
  private static readonly KPM_WINDOW_SECONDS = 60;
  /** Rolling window: [timestamp, kills] pairs */
  private killSamples: Array<[number, number]> = [];
  private killTotal = 0;

  // Per-map counters — reset on stage change via beginMap()
  private _alive = 0;
  /** Snapshot of session-level counters at the start of the current map. */
  private _mapDamageBase = 0;
  private _mapKillsBase = 0;

  /** Pending beginMap() call — delays the per-map reset so the UI can show the
   *  final damage value for a few seconds before it zeroes out. */
  private _pendingMapReset: { delayUntil: number; damageBase: number; killsBase: number } | null =
    null;
  private static readonly MAP_RESET_DELAY_SECONDS = 3;

  // Aggregated HP from the last tick
  private _hpSum = 0;
  private _hpMaxSum = 0;

  // Wave tracking: detect wave clears (alive: had monsters → 0 → monsters again)
  // Each clear increments wavesCleared; current wave = wavesCleared + (alive > 0 ? 1 : 0)
  private _wavesCleared = 0;
  private _wasAlive = false;

  // Stage-end detection from the alive count alone (fallback for missed
  // stage-clear events, see trackStageEndFromAlive). A run's settlement screen
  // keeps alive at 0 for ~1-2s, far longer than a normal wave gap (sub-second,
  // often < 1 reader tick), so a sustained alive=0 marks the run finished and
  // the next run's first monsters reset the wave counter.
  // Run-end threshold. A run's settlement screen keeps alive at 0 for ~1-2s.
  // Raised from 0.5s to 2s (2026-08-25): 0.5s misfired on builds with few
  // monsters per wave (e.g. v1.01.05, 3-monster batches) where the inter-wave
  // gap can exceed 0.5s — every gap was misread as "run ended", resetting
  // _wavesCleared each wave so the UI wave counter bounced between 0 and 1.
  // 2s keeps real settlements (1-2s) detectable while no longer firing on
  // typical sub-second wave gaps.
  private static readonly STAGE_END_ALIVE_ZERO_SEC = 2;
  private lastAliveZeroAt: number | null = null;
  private _stageEnded = false;

  constructor(windowSeconds = 5) {
    this.windowSeconds = windowSeconds;
  }

  /**
   * Detect a run (stage) boundary purely from the alive-monster count.
   *
   * Normal wave gaps see alive drop to 0 for only a fraction of a second
   * (often a single 25Hz tick or less). The settlement screen between runs
   * keeps alive at 0 for ~1-2s. When alive stays 0 past the threshold we mark
   * `stageEnded`; the next time monsters spawn (alive > 0) we reset the wave
   * counter so the new run starts at wave 1. This is the safety net when a
   * stage-clear event is missed by the log tailer (which would otherwise let
   * `_wavesCleared` accumulate across runs, e.g. "30/16").
   */
  private trackStageEndFromAlive(alive: number, timestamp: number): void {
    if (alive === 0) {
      if (this.lastAliveZeroAt == null) this.lastAliveZeroAt = timestamp;
      if (timestamp - this.lastAliveZeroAt >= DpsTracker.STAGE_END_ALIVE_ZERO_SEC) {
        this._stageEnded = true;
      }
    } else {
      if (this._stageEnded) {
        this._wavesCleared = 0;
        this._wasAlive = false;
      }
      this._stageEnded = false;
      this.lastAliveZeroAt = null;
    }
  }

  /**
   * Update with current monster HP data and dead monster count.
   * @param monsterHps - Array of [addr, hpCurrent, hpMax] for all alive monsters
   * @param deadMonsterCount - Current dead monster count from MonsterSpawnManager
   * @param timestamp - Current time in seconds (e.g. Date.now() / 1000)
   */
  update(
    monsterHps: Array<[number, number, number]>,
    deadMonsterCount: number | null,
    timestamp: number,
  ): void {
    const cutoff = timestamp - this.windowSeconds;
    while (this.damageSamples.length > 0 && this.damageSamples[0][0] < cutoff) {
      this.damageSamples.shift();
    }

    // Calculate damage using address-based matching (tbh-meter approach).
    // Reuse the buffer Map (clear + repopulate) instead of allocating a new
    // one every tick — eliminates 25 Map allocations/sec.
    const current = this.hpBuffer;
    current.clear();
    let damageThisFrame = 0;
    let hpSum = 0;
    let hpMaxSum = 0;

    for (const item of monsterHps) {
      const addr = item[0];
      const hpCurrent = item[1];
      const hpMax = item[2];
      if (hpCurrent <= 0) continue;
      current.set(addr, hpCurrent);
      hpSum += hpCurrent;
      hpMaxSum += hpMax;
      const prev = this.lastHp.get(addr);
      if (prev != null && hpCurrent < prev) {
        damageThisFrame += prev - hpCurrent; // HP drop = damage dealt
      }
    }

    this._alive = current.size;
    this._hpSum = hpSum;
    this._hpMaxSum = hpMaxSum;

    // Wave clear detection: monsters existed → 0 → monsters spawn again = new wave
    if (this._wasAlive && this._alive === 0) {
      this._wavesCleared++;
    }
    this._wasAlive = this._alive > 0;
    this.trackStageEndFromAlive(this._alive, timestamp);

    // Monsters gone since the previous tick = died → account remaining HP as
    // killing blow, and count the vanished monsters (a kill-inference fallback
    // for builds whose dead-monster counter is unavailable, see below).
    let vanishedCount = 0;
    for (const [addr, prevHp] of this.lastHp) {
      if (!current.has(addr) && prevHp > 0) {
        damageThisFrame += prevHp;
        vanishedCount++;
      }
    }

    // Swap: the newly-populated map becomes lastHp; the old lastHp becomes
    // the buffer to be cleared and repopulated next tick.
    const tmp = this.lastHp;
    this.lastHp = current;
    this.hpBuffer = tmp;

    if (damageThisFrame > 0 && Number.isFinite(damageThisFrame)) {
      this.damageSamples.push([timestamp, damageThisFrame]);
      this.sessionDamage += damageThisFrame;
    }

    // Track mob kills. Preferred source: the MonsterSpawnManager dead-monster
    // counter delta. Fallback: when that counter is unusable — null, or stuck
    // at 0 while monsters are clearly vanishing (e.g. v1.01.05 where the dead
    // list offset isn't derived) — infer kills from the number of monsters that
    // disappeared from the alive list this tick (wave transitions vanish the
    // whole wave = those monsters were killed, so the count is accurate).
    if (deadMonsterCount != null) {
      if (this.lastDeadCount != null) {
        const delta = deadMonsterCount - this.lastDeadCount;
        if (delta > 0 && delta < 1000) {
          this.recordKills(delta, timestamp);
        } else if (vanishedCount > 0 && deadMonsterCount === 0) {
          // Dead counter stuck at 0 while monsters vanish → offset not derived
          // (v1.01.05 signature). Infer kills from the alive-list delta.
          this.recordKills(vanishedCount, timestamp);
        }
      }
      this.lastDeadCount = deadMonsterCount;
    } else if (vanishedCount > 0) {
      // No dead counter at all — infer kills from vanished monsters.
      this.recordKills(vanishedCount, timestamp);
    }

    // Apply pending map reset after the delay period
    if (this._pendingMapReset != null && timestamp >= this._pendingMapReset.delayUntil) {
      this._mapDamageBase = this._pendingMapReset.damageBase;
      this._mapKillsBase = this._pendingMapReset.killsBase;
      this._pendingMapReset = null;
    }
  }

  /** Called when entering a new map (stage). Defers the per-map counter reset
   *  by a few seconds so the UI can display the final damage value before it
   *  zeroes out. The actual reset happens inside update() once the delay expires.
   *  Optional `timestamp` lets callers inject the same clock used for `update`
   *  (snap.at / 1000) — defaults to `Date.now()/1000` for back-compat. */
  beginMap(timestamp: number = Date.now() / 1000): void {
    this._wavesCleared = 0;
    this._wasAlive = false;
    this.lastAliveZeroAt = null;
    this._stageEnded = false;
    this._pendingMapReset = {
      delayUntil: timestamp + DpsTracker.MAP_RESET_DELAY_SECONDS,
      damageBase: this.sessionDamage,
      killsBase: this.sessionMobsKilled,
    };
  }

  /**
   * Record `n` monster kills at `timestamp`: bump the session/map/killTotal
   * counters and append a KPM sample, pruning samples outside the 60s window.
   * Extracted from `update()` so both the dead-counter delta path and the
   * vanished-monster inference path share the same accounting.
   */
  private recordKills(n: number, timestamp: number): void {
    this.sessionMobsKilled += n;
    this.killTotal += n;
    this.killSamples.push([timestamp, this.killTotal]);

    // Prune samples outside the 60s KPM window. Use `> 1` (not `> 2`)
    // so the window keeps exactly one boundary sample at each end —
    // keeping two old samples left the boundary sample stuck forever
    // once the array shrank to length 2, making KPM span hours.
    const kpmCutoff = timestamp - DpsTracker.KPM_WINDOW_SECONDS;
    while (this.killSamples.length > 1 && this.killSamples[0][0] < kpmCutoff) {
      this.killSamples.shift();
    }
  }

  /**
   * Mark the current run as over (e.g. the deployed party withdrew after a
   * clear or a defeat). The wave counter is reset immediately so the next run
   * starts at wave 1 again — independent of the alive-based stage-end fallback
   * (`trackStageEndFromAlive`), which only fires after alive stays 0 past
   * {@link STAGE_END_ALIVE_ZERO_SEC} and therefore misses fast auto-retries.
   * Unlike {@link beginMap}, the delayed per-map damage/kill reset is NOT
   * touched here, so the UI can still show this run's final damage while it
   * settles.
   */
  onRunEnd(): void {
    this._wavesCleared = 0;
    this._wasAlive = false;
    this.lastAliveZeroAt = null;
    this._stageEnded = false;
  }

  /**
   * Feed only an alive-monster count when HP data is unavailable (e.g. builds
   * whose monster-HP offsets aren't derived, like v1.01.05). This keeps
   * wave-clear detection alive so {@link currentWave} still advances in real
   * time; DPS/damage stats stay at their last `update()` values (0 on such
   * builds). Mirrors the alive/wave portion of {@link update}.
   */
  updateAlive(alive: number, timestamp: number): void {
    this._alive = alive;
    if (this._wasAlive && this._alive === 0) {
      this._wavesCleared++;
    }
    this._wasAlive = this._alive > 0;
    this.trackStageEndFromAlive(alive, timestamp);
  }

  /** Number of currently alive monsters (from the last tick). */
  get alive(): number {
    return this._alive;
  }

  /** Estimated current wave based on wave-clear detection. 0 means no data yet. */
  get currentWave(): number {
    if (!this._wasAlive && this._wavesCleared === 0) return 0; // no battle started
    return this._wavesCleared + (this._alive > 0 ? 1 : 0);
  }

  /** Damage dealt on the current map (session total since last beginMap). */
  get mapDamage(): number {
    return this.sessionDamage - this._mapDamageBase;
  }

  /** Mobs killed on the current map (session total since last beginMap). */
  get mapMobsKilled(): number {
    return this.sessionMobsKilled - this._mapKillsBase;
  }

  /** Sum of current HP of all alive monsters (from the last tick). */
  get hpSum(): number {
    return this._hpSum;
  }

  /** Sum of max HP of all alive monsters (from the last tick). */
  get hpMaxSum(): number {
    return this._hpMaxSum;
  }

  /** Current DPS (average over rolling window). */
  get dps(): number {
    if (this.damageSamples.length === 0) return 0;
    const total = this.damageSamples.reduce((sum, [, d]) => sum + d, 0);
    return total / this.windowSeconds;
  }

  /** Kills Per Minute (KPM) over a 60-second rolling window.
   *  Computed as (kills_in_window / window_span_seconds) * 60 — previously
   *  this divided by 1 (returning raw kill count), which only happened to be
   *  right when the window was exactly 60s long. For shorter windows it
   *  drastically understated the rate. */
  get kpm(): number {
    if (this.killSamples.length < 2) return 0;
    const [t0, k0] = this.killSamples[0];
    const [t1, k1] = this.killSamples[this.killSamples.length - 1];
    const dt = t1 - t0;
    if (dt <= 0) return 0;
    return ((k1 - k0) / dt) * 60;
  }

  reset(): void {
    this.damageSamples = [];
    this.sessionDamage = 0;
    this.sessionMobsKilled = 0;
    this.lastDeadCount = null;
    this.lastHp.clear();
    this.hpBuffer.clear();
    this.killSamples = [];
    this.killTotal = 0;
    this._alive = 0;
    this._wavesCleared = 0;
    this._wasAlive = false;
    this.lastAliveZeroAt = null;
    this._stageEnded = false;
    this._mapDamageBase = 0;
    this._mapKillsBase = 0;
    this._pendingMapReset = null;
    this._hpSum = 0;
    this._hpMaxSum = 0;
  }
}
