"""从游戏数据生成 data/rune_drop_chance.json（管道外的独立脚本，仿 dump_rune_tables.py 的定位）。"""
import csv
import io
import json
from collections import defaultdict
from pathlib import Path

import UnityPy

GAME_DIR = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data")
REPO = Path(r"D:\Project\TBH\tbh-companion")

env = UnityPy.load(str(GAME_DIR / "sharedassets0.assets"))
tables = {}
for obj in env.objects:
    if obj.type.name != "TextAsset":
        continue
    d = obj.read()
    nm = getattr(d, "m_Name", "") or ""
    raw = d.m_Script
    text = raw.decode("utf-8-sig", errors="replace") if isinstance(raw, bytes) else str(raw)
    tables[nm] = list(csv.DictReader(io.StringIO(text.lstrip("\ufeff"))))

info = tables["RuneInfoData"]
lvl = tables["RuneLevelInfoData"]

# 真实 STATTYPE（按 LevelDataKey 反查）
stat_of_levelkey = defaultdict(set)
for r in lvl:
    stat_of_levelkey[str(r.get("LevelKey"))].add((r.get("STATTYPE") or "").strip())

# 每 (stat, levelKey) → {level: value}。一个节点的各 level 共用同一个
# LevelDataKey（= LevelKey），所以「该节点每级同值」= 该 LevelKey 下各 level
# 的 Value 集合只有一个元素。
levels_of = defaultdict(dict)
for r in lvl:
    levels_of[((r.get("STATTYPE") or "").strip(), str(r.get("LevelKey")))][
        str(r.get("Level"))
    ] = r.get("Value")

# NameKey → 展示名（RuneName_*）
name_of = {str(r.get("RuneKey")): (r.get("NameKey") or "").replace("RuneName_", "") for r in info}

CATS = {
    "DropChanceNormalChestPercent": "common",
    "DropChanceStageBossChestPercent": "stageBoss",
    "DropChancePlagueNormalChestPercent": "plagueCommon",
    "DropChancePlagueStageBossChestPercent": "plagueRare",
}
CAT_LABEL_KEY = {
    "common": "RuneName_DropChanceNormalChest",
    "stageBoss": "RuneName_DropChanceStageBossChest",
    "plagueCommon": "RuneName_DropChancePlagueNormalChestPercent",
    "plagueRare": "RuneName_DropChancePlagueStageBossChestPercent",
}

# 英文原文（runeLabel 用英文，与其余 rune_*.json 一致）
LOCALE_EN = json.loads(
    (REPO / "data" / "_game_locale_dump.json").read_text(encoding="utf-8")
)["en"]

out_cats = {}
for stat, cat in CATS.items():
    per_level = {}
    labels = set()
    for r in info:
        lk = str(r.get("LevelDataKey"))
        if stat not in stat_of_levelkey.get(lk, set()):
            continue
        rk = str(r.get("RuneKey"))
        levels = levels_of.get((stat, lk), {})
        if not levels:
            continue
        values = {v for v in levels.values() if v is not None}
        if len(values) != 1:
            raise SystemExit(f"节点 {rk} 的每级值不一致: {values}")
        per_level[rk] = int(next(iter(values)))
        labels.add(name_of.get(rk, ""))
    if not per_level:
        continue
    # runeLabel 用**英文游戏原文**（与 rune_box_cap.json / rune_auto_open.json
    # 的口径一致：那边是 "Rune of Containment" 这类英文名），不是 locale key。
    label_key = CAT_LABEL_KEY[cat]
    out_cats[cat] = {
        "runeLabel": LOCALE_EN.get(label_key, label_key),
        "perLevelPercent": dict(sorted(per_level.items(), key=lambda kv: int(kv[0]))),
    }
    print(f"{cat}: {len(per_level)} 节点, labels={labels}")

payload = {
    **out_cats,
    "note": (
        "Drop chance runes (RuneInfoData NameKey 'DropChance*'). The game stores their stat under the "
        "'DropChance*Percent' STATTYPE: a per-level drop-chance MULTIPLIER percent "
        "(AccountStat_DropChance*Percent = '{0}% Increased ... Drop Chance Multiplier'). Every level of a "
        "node carries the same value, so the total bonus is sum(level x perLevelPercent) over purchased "
        "nodes, exactly like the other rune families. The sibling AccountStat_DropChance* keys "
        "('+{0}%', no Percent suffix) are the flat additive variant and are NOT what these runes grant."
    ),
}

out_path = REPO / "data" / "rune_drop_chance.json"
with open(out_path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("wrote", out_path)
