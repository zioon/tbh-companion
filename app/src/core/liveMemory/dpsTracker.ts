// Damage-per-second tracker using a 5-second rolling window.
// Ported from tbh-meter's DpsTracker concept.
// Tracks monster HP changes between frames to calculate DPS and total damage.
// Also tracks monster kill count from dead monster list deltas.

export class DpsTracker {
  private windowSeconds: number;
  /** Rolling window: [timestamp, damage] pairs */
  private damageSamples: Array<[number, number]> = [];
  totalDamage = 0;
  peakDps = 0;
  totalMobsKilled = 0;
  private lastDeadCount: number | null = null;

  constructor(windowSeconds = 5) {
    this.windowSeconds = windowSeconds;
  }

  /**
   * Update with current monster HP data and dead monster count.
   * @param monsterHps - Array of [currentHp, maxHp] for all alive monsters
   * @param deadMonsterCount - Current dead monster count from MonsterSpawnManager
   * @param timestamp - Current time in seconds (e.g. Date.now() / 1000)
   */
  update(_monsterHps: Array<[number, number]>, deadMonsterCount: number | null, timestamp: number): void {
    const cutoff = timestamp - this.windowSeconds;
    while (this.damageSamples.length > 0 && this.damageSamples[0][0] < cutoff) {
      this.damageSamples.shift();
    }

    // Track mob kills from dead monster count delta
    if (deadMonsterCount != null) {
      if (this.lastDeadCount != null) {
        const delta = deadMonsterCount - this.lastDeadCount;
        if (delta > 0 && delta < 1000) {
          this.totalMobsKilled += delta;
        }
      }
      this.lastDeadCount = deadMonsterCount;
    }
  }

  /**
   * Record a frame of monster HP data for damage calculation.
   * @param currentHps - Current frame's monster HP data
   * @param previousHps - Previous frame's monster HP data
   * @param timestamp - Current time in seconds
   */
  recordDamageFrame(
    currentHps: Array<[number, number]>,
    previousHps: Array<[number, number]> | null,
    timestamp: number,
  ): void {
    if (!previousHps || previousHps.length === 0) return;

    // Calculate damage dealt this frame: sum of HP decreases
    let damageThisFrame = 0;

    // Match monsters by index position (simplified approach)
    const minLen = Math.min(previousHps.length, currentHps.length);
    for (let i = 0; i < minLen; i++) {
      const prevHp = previousHps[i][0];
      const currHp = currentHps[i][0];
      if (prevHp > 0 && currHp >= 0 && currHp < prevHp) {
        damageThisFrame += prevHp - currHp;
      }
    }

    // Monsters that disappeared from the list (died) — count remaining HP as damage
    if (currentHps.length < previousHps.length) {
      for (let i = currentHps.length; i < previousHps.length; i++) {
        const prevHp = previousHps[i][0];
        if (prevHp > 0) {
          damageThisFrame += prevHp;
        }
      }
    }

    if (damageThisFrame > 0 && Number.isFinite(damageThisFrame)) {
      this.damageSamples.push([timestamp, damageThisFrame]);
      this.totalDamage += damageThisFrame;

      if (this.dps > this.peakDps) {
        this.peakDps = this.dps;
      }
    }
  }

  /** Current DPS (average over rolling window). */
  get dps(): number {
    if (this.damageSamples.length === 0) return 0;
    const total = this.damageSamples.reduce((sum, [, d]) => sum + d, 0);
    return total / this.windowSeconds;
  }

  reset(): void {
    this.damageSamples = [];
    this.totalDamage = 0;
    this.peakDps = 0;
    this.totalMobsKilled = 0;
    this.lastDeadCount = null;
  }
}
