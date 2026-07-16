// Builds the Stats payload pushed to the renderer from tracker + last snapshot.

import type { LiveMemorySnapshot, Stats, SaveSnapshot } from "../../shared/types";

import type { BoxOpenTracker, BoxOpenPriceResolver } from "../core/boxOpenTracker";
import type { ChestDropTracker } from "../core/chestDropTracker";
import type { XpTracker } from "../core/tracker";
import type { DpsTracker } from "../core/liveMemory/dpsTracker";

import { heroName } from "../core/heroes";
import { xpForNextLevel } from "../core/levelCurve";

const IDLE_THRESHOLD_SECONDS = 120;

const HISTORY_VISIBLE = 50;

function nowSeconds(): number {
  return Date.now() / 1000;
}

function heroLevelEstimate(
  level: number,
  exp: number,
  rate: number,
): {
  xpToNextLevel: number | null;
  timeToLevelSec: number | null;
} {
  const fullNeeded = xpForNextLevel(level);
  if (fullNeeded === null) return { xpToNextLevel: null, timeToLevelSec: null };
  const remaining = Math.max(0, fullNeeded - exp);
  if (!Number.isFinite(rate) || rate <= 0)
    return { xpToNextLevel: remaining, timeToLevelSec: null };
  const timeSec = (remaining / rate) * 3600;
  return {
    xpToNextLevel: remaining,
    timeToLevelSec: Number.isFinite(timeSec) ? timeSec : null,
  };
}

export function buildStats(
  tracker: XpTracker,
  chestDropTracker: ChestDropTracker,
  boxOpenTracker: BoxOpenTracker,
  dpsTracker: DpsTracker,
  lastSnap: SaveSnapshot | null,
  lastError: string | null,
  statusOverride: string | null = null,
  liveFrame: LiveMemorySnapshot | null = null,
  boxOpenPriceResolver: BoxOpenPriceResolver = null,
): Stats {
  const liveXp = liveFrame?.connected === true && tracker.xpLiveActive();
  const liveHeroes = liveXp && liveFrame?.heroes && liveFrame.heroes.length > 0;

  const heroes = liveHeroes
    ? liveFrame!.heroes!.map((h) => {
        const key = String(h.heroKey);
        const rate = tracker.heroRate(key);
        return {
          key,
          name: heroName(key),
          level: h.level,
          rate,
          ...heroLevelEstimate(h.level, h.exp, rate),
        };
      })
    : (lastSnap?.heroes ?? tracker.heroes)
        .filter((h) => h.unlocked || h.exp > 0)
        .map((h) => {
          const rate = tracker.heroRate(h.key);
          return {
            key: h.key,
            name: heroName(h.key),
            level: h.level,
            rate,
            ...heroLevelEstimate(h.level, h.exp, rate),
          };
        });

  const sinceGain = tracker.secondsSinceGain;

  // Age of the save file content (game write time), not our poll clock.
  const sinceRead = lastSnap ? nowSeconds() - lastSnap.saveMtime : null;

  let status: string;

  if (statusOverride) {
    status = statusOverride;
  } else if (lastError) {
    status = lastError;
  } else if (sinceGain === null) {
    status = "Tracking";
  } else if (sinceGain > IDLE_THRESHOLD_SECONDS) {
    status = `No XP gained for ${Math.round(sinceGain)}s - is the game running?`;
  } else {
    status = "Tracking";
  }

  const stageKey =
    liveFrame?.connected && liveFrame.stageKey != null
      ? liveFrame.stageKey
      : (lastSnap?.stageKey ?? 0);
  // Use DPS tracker's wave-clear detection when live memory is active, else use save value
  const estimatedWave = liveFrame?.connected ? dpsTracker.currentWave : 0;
  const stageWave = estimatedWave > 0 ? estimatedWave : (lastSnap?.stageWave ?? 0);
  const stageWaveTotal =
    liveFrame?.connected && liveFrame.stageWaveTotal != null ? liveFrame.stageWaveTotal : 0;

  return {
    connected: lastError === null,

    status,

    rollingRate: tracker.rollingRate,

    sessionRate: tracker.sessionRate,

    goldRate: tracker.goldRollingRate,

    cumulativeGained: tracker.cumulativeGained,

    goldGained: tracker.goldGained,

    elapsed: tracker.elapsed,

    secondsSinceGain: sinceGain,

    secondsSinceRead: sinceRead,

    stageKey,

    stageWave,

    stageWaveTotal,

    heroes,

    history: tracker.getVisibleHistory(HISTORY_VISIBLE),
    chestDrops: chestDropTracker.getStats(tracker.elapsed),
    boxOpens: boxOpenTracker.getStats(tracker.elapsed, boxOpenPriceResolver),

    // DPS / Damage / Mobs / HP
    dps: dpsTracker.dps,
    mapDamage: dpsTracker.mapDamage,
    mapMobsKilled: dpsTracker.mapMobsKilled,
    sessionDamage: dpsTracker.sessionDamage,
    sessionMobsKilled: dpsTracker.sessionMobsKilled,
    aliveMonsters: dpsTracker.alive,
    hpSum: dpsTracker.hpSum,
    hpMaxSum: dpsTracker.hpMaxSum,
  };
}
