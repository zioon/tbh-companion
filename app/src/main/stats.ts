// Builds the Stats payload pushed to the renderer from tracker + last snapshot.

import type { LiveMemorySnapshot, Stats, SaveSnapshot } from "../../shared/types";

import type { LocaleCatalog } from "../core/localeCatalog";
import type {
  BoxOpenTracker,
  BoxOpenPriceResolver,
  BoxOpenAccessoryResolver,
} from "../core/boxOpenTracker";
import type { ChestDropTracker } from "../core/chestDropTracker";
import type { XpTracker } from "../core/tracker";
import type { DpsTracker } from "../core/liveMemory/dpsTracker";

import { heroName } from "../core/heroes";
import { stageName } from "../core/stages";
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
  boxOpenIsAccessory: BoxOpenAccessoryResolver = null,
  boxOpenPointsOverride: Readonly<Record<number, number>> | null = null,
  lootStatus: string | null = null,
  catalog: LocaleCatalog | null = null,
): Stats {
  const liveXp = liveFrame?.connected === true && tracker.xpLiveActive();
  const liveHeroes = liveXp && liveFrame?.heroes && liveFrame.heroes.length > 0;

  const heroes = liveHeroes
    ? liveFrame!.heroes!.map((h) => {
        const key = String(h.heroKey);
        const rate = tracker.heroRate(key);
        return {
          key,
          name: heroName(key, catalog),
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
            name: heroName(h.key, catalog),
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
  // Wave priority: live memory's stageWave (game-internal, most accurate) →
  // DpsTracker's wave-clear estimate (real-time inference from monster counts)
  // → save file's stageWave (last resort).
  //
  // A live stageWave of 0 is NOT adopted: on game builds whose StageManager
  // runtimeWave offset drifted (e.g. v1.01.05 reads a constant 0), trusting
  // that 0 would mask the DpsTracker estimate and the save-derived wave and
  // pin the mini-overlay counter at "0/N". Only the live value > 0 wins.
  //
  // The DpsTracker estimate is consulted REGARDLESS of `liveFrame.connected`:
  // it is driven by monster counts (HP arrays or StageManager alive), so when
  // live wave data is absent/unreliable we still fall back to the monster-
  // count-based wave inference before giving up to the (stale) save value.
  const estimatedWave = dpsTracker.currentWave;
  const stageWave =
    liveFrame?.connected && liveFrame.stageWave != null && liveFrame.stageWave > 0
      ? liveFrame.stageWave
      : estimatedWave > 0
        ? estimatedWave
        : (lastSnap?.stageWave ?? 0);
  const stageWaveTotal =
    liveFrame?.connected && liveFrame.stageWaveTotal != null ? liveFrame.stageWaveTotal : 0;
  // Cap the reported wave at the stage total. The live total (waveAmount) is
  // authoritative for the current run; a DpsTracker estimate that has drifted
  // past it (a missed stage-clear reset lets the counter accumulate across
  // runs) would otherwise display an impossible "30/16". Once the counter
  // passes the total it can only mean the estimate crossed a run boundary that
  // the clear-event reset missed, so clamping to the total keeps the display
  // honest until the next stage clear resets it.
  const reportedWave =
    stageWaveTotal > 0 && stageWave > stageWaveTotal ? stageWaveTotal : stageWave;

  return {
    connected: lastError === null,

    status,

    rollingRate: tracker.rollingRate,

    sessionRate: tracker.sessionRate,

    goldSessionRate: tracker.goldSessionRate,

    goldRate: tracker.goldRollingRate,

    cumulativeGained: tracker.cumulativeGained,

    goldGained: tracker.goldGained,

    elapsed: tracker.elapsed,

    secondsSinceGain: sinceGain,

    secondsSinceRead: sinceRead,

    stageKey,

    stageName: stageName(stageKey, catalog),

    stageWave: reportedWave,

    stageWaveTotal,

    heroes,

    history: tracker.getVisibleHistory(HISTORY_VISIBLE).map((entry) => ({
      ...entry,
      stageName: stageName(entry.stageKey, catalog),
    })),
    chestDrops: chestDropTracker.getStats(tracker.elapsed),
    boxOpens: boxOpenTracker.getStats(
      boxOpenPriceResolver,
      boxOpenIsAccessory,
      boxOpenPointsOverride,
    ),
    lootStatus: lootStatus ?? undefined,

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
