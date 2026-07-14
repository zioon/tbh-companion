// Appends every XP-changing event to logs/xp_history.csv (when enabled), so the
// user has a full history beyond what's kept in memory.

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { app } from "electron";
import { stageName } from "../core/stages";
import type { HistoryEntry } from "../../shared/types";

const HEADER = "timestamp,delta,xp_per_hour,total_xp,stage_key,map,wave\n";

function logPath(): string {
  try {
    return join(app.getPath("userData"), "logs", "xp_history.csv");
  } catch {
    return join(process.cwd(), "logs", "xp_history.csv");
  }
}

export function makeHistoryLogger(): (entry: HistoryEntry) => void {
  const path = logPath();
  return (e: HistoryEntry) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) appendFileSync(path, HEADER);
      const ts = new Date(e.wallTime * 1000).toISOString();
      const map = stageName(e.stageKey).replace(/,/g, " ");
      appendFileSync(
        path,
        `${ts},${e.delta},${e.rate.toFixed(2)},${e.totalXp},${e.stageKey},${map},${e.stageWave}\n`,
      );
    } catch {
      // never let logging break tracking
    }
  };
}
