#!/usr/bin/env python3
"""Dump the game's rune tables (`RuneInfoData` / `RuneLevelInfoData`).

Used by the rich-data update flow (`docs/DATA-UPDATE.md` §1.5) to check whether
`data/rune_box_cap.json`, `data/rune_auto_open.json`, `data/rune_wave.json` and
`data/box_types.json` still match the game after an update. These JSON files are
**not** produced by `build_tbh_data.py` — they are hand-maintained from these two
CSV TextAssets, so an update has to be verified manually.

Output is one line per `(RuneKey, LevelKey, Level)` plus a per-STATTYPE summary,
grouped by STATTYPE so a **newly added stat family** (e.g. the v1.2.6
`DropChancePlague*ChestPercent` nodes) is obvious at a glance.

Usage:
  python scripts/dump_rune_tables.py [--game-dir DIR]
"""
from __future__ import annotations

import argparse
import csv
import io
from collections import defaultdict
from pathlib import Path

import UnityPy

DEFAULT_GAME_DIR = r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
REPO = Path(__file__).resolve().parent.parent


def load_tables(game_dir: str, names: list[str]) -> dict[str, list[dict]]:
    env = UnityPy.load(str(Path(game_dir) / "sharedassets0.assets"))
    out: dict[str, list[dict]] = {}
    wanted = set(names)
    for obj in env.objects:
        if obj.type.name != "TextAsset":
            continue
        d = obj.read()
        nm = getattr(d, "m_Name", "") or ""
        if nm not in wanted:
            continue
        raw = d.m_Script
        text = raw.decode("utf-8-sig", errors="replace") if isinstance(raw, bytes) else str(raw)
        out[nm] = list(csv.DictReader(io.StringIO(text.lstrip("\ufeff"))))
    missing = wanted - set(out)
    if missing:
        raise SystemExit(f"TextAsset not found: {sorted(missing)}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-dir", default=DEFAULT_GAME_DIR)
    args = ap.parse_args()

    t = load_tables(args.game_dir, ["RuneInfoData", "RuneLevelInfoData"])
    info, lvl = t["RuneInfoData"], t["RuneLevelInfoData"]

    print("=== RuneInfoData columns ===")
    print(list(info[0].keys()))
    print(f"rows: {len(info)}")
    print("\n=== RuneLevelInfoData columns ===")
    print(list(lvl[0].keys()))
    print(f"rows: {len(lvl)}")

    by_stat: dict[str, list[dict]] = defaultdict(list)
    for r in lvl:
        by_stat[(r.get("STATTYPE") or "").strip()].append(r)

    print("\n=== STATTYPE summary (RuneLevelInfoData) ===")
    for st in sorted(by_stat):
        vals = sorted({r.get("Value") for r in by_stat[st]}, key=lambda v: (len(str(v)), str(v)))
        print(f"  {st}: rows={len(by_stat[st])} values={vals[:12]}")

    print("\n=== rows grouped by STATTYPE ===")
    for st in sorted(by_stat):
        print(f"\n-- {st} --")
        for r in sorted(by_stat[st], key=lambda x: str(x.get("LevelKey"))):
            print(f"  LevelKey={r.get('LevelKey')} Level={r.get('Level')} Value={r.get('Value')}")

    print("\n=== RuneInfoData: RuneKey -> NameKey / LevelDataKey ===")
    extra_cols = [c for c in info[0] if c not in {"RuneKey", "NameKey", "LevelDataKey", "NextRuneKey", "MaxLevel"}]
    for r in sorted(info, key=lambda x: int(x.get("RuneKey") or 0)):
        print(
            f"  RuneKey={r.get('RuneKey')} NameKey={r.get('NameKey')} "
            f"LevelDataKey={r.get('LevelDataKey')} NextRuneKey={r.get('NextRuneKey')} "
            f"MaxLevel={r.get('MaxLevel')} "
            + " ".join(f"{c}={r.get(c)}" for c in extra_cols)
        )


if __name__ == "__main__":
    main()
