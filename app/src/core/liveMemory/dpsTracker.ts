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
  peakDps = 0;
  /** Session-cumulative mobs killed (never resets). */
  sessionMobsKilled = 0;
  private lastDeadCount: number | null = null;

  // Address-keyed HP map (tbh-meter approach): monster addr -> last hpCurrent
  private lastHp: Map<number, number> = new Map();

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
  private _pendingMapReset: { delayUntil: number; damageBase: number; killsBase: number } | null = null;
  private static readonly MAP_RESET_DELAY_SECONDS = 3;

  // Aggregated HP from the last tick
  private _hpSum = 0;
  private _hpMaxSum = 0;

  // Wave tracking: detect wave clears (alive: had monsters → 0 → monsters again)
  // Each clear increments wavesCleared; current wave = wavesCleared + (alive > 0 ? 1 : 0)
  private _wavesCleared = 0;
  private _wasAlive = false;

  constructor(windowSeconds = 5) {
    this.windowSeconds = windowSeconds;
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

    // Calculate damage using address-based matching (tbh-meter approach)
    const current: Map<number, number> = new Map();
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

    // Monsters gone since the previous tick = died → account remaining HP as killing blow
    for (const [addr, prevHp] of this.lastHp) {
      if (!current.has(addr) && prevHp > 0) {
        damageThisFrame += prevHp;
      }
    }

    this.lastHp = current;

    if (damageThisFrame > 0 && Number.isFinite(damageThisFrame)) {
      this.damageSamples.push([timestamp, damageThisFrame]);
      this.sessionDamage += damageThisFrame;

      if (this.dps > this.peakDps) {
        this.peakDps = this.dps;
      }
    }

    // Track mob kills from dead monster count delta
    if (deadMonsterCount != null) {
      if (this.lastDeadCount != null) {
        const delta = deadMonsterCount - this.lastDeadCount;
        if (delta > 0 && delta < 1000) {
          this.sessionMobsKilled += delta;
          this.killTotal += delta;
          this.killSamples.push([timestamp, this.killTotal]);

          // Prune samples outside the 60s KPM window
          const kpmCutoff = timestamp - DpsTracker.KPM_WINDOW_SECONDS;
          while (this.killSamples.length > 2 && this.killSamples[0][0] < kpmCutoff) {
            this.killSamples.shift();
          }
        }
      }
      this.lastDeadCount = deadMonsterCount;
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
   *  zeroes out. The actual reset happens inside update() once the delay expires. */
  beginMap(): void {
    this._wavesCleared = 0;
    this._wasAlive = false;
    this._pendingMapReset = {
      delayUntil: (Date.now() / 1000) + DpsTracker.MAP_RESET_DELAY_SECONDS,
      damageBase: this.sessionDamage,
      killsBase: this.sessionMobsKilled,
    };
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

  /** Kills Per Minute (KPM) over a 60-second rolling window. */
  get kpm(): number {
    if (this.killSamples.length < 2) return 0;
    const k0 = this.killSamples[0][1];
    const k1 = this.killSamples[this.killSamples.length - 1][1];
    return (k1 - k0) / 1;
  }

  reset(): void {
    this.damageSamples = [];
    this.sessionDamage = 0;
    this.peakDps = 0;
    this.sessionMobsKilled = 0;
    this.lastDeadCount = null;
    this.lastHp.clear();
    this.killSamples = [];
    this.killTotal = 0;
    this._alive = 0;
    this._wavesCleared = 0;
    this._wasAlive = false;
    this._mapDamageBase = 0;
    this._mapKillsBase = 0;
    this._pendingMapReset = null;
    this._hpSum = 0;
    this._hpMaxSum = 0;
  }
}
