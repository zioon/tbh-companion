#!/usr/bin/env python3
"""build_tbh_data.py — local tbh-data pipeline (v1)

Extracts and regenerates the bundled rich data from the game install:
  data/gamedata.json          (item base catalog)
  data/lookup_items.json      (stats, gearGroups, iconPath)
  data/lookup_sources.json    (box/stage/item drop graph, crafting, usedIn)
  data/synthesis_model.json   (grade weights, recipes by type, drop buckets)
  data/offerings.json         (coin offering drop tables)
  data/stage_boxes.json       (STAGEBOX catalog + tracker metadata)

Requires: game install dir (sharedassets0.assets), and
  data/_game_locale_dump.json (from scripts/dump_game_locale.py) for name and
  stat-template resolution.

Rule extraction: when the existing data/ files are present (oracle), derived
rules (stat display divisors, crafting tier→level, synthesis materialAvgLevel)
are extracted from them so regeneration matches the previous output format.
Use --no-oracle to skip (falls back to defaults).

Usage:
  python scripts/build_tbh_data.py [--game-dir DIR] [--out DIR] [--no-oracle]
"""
from __future__ import annotations

import argparse
import csv
import datetime
import io
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import UnityPy

DEFAULT_GAME_DIR = r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data"
REPO = Path(__file__).resolve().parent.parent

# box prefix -> (box category, drop via)
BOX_910 = "common", "monster_box"
BOX_920 = "stage_boss", "boss_box"
BOX_930 = "act_boss", "act_boss"


def category_via_for(box_key: int) -> tuple[str, str] | None:
    if 910000 <= box_key <= 919999:
        return BOX_910
    if 920000 <= box_key <= 929999:
        return BOX_920
    if 930000 <= box_key <= 939999:
        return BOX_930
    return None


class GameTables:
    """Lazy-loaded CSV tables from sharedassets0.assets."""

    def __init__(self, game_dir: str):
        self.env = UnityPy.load(str(Path(game_dir) / "sharedassets0.assets"))
        self._cache: dict[str, list[dict]] = {}

    def table(self, name: str) -> list[dict]:
        if name in self._cache:
            return self._cache[name]
        for obj in self.env.objects:
            if obj.type.name != "TextAsset":
                continue
            d = obj.read()
            if (getattr(d, "m_Name", "") or "") != name:
                continue
            raw = d.m_Script
            text = raw.decode("utf-8-sig", errors="replace") if isinstance(raw, bytes) else str(raw)
            rows = list(csv.DictReader(io.StringIO(text.lstrip("\ufeff"))))
            self._cache[name] = rows
            return rows
        raise SystemExit(f"TextAsset {name} not found in sharedassets0.assets")


def fmt_pct(v: float) -> float:
    """Percent with 4-decimal rounding, matching bundled output."""
    return round(v, 4)


class Locale:
    def __init__(self, dump_path: Path):
        d = json.loads(dump_path.read_text(encoding="utf-8-sig"))
        self.locales: dict[str, dict[str, str]] = d.get("locales", d)
        self.en = self.locales.get("en", {})

    def t(self, key: str) -> str | None:
        if not key:
            return None
        v = self.en.get(key)
        if v is None:
            v = self.en.get(f"ItemName_{key}")
        return v if v is not None else None

    def stat_template(self, stat: str, mod: str, minmax: bool = False) -> str | None:
        key = f"Stat_{stat}_{mod}" + ("_MinMax" if minmax else "")
        return self.en.get(key)

    def base_stat_name(self, stat: str) -> str | None:
        return self.en.get(f"BaseStatName_{stat}") or self.en.get(f"StatName_{stat}")

    def stage_name(self, stage_key: str) -> str:
        return self.en.get(f"StageName_{stage_key}") or f"Stage {stage_key}"

    def item_name(self, item_key: str, name_key: str) -> str:
        nk = (name_key or "").strip()
        if nk and not nk.startswith("ItemName_"):
            return nk
        m = re.match(r"^ItemName_(\d+)$", nk)
        if m:
            return self.en.get(nk) or f"#{m.group(1)}"
        return f"#{item_key}"


def load_existing(name: str) -> list | dict | None:
    p = REPO / "data" / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8-sig"))
    except Exception:
        return None


def extract_stat_formats(existing_items: list | None, base_names: dict[str, str]) -> dict[str, dict]:
    """{stat: {divisor, decimals, prefix, suffix}} learned from previous base rows."""
    from collections import Counter
    cand: dict[str, list] = defaultdict(list)
    if not existing_items:
        return {}
    for it in existing_items:
        st = it.get("stats") or {}
        for row in st.get("base", []):
            name = base_names.get(row["stat"])
            if not name or not isinstance(row["display"], str):
                continue
            rest = row["display"][len(name):].strip()
            m = re.match(r"^(?P<pre>[+\-]?)(?P<num>\d+(?:\.\d+)?)(?P<suf>.*)$", rest)
            if not m or not isinstance(row.get("value"), (int, float)) or not row["value"]:
                continue
            num = float(m.group("num"))
            divisor = row["value"] / num
            frac = len(m.group("num").split(".")[1]) if "." in m.group("num") else 0
            cand[row["stat"]].append((divisor, frac, m.group("pre"), m.group("suf")))
    out = {}
    for stat, entries in cand.items():
        if not entries:
            continue
        div = Counter(round(e[0], 6) for e in entries).most_common(1)[0][0]
        dec = Counter(e[1] for e in entries).most_common(1)[0][0]
        pre = Counter(e[2] for e in entries).most_common(1)[0][0]
        suf = Counter(e[3] for e in entries).most_common(1)[0][0]
        out[stat] = {"divisor": div, "decimals": dec, "prefix": pre, "suffix": suf}
    return out


def default_divisor(stat: str, mod: str) -> float:
    # percentage-scaled modifier types always display raw/10
    if mod in ("ADDITIVE", "MULTIPLICATIVE"):
        return 10.0
    if stat == "HpRegenPerSec":
        return 100.0
    if "Percent" in stat or stat in ("AreaOfEffect", "BlockChance", "CriticalChance",
                                     "CriticalDamage", "CooldownReduction", "DodgeChance",
                                     "AllElementalResistance", "DamageReduction",
                                     "HpRegenPerSec", "IncreaseExpAmount",
                                     "MovementSpeed", "CastSpeed", "SkillHealIncrease",
                                     "SkillRangeExpansion", "SkillDurationIncrease",
                                     "IncreaseAreaOfEffectDamage", "IncreaseMeleeDamage",
                                     "IncreaseProjectileDamage", "IncreaseSummonDamage",
                                     "FireDamagePercent", "ColdDamagePercent",
                                     "LightningDamagePercent", "PhysicalDamagePercent",
                                     "DamageReduction", "LifeLeech", "LifeLeechPercent",
                                     "HpLeech"):
        return 10.0
    return 1.0


def extract_crafting_tier_level(existing_sources: dict | None) -> dict[tuple[str, int], list[int]]:
    table: dict[tuple[str, int], list[int]] = {}
    if not existing_sources:
        return table
    for v in existing_sources.get("items", {}).values():
        for c in v.get("crafting") or []:
            key = (c["craftingType"], int(c["tier"]))
            table[key] = [c["level"]["min"], c["level"]["max"]]
    return table


def default_tier_level(crafting_type: str, tier: int) -> list[int]:
    base = {1: [1, 10], 2: [10, 20], 3: [20, 30], 4: [30, 40],
            5: [40, 40], 6: [50, 65], 7: [65, 80], 8: [80, 80]}
    return base.get(tier, [tier * 10 - 9, tier * 10])


def extract_material_avg_level(existing_syn: dict | None) -> dict[tuple[str, int, str, int], list[int]]:
    """(type, tier, grade, minMaterialAverageLevel) -> [min, max] learned from the
    previous synthesis_model. A single (type, tier, grade) can carry multiple
    recipes with different material-average bands, so the level is part of the key."""
    table: dict[tuple[str, int, str, int], list[int]] = {}
    if not existing_syn:
        return table
    for typ, recipes in existing_syn.get("recipesByType", {}).items():
        for r in recipes:
            key = (typ, int(r["recipeTier"]), r["inputGrade"], int(r["minMaterialAverageLevel"]))
            table[key] = [r["materialAvgLevelMin"], r["materialAvgLevelMax"]]
    return table


class Builder:
    def __init__(self, game_dir: str, out_dir: Path, use_oracle: bool):
        self.t = GameTables(game_dir)
        self.locale = Locale(REPO / "data" / "_game_locale_dump.json")
        self.out = out_dir
        self.game_version = "1.2.2"

        self.items = self.t.table("ItemInfoData")
        self.gear = {r["GearKey"]: r for r in self.t.table("GearInfoData")}
        self.gtypes = {r["GearType"]: r for r in self.t.table("GearTypeInfoData")}
        self.mats = {r["ItemKey"]: r for r in self.t.table("MaterialInfoData")}
        self.smgs = self.t.table("StatModGroupInfoData")
        self.sms = self.t.table("StatModInfoData")
        self.unique_mods = {r["UniqueModKey"]: r for r in self.t.table("UniqueModInfoData")}
        # 技能键集合：用于把 unique 参数里的 Divided 数值判定为"技能名引用"
        self.skill_keys = {str(r.get("SkillKey") or "").strip() for r in self.t.table("SkillInfoData")}
        # 唯一效果里会被引用的英雄：英雄key -> class key（对齐渲染端 HERO_ID_TO_CLASS）
        self.hero_class = {"601": "Slayer"}
        self.stages = self.t.table("StageInfoData")
        self.monsters = {r["MonsterKey"]: r for r in self.t.table("MonsterInfoData")}
        self.grades = {r["GRADE"]: r for r in self.t.table("GradeInfoData")}
        self.crafting = self.t.table("CraftingRecipeInfoData")
        self.synth_recipes = self.t.table("SynthesisRecipeInfoData")
        self.synth_drops = self.t.table("SynthesisDropInfoData")

        drops = self.t.table("DropInfoData")
        self.drops = drops
        groups = self.t.table("ItemGroupInfoData")
        self.group_items: dict[str, list[str]] = defaultdict(list)
        for g in groups:
            self.group_items[g["ItemGroupKey"]].append(g["ItemKey"])

        self.item_by_key: dict[str, dict] = {r["ItemKey"]: r for r in self.items}
        self.item_name: dict[str, str] = {}
        for r in self.items:
            self.item_name[r["ItemKey"]] = self.locale.item_name(r["ItemKey"], r.get("NameKey") or "")

        # oracle rules
        existing_items = load_existing("lookup_items.json") if use_oracle else None
        self.base_names = {}
        for k, v in self.locale.en.items():
            if k.startswith("BaseStatName_") and k[13:]:
                self.base_names[k[13:]] = v
        for k, v in self.locale.en.items():
            if k.startswith("StatName_") and k[9:] and k[9:] not in self.base_names:
                self.base_names[k[9:]] = v
        self.base_formats = extract_stat_formats(existing_items, self.base_names) if existing_items else {}
        # previous catalog ids: keep special items the old pipeline included even
        # when they have no drop/crafting source and are not Steam-tradable
        # (e.g. the Radiant Lv100 set).
        self.existing_lookup_ids = {it["id"] for it in existing_items} if existing_items else set()
        self.tier_level = extract_crafting_tier_level(load_existing("lookup_sources.json")) if use_oracle else {}
        self.material_avg_level = extract_material_avg_level(load_existing("synthesis_model.json")) if use_oracle else {}

    # ---- drop expansion ----
    def expand_dropkey(self, dk: str) -> list[tuple[str, float]]:
        # Aggregate weights by item: a DropKey can list the same item via
        # multiple rows (hero-conditioned ITEMGROUP variants), which would
        # otherwise duplicate entries and inflate drop counts.
        weights: dict[str, float] = defaultdict(float)
        for e in self.drops:
            if e["DropKey"] != dk:
                continue
            if e["REWARDTYPE"] == "ITEM":
                weights[e["RewardKey"]] += float(e["Weight"] or 0)
            else:
                gis = self.group_items.get(e["RewardKey"], [])
                w = float(e["Weight"] or 0) / len(gis) if gis else 0.0
                for ik in gis:
                    weights[ik] += w
        tot = sum(weights.values())
        return [(ik, fmt_pct(w / tot * 100) if tot else 0.0) for ik, w in weights.items()]

    def item_grade(self, item_key: str) -> str | None:
        r = self.item_by_key.get(item_key)
        return (r.get("GRADE") or "").strip() or None

    # ---- stat helpers ----
    def gear_base_stats(self, gear_row: dict, gear_type_row: dict | None) -> list[dict]:
        base = []
        if not gear_type_row:
            return base
        for i in (1, 2):
            stat = (gear_type_row.get(f"BaseStat{i}_STATTYPE") or "").strip()
            mod = (gear_type_row.get(f"BaseStat{i}_MODTYPE") or "FLAT").strip()
            raw = int(gear_row.get(f"BaseStat{i}_Value") or 0)
            if not stat or stat == "NONE" or raw == 0:
                continue
            base.append(self.stat_row(stat, mod, raw, kind="base"))
        return base

    def gear_inherent_stats(self, gear_row: dict) -> list[dict]:
        out = []
        for i in (1, 2, 3):
            stat = (gear_row.get(f"InherentStat{i}_STATTYPE") or "").strip()
            mod = (gear_row.get(f"InherentStat{i}_MODTYPE") or "FLAT").strip()
            raw = int(gear_row.get(f"InherentStat{i}_Value") or 0)
            if not stat or stat == "NONE" or raw == 0:
                continue
            out.append(self.stat_row(stat, mod, raw, kind="affix"))
        return out

    def stat_row(self, stat: str, mod: str, raw: int, kind: str = "affix") -> dict:
        if kind == "base":
            if stat == "AttackSpeed":
                # game stores per-second attacks as raw/2 in value, display divides by 10
                value = raw // 2 if raw % 2 == 0 else raw / 2
                return {"stat": stat, "mod": mod, "value": value,
                        "display": f"Attack Per Second {value / 10:.2f}"}
            fmt = self.base_formats.get(stat)
            if fmt:
                name = self.base_names.get(stat) or humanize(stat)
                disp = raw / fmt["divisor"]
                num = fmt_display(disp, fmt["decimals"] or None)
                return {"stat": stat, "mod": mod, "value": raw,
                        "display": f"{name} {fmt['prefix']}{num}{fmt['suffix']}"}
            name = self.base_names.get(stat) or humanize(stat)
            div = default_divisor(stat, mod)
            return {"stat": stat, "mod": mod, "value": raw,
                    "display": f"{name} {fmt_display(raw / div)}"}
        # affix / inherent: use Stat_<stat>_<mod> template with formatted display value
        template = self.locale.stat_template(stat, mod)
        div = default_divisor(stat, mod)
        disp = raw / div
        if template and "{0}" in template:
            display = template.replace("{0}", fmt_display(disp))
        else:
            name = self.base_names.get(stat) or humanize(stat)
            display = f"{name} {fmt_display(disp)}"
        return {"stat": stat, "mod": mod, "value": raw, "display": display}

    @staticmethod
    def _fmt_num(v: float) -> str:
        if float(v).is_integer():
            return str(int(v))
        return f"{v:.2f}".rstrip("0").rstrip(".")

    def material_gear_groups(self, item_key: str) -> list[dict] | None:
        m = self.mats.get(item_key)
        if not m:
            return None
        grp_key = m.get("StatModGroupKey") or ""
        # A material's StatModGroup can list MULTIPLE StatModKeys per gear group
        # (each is an alternative affix rolled on embed). Merge them into one
        # group per gearGroup so the output matches the bundled shape (the
        # renderer keys groups by gearGroup — duplicates would collide).
        groups_by_gear: dict[str, list[dict]] = {}
        for e in self.smgs:
            if e["StatModGroupKey"] != grp_key:
                continue
            gear_group = e["GearGroup"]
            sm_key = e["StatModKey"]
            min_tier = int(e.get("MinTier") or 0)
            max_tier = int(e.get("MaxTier") or 0)
            for sm in self.sms:
                if sm["StatModKey"] != sm_key:
                    continue
                tier = int(sm.get("Tier") or 0)
                if tier < min_tier or tier > max_tier:
                    continue
                stat = sm["STATTYPE"]
                raw_min = int(sm.get("MinValue") or 0)
                raw_max = int(sm.get("MaxValue") or 0)
                # outcome display scale depends on the mod type (ADDITIVE/
                # MULTIPLICATIVE are percentage-scaled); base-formats are not
                # reused here because they are per-stat, not per-mod.
                div = default_divisor(stat, sm["MODTYPE"])
                dmin = round(raw_min / div, 4)
                dmax = round(raw_max / div, 4)
                if float(dmin).is_integer():
                    dmin = int(dmin)
                if float(dmax).is_integer():
                    dmax = int(dmax)
                # single-value template when min==max, MinMax template for ranges
                is_range = dmin != dmax
                tmpl = self.locale.stat_template(stat, sm["MODTYPE"], minmax=is_range)
                if tmpl and "{0}" in tmpl:
                    if is_range and "{1}" in tmpl:
                        text = tmpl.replace("{0}", fmt_display(dmin)).replace("{1}", fmt_display(dmax))
                    else:
                        text = tmpl.replace("{0}", fmt_display(dmin))
                else:
                    name = self.base_names.get(stat) or humanize(stat)
                    text = f"{name} +{fmt_display(dmin)}~{fmt_display(dmax)}%"
                groups_by_gear.setdefault(gear_group, []).append({
                    "stat": stat, "mod": sm["MODTYPE"], "tier": tier,
                    "rawMin": raw_min, "rawMax": raw_max,
                    "displayMin": dmin, "displayMax": dmax,
                    "displayText": text,
                })
        return [{"gearGroup": g, "outcomes": outcomes} for g, outcomes in groups_by_gear.items()] or None

    @staticmethod
    def _round_to(v: float) -> float:
        return round(v, 4)

    def _classify_unique_param(self, value: str, exchange: str) -> dict:
        """Classify a single unique-mod param slot for the renderer's fill logic.

        Returns {value, exchange, kind}; kind drives itemLabels.uniqueModLabel.
        - percent: Raw_Divide1000 → value/10 (percent display, e.g. 750→"75")
        - scale100: Raw_Divide100 → value/100 (only SkillRangeUp today)
        - element: DamageAttribute → literal Cold/Fire/Lightning (no locale)
        - skill: Divided && value hits SkillInfoData.SkillKey → store SkillKey
        - hero: Divided && value in self.hero_class → store class key
        - number: Divided && plain integer (e.g. AegisFieldAbsorbUp 500)
        """
        if not value:
            return None
        if exchange == "Raw_Divide1000":
            return {"value": value, "exchange": exchange, "kind": "percent"}
        if exchange == "Raw_Divide100":
            return {"value": value, "exchange": exchange, "kind": "scale100"}
        if exchange == "DamageAttribute":
            return {"value": value, "exchange": exchange, "kind": "element"}
        # Divided: decide whether the value is a skill / hero reference or a number.
        if value in self.skill_keys:
            return {"value": value, "exchange": exchange, "kind": "skill"}
        if value in self.hero_class:
            return {"value": self.hero_class[value], "exchange": exchange, "kind": "hero"}
        return {"value": value, "exchange": exchange, "kind": "number"}

    def gear_unique(self, gear_row: dict) -> dict | None:
        uk = (gear_row.get("UniqueModKey") or "").strip()
        if not uk:
            return None
        um = self.unique_mods.get(uk)
        if not um:
            return None
        mod = um.get("UniqueMod") or uk
        params = []
        for i in range(1, 6):
            p = self._classify_unique_param(
                (um.get(f"Param{i}") or "").strip(),
                (um.get(f"Param{i}ExchangeType") or "").strip(),
            )
            if p:
                params.append(p)
        en_tpl = (self.locale.en.get(f"UniqueMod_{mod}") or "").strip()
        # StatValueUp has a bare "{0}" template whose Divided value (4510001) is an
        # opaque reference — treat all its params as unresolvable so the renderer
        # falls back to text. Templates with surrounding text (e.g. "……提升{0}。")
        # keep their number params resolved.
        if en_tpl and re.fullmatch(r"(\{\d+\})+", en_tpl):
            for p in params:
                p["kind"] = "unknown"
        return {"key": int(uk), "mod": mod, "text": mod, "params": params}

    # ---- build outputs ----
    def build_gamedata(self, game_version: str) -> dict:
        items = []
        csv_ids = set()
        for r in self.items:
            ik = (r.get("ItemKey") or "").strip()
            if not ik.isdigit():
                continue
            csv_ids.add(int(ik))
            if parse_bool(r.get("IsDeletedInServer") or ""):
                # server-deleted rows are not obtainable in-game (v1.2.2 keeps
                # them in the CSV with IsDeletedInServer=True, e.g. all Lv85 gear)
                continue
            items.append({
                "id": int(ik),
                "name": self.item_name[ik],
                "grade": (r.get("GRADE") or "UNKNOWN").strip(),
                "type": (r.get("ITEMTYPE") or "UNKNOWN").strip(),
                # gearType is required so runtime-setGameData merges keep a
                # usable category (otherwise merged gear renders "Unknown")
                "gearType": (r.get("GEARTYPE") or "").strip() or None,
                "level": int(r["Level"]) if (r.get("Level") or "").isdigit() else None,
                "marketTradable": parse_bool(r.get("IsCanExchangeMarketable") or ""),
            })
        # NameKey-only rows: base ids present in the locale table but absent from
        # the CSV (e.g. 620017, Copper Amulet series) — the game's BoxOpenLog may
        # emit these as itemStringKey, so keep them resolvable.
        for key, name in self.locale.en.items():
            m = re.match(r"^ItemName_(\d+)$", key)
            if not m:
                continue
            ik = int(m.group(1))
            if ik in csv_ids or not (110_001 <= ik <= 939_999):
                continue
            items.append({"id": ik, "name": name, "grade": "", "type": "",
                          "level": None, "marketTradable": False})
        items.sort(key=lambda it: it["id"])
        return {
            "source": f"sharedassets0.assets/ItemInfoData (game v{game_version})",
            "fetchedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "gameVersion": game_version,
            # Must match CATALOG_SCHEMA_VERSION in
            # app/src/core/unityAssets/catalogExtractor.ts — the app treats a
            # missing/older value as stale and refreshes the runtime catalog.
            "schemaVersion": 2,
            "count": len(items),
            "items": items,
        }

    def build_lookup_items(self) -> list[dict]:
        # Keep only obtainable / market-relevant items: those appearing in the
        # drop/crafting/offering/synthesis graph, or marketable on Steam.
        obtainable: set[int] = set()
        obtainable.update(self.obtainable_sources if hasattr(self, "obtainable_sources") else [])
        obtainable.update(self.obtainable_offerings if hasattr(self, "obtainable_offerings") else [])
        obtainable.update(self.obtainable_synthesis if hasattr(self, "obtainable_synthesis") else [])
        out = []
        for r in self.items:
            ik = (r.get("ItemKey") or "").strip()
            if not ik.isdigit():
                continue
            item_type = (r.get("ITEMTYPE") or "UNKNOWN").strip()
            if item_type not in ("GEAR", "MATERIAL"):
                continue
            item_id = int(ik)
            if parse_bool(r.get("IsDeletedInServer") or ""):
                # server-deleted rows are not obtainable in-game — exclude so the
                # Lookup page never lists items that don't exist in the game.
                continue
            tradable = parse_bool(r.get("IsCanExchangeMarketable") or "")
            # MATERIALs are kept in full: few in number, each carries a proper
            # materialType, and any MATERIAL absent here would be merged at
            # runtime by LookupService.setGameData with materialType=null
            # (rendering as an "Unknown" category in the Lookup page).
            if item_type == "GEAR":
                if item_id not in obtainable and not tradable and item_id not in self.existing_lookup_ids:
                    continue
            gear_type = (r.get("GEARTYPE") or "").strip() or None
            gear_group = (r.get("GearGroup") or "").strip() or None
            mat = self.mats.get(ik)
            material_type = (mat.get("MATERIALTYPE") or "").strip() or None if mat else None
            icon_path = self.icon_path(r.get("IconPath") or "", ik, item_type, gear_type)
            entry: dict = {
                "id": int(ik),
                "name": self.item_name[ik],
                "grade": (r.get("GRADE") or "UNKNOWN").strip(),
                "type": item_type,
                "gearType": gear_type,
                "gearGroup": gear_group,
                "materialType": material_type,
                "level": int(r["Level"]) if (r.get("Level") or "").isdigit() else None,
                "iconPath": icon_path,
                "marketTradable": parse_bool(r.get("IsCanExchangeMarketable") or ""),
            }
            content_type = (r.get("CONTENTTYPE") or "").strip()
            if content_type:
                entry["contentType"] = content_type
            if item_type == "GEAR":
                gear_row = self.gear.get(r.get("GearKey") or ik)
                if gear_row:
                    gt = self.gtypes.get(gear_type or "")
                    stats = {
                        "base": self.gear_base_stats(gear_row, gt),
                        "inherent": self.gear_inherent_stats(gear_row),
                        "unique": self.gear_unique(gear_row),
                    }
                    entry["stats"] = stats
            elif mat:
                gg = self.material_gear_groups(ik)
                if gg:
                    entry["gearGroups"] = gg
            out.append(entry)

        # Dedupe identical-display variants: v1.2.2 lists some gear as multiple
        # ItemKeys sharing name/grade/level but differing only in the rolled
        # affixes (e.g. 335171 vs 335173). They drop from the same pools and
        # share one Steam market_hash_name — the bundled catalog shows them as
        # one item (matching the pre-1.2.2 shape). Keep the smallest id.
        seen: set[tuple] = set()
        deduped = []
        for entry in out:
            key = (entry["type"], entry["name"], entry["grade"], entry["level"])
            if key in seen:
                continue
            seen.add(key)
            deduped.append(entry)
        return deduped

    @staticmethod
    def icon_path(raw: str, item_key: str, item_type: str, gear_type: str | None) -> str:
        raw = (raw or "").strip()
        m = re.match(r"^Item_(\d+)$", raw)
        if m:
            return f"item-{m.group(1)}"
        m = re.match(r"^([A-Z]+)_(\d+)$", raw)
        if m:
            return f"{m.group(1).lower()}-{m.group(2)}"
        if item_type == "GEAR" and gear_type:
            return f"{gear_type.lower()}-{item_key}"
        if item_type == "MATERIAL":
            return f"item-{item_key}"
        return ""

    def build_lookup_sources(self) -> dict:
        boxes: dict[str, dict] = {}
        items: dict[str, dict] = defaultdict(lambda: {"drops": [], "crafting": [], "usedIn": []})

        # --- boxes ---
        for r in self.items:
            ik = (r.get("ItemKey") or "").strip()
            if not ik.isdigit():
                continue
            box_key = int(ik)
            cv = category_via_for(box_key)
            if cv is None:
                continue
            category, _via = cv
            dk = (r.get("DropKey") or "").strip()
            drops_out = []
            if dk:
                for reward_ik, pct in self.expand_dropkey(dk):
                    drops_out.append({
                        "itemKey": int(reward_ik),
                        "name": self.item_name.get(reward_ik, reward_ik),
                        "grade": self.item_grade(reward_ik) or "",
                        "dropPct": pct,
                    })
            box_stages, first_drop = self.box_stages(box_key)
            # first-clear-only boxes (no regular stage drops) label from first-clear stages
            label = stage_range_label(box_stages or first_drop)
            boxes[ik] = {
                "name": self.item_name[ik],
                "grade": (r.get("GRADE") or "UNKNOWN").strip(),
                "category": category,
                "drops": drops_out,
                "stages": box_stages,
                "dropStageRangeLabel": label,
                "firstDropOnly": len(first_drop) > 0,
                "firstDropStages": [
                    {"stageKey": st["stageKey"], "stageName": st["stageName"]} for st in first_drop
                ],
            }

        # --- items.drops (reverse) + usedIn via crafting ---
        for box_key, b in boxes.items():
            cat, via = category_via_for(int(box_key)) or ("", "")
            for d in b["drops"]:
                items[str(d["itemKey"])]["drops"].append({
                    "via": via,
                    "boxItemKey": int(box_key),
                    "boxName": b["name"],
                    "grade": d["grade"],
                    "dropPct": d["dropPct"],
                })

        # --- crafting (each recipe adds an entry to every output item) ---
        for cr in self.crafting:
            recipe_key = cr["CraftingRecipeKey"]
            crafting_type = cr["ItemCraftingType"]
            tier = int(cr["RecipeTier"] or 0)
            dk = (cr["DropKey"] or "").strip()
            if not dk:
                continue
            mats = parse_materials(cr.get("Material") or "")
            level = list(self.tier_level.get((crafting_type, tier)) or default_tier_level(crafting_type, tier))
            for out_ik, pct in self.expand_dropkey(dk):
                items[out_ik]["crafting"].append({
                    "recipeKey": int(recipe_key),
                    "tier": tier,
                    "craftingType": crafting_type,
                    "level": {"min": level[0], "max": level[1]},
                    "materials": [{"itemKey": int(k), "name": self.item_name.get(k, k), "amount": int(n)} for k, n in mats],
                    "outputPct": pct,
                })

        # --- items.usedIn: reverse of crafting materials ---
        for ik, v in items.items():
            mat_item = self.item_by_key.get(ik)
            if not mat_item or (mat_item.get("ITEMTYPE") or "").strip() != "MATERIAL":
                continue
            for cr in self.crafting:
                mats = parse_materials(cr.get("Material") or "")
                if ik not in [k for k, _ in mats]:
                    continue
                dk = (cr.get("DropKey") or "").strip()
                if not dk:
                    continue
                tier = int(cr["RecipeTier"] or 0)
                crafting_type = cr["ItemCraftingType"]
                level = list(self.tier_level.get((crafting_type, tier)) or default_tier_level(crafting_type, tier))
                outputs = [{"itemKey": int(k), "poolPct": p} for k, p in self.expand_dropkey(dk)]
                entry = {
                    "recipeKey": int(cr["CraftingRecipeKey"]),
                    "craftingType": crafting_type,
                    "tier": tier,
                    "level": {"min": level[0], "max": level[1]},
                    "materials": [{"itemKey": int(k), "name": self.item_name.get(k, k), "amount": int(n)} for k, n in mats],
                    "outputs": outputs,
                }
                if not any(e["recipeKey"] == entry["recipeKey"] for e in v["usedIn"]):
                    v["usedIn"].append(entry)

        # --- stages ---
        stages_out: dict[str, dict] = {}
        for s in self.stages:
            sk = s["StageKey"]
            monsters = []
            for tok in (s.get("Monsters") or "").split():
                mk = tok.split("_")[0]
                m = self.monsters.get(mk)
                if m:
                    name_key = (m.get("MonsterNameStringKey") or "").strip()
                    monsters.append(self.locale.en.get(name_key) or name_key or mk)
            s_boxes = []
            for col in ("MonsterDropItemKey", "BossDropItemKey"):
                bkey = (s.get(col) or "").strip()
                if not bkey:
                    continue
                b = boxes.get(bkey)
                s_boxes.append({
                    "boxItemKey": int(bkey),
                    "name": b["name"] if b else bkey,
                    "grade": b["grade"] if b else None,
                })
            stages_out[sk] = {"monsters": monsters, "boxes": s_boxes}

        self.obtainable_sources = {int(k) for k in items if items[k]}
        # drops/crafting are REQUIRED fields on LookupItemSources (may be empty
        # arrays — the renderer iterates them); only usedIn is optional.
        clean_items = {}
        for k, v in items.items():
            entry = {"drops": v.get("drops") or [], "crafting": v.get("crafting") or []}
            if v.get("usedIn"):
                entry["usedIn"] = v["usedIn"]
            clean_items[k] = entry
        return {"items": clean_items, "boxes": boxes, "stages": stages_out}
    def box_stages(self, box_key: int) -> tuple[list[dict], list[dict]]:
        stages = []
        cv = category_via_for(box_key)
        via_label = cv[1] if cv else None
        for s in self.stages:
            sk = s["StageKey"]
            via = None
            rate = None
            if (s.get("MonsterDropItemKey") or "").strip() == str(box_key):
                via = "monster_box" if via_label == "monster_box" else via_label
                rate = int(s.get("MonsterDropItemRateM") or 0)
            elif (s.get("BossDropItemKey") or "").strip() == str(box_key):
                via = via_label  # boss_box (920) or act_boss (930)
                rate = int(s.get("BossDropItemRateM") or 0)
            if via is None:
                continue
            # act-boss stages leave the rate blank -> guaranteed drop (100%)
            spawn = (rate or 1_000_000) / 10000
            if float(spawn).is_integer():
                spawn = int(spawn)
            name_key = (s.get("StageNameKey") or "").strip()
            stage_name = self.locale.en.get(name_key) or self.locale.stage_name(sk)
            stages.append({
                "stageKey": int(sk),
                "stageName": stage_name,
                "via": via,
                "spawnPct": spawn,
                "difficulty": (s.get("STAGEDIFFICULITY") or "NORMAL").strip(),
                "act": int(s.get("Act") or 0),
                "no": int(s.get("StageNo") or 0),
            })
        stages.sort(key=lambda x: x["stageKey"])
        first = []
        for s in self.stages:
            fdk = (s.get("FirstClearDropKey") or "").strip()
            if not fdk:
                continue
            if any(ik == str(box_key) for ik, _ in self.expand_dropkey(fdk)):
                first.append({
                    "stageKey": int(s["StageKey"]),
                    "stageName": self.locale.en.get((s.get("StageNameKey") or "").strip())
                        or self.locale.stage_name(s["StageKey"]),
                    "difficulty": (s.get("STAGEDIFFICULITY") or "NORMAL").strip(),
                    "act": int(s.get("Act") or 0),
                    "no": int(s.get("StageNo") or 0),
                })
        return stages, first

    def build_synthesis_model(self) -> dict:
        grade_weights = {}
        for idx, g in enumerate(self.grades.values()):
            weights = [
                int(g.get("Lower2GradeWeight") or 0),
                int(g.get("Lower1GradeWeight") or 0),
                int(g.get("SameGradeWeight") or 0),
                int(g.get("Higher1GradeWeight") or 0),
                int(g.get("Higher2GradeWeight") or 0),
            ]
            grade_weights[g["GRADE"]] = {"value": idx, "weights": weights, "total": sum(weights)}

        recipes_by_type: dict[str, list[dict]] = defaultdict(list)
        for r in self.synth_recipes:
            typ = r["ItemSynthesisType"]
            tier = int(r["RecipeTier"] or 0)
            grade = r["GRADE"]
            min_avg = int(r.get("MinMaterialAverageLevel") or 0)
            avg = self.material_avg_level.get((typ, tier, grade, min_avg), [1, 1])
            recipes_by_type[typ].append({
                "recipeTier": tier,
                "inputGrade": grade,
                "minMaterialTier": int(r.get("MinMaterialTier") or 0),
                "minMaterialAverageLevel": min_avg,
                "minResultLevel": int(r.get("MinResultLevel") or 0),
                "maxResultLevel": int(r.get("MaxResultLevel") or 0),
                "materialAmount": int(r.get("MaterialAmount") or 0),
                "levelWeights": [int(r.get(f"LevelWeight{i}") or 0) for i in range(1, 5)],
                "materialAvgLevelMin": avg[0],
                "materialAvgLevelMax": avg[1],
            })

        buckets: dict[str, list[dict]] = defaultdict(list)
        for s in self.synth_drops:
            # bucket key is "<GRADE>|<ItemSynthesisType>|<ItemLevel>" — the lookup
            # engine (levelsForGradeType) parses the trailing segment as a level.
            key = f"{s['GRADE']}|{s['ItemSynthesisType']}|{s['ItemLevel']}"
            dk = (s.get("DropKey") or "").strip()
            if not dk:
                continue
            for ik, pct in self.expand_dropkey(dk):
                buckets[key].append({"itemKey": int(ik), "poolPct": pct})
        self.obtainable_synthesis = {it["itemKey"] for entries in buckets.values() for it in entries}

        return {"gradeWeights": grade_weights, "recipesByType": dict(recipes_by_type),
                "buckets": dict(buckets)}

    def build_offerings(self) -> list[dict]:
        out = []
        self.obtainable_offerings = set()
        for n in range(10):
            coin_key = 160001 + n
            # coin 160001..160010 -> DropKey 3700001..3700010
            dk = str(3700000 + n + 1)
            loot = [{"itemKey": int(ik), "poolPct": p} for ik, p in self.expand_dropkey(dk)]
            loot.sort(key=lambda x: x["poolPct"], reverse=True)
            # the coin item itself is obtainable/usable even when not Steam-tradable
            self.obtainable_offerings.add(coin_key)
            self.obtainable_offerings.update(l["itemKey"] for l in loot)
            out.append({
                "coinKey": coin_key,
                "goldCost": 10 + n * 100,
                "unlockCubeLevel": 20,
                "loot": loot,
            })
        return out

    def build_stage_boxes(self) -> dict:
        existing = load_existing("stage_boxes.json")
        default_cooldown = (existing or {}).get("defaultCooldownSeconds", 720)
        stage_level = {}
        for s in self.stages:
            sk = s["StageKey"]
            if (s.get("StageLevel") or "").isdigit():
                stage_level[sk] = int(s["StageLevel"])
        items = []
        for r in self.items:
            ik = (r.get("ItemKey") or "").strip()
            if not ik.isdigit():
                continue
            if category_via_for(int(ik)) is None:
                continue
            stages, _first = self.box_stages(int(ik))
            drop_keys = [st["stageKey"] for st in stages]
            label = stage_range_label(stages)
            if drop_keys:
                # level: prefer the "LvN" embedded in the box name, fall back to
                # the first drop stage's StageLevel (e.g. "Normal Monster Box 1")
                name = self.item_name[ik]
                m_lv = re.search(r"Lv\s*(\d+)", name, re.IGNORECASE)
                level = int(m_lv.group(1)) if m_lv else stage_level.get(str(drop_keys[0]))
                tracker = {
                    "canonical": True,
                    "idealStageKey": drop_keys[0],
                    "dropStageKeys": drop_keys,
                    "dropStageRangeLabel": label,
                }
            else:
                # phantom entry: no stage drops this box, so no tracker metadata
                level = None
                tracker = None
            entry = {
                "id": int(ik),
                "name": self.item_name[ik],
                "grade": (r.get("GRADE") or "UNKNOWN").strip(),
                "type": "STAGEBOX",
                "level": level,
                "marketTradable": parse_bool(r.get("IsCanExchangeMarketable") or ""),
                "obtainable": True,
            }
            if tracker:
                entry["tracker"] = tracker
            items.append(entry)
        return {
            "source": "game_extracted",
            "gameVersion": self.game_version,
            "fetchedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "defaultCooldownSeconds": default_cooldown,
            "count": len(items),
            "items": items,
        }


def fmt_display(v: float, decimals: int | None = None) -> str:
    """Game-style value formatting: integers without decimals, non-integers with
    up to two decimals trimmed of trailing zeros; explicit decimals when set."""
    if decimals is not None:
        return f"{v:.{decimals}f}"
    if float(v).is_integer():
        return str(int(v))
    return f"{v:.2f}".rstrip("0").rstrip(".")


def parse_bool(s: str) -> bool:
    return s.strip().lower() in ("true", "1", "yes")


def parse_materials(s: str) -> list[tuple[str, int]]:
    out = []
    for tok in s.split():
        parts = tok.split("_")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            out.append((parts[0], int(parts[1])))
    return out


def humanize(key: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", " ", key).replace("_", " ")


def stage_range_label(stages: list[dict]) -> str:
    """Group drop stages into difficulty segments in stage order, e.g.
    'Nightmare 3-5 – 3-9 · Hell 1-1 – 1-9 · Hell 2-1 – 2-4'."""
    if not stages:
        return ""
    groups: list[list] = []  # ordered [difficulty, act, [nos]]
    for st in sorted(stages, key=lambda x: x["stageKey"]):
        diff = str(st.get("difficulty") or "NORMAL").title()
        act = int(st.get("act") or 0)
        no = int(st.get("no") or 0)
        if groups and groups[-1][0] == diff and groups[-1][1] == act:
            groups[-1][2].append(no)
        else:
            groups.append([diff, act, [no]])
    parts = []
    for diff, act, nos in groups:
        seg = f"{diff} {act}-{min(nos)} – {act}-{max(nos)}" if len(set(nos)) > 1 else f"{diff} {act}-{nos[0]}"
        parts.append(seg)
    return " · ".join(parts)


GAME_VERSION = "1.2.2"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-dir", default=DEFAULT_GAME_DIR)
    parser.add_argument("--out", default=str(REPO / "data"))
    parser.add_argument("--no-oracle", action="store_true", help="skip rule extraction from existing data")
    parser.add_argument("--game-version", default=GAME_VERSION)
    args = parser.parse_args()

    b = Builder(args.game_dir, Path(args.out), use_oracle=not args.no_oracle)
    b.game_version = args.game_version

    outputs = {
        "gamedata.json": b.build_gamedata(args.game_version),
        # order matters: lookup_sources/offerings/synthesis populate the
        # "obtainable" sets that filter lookup_items
        "lookup_sources.json": b.build_lookup_sources(),
        "offerings.json": b.build_offerings(),
        "synthesis_model.json": b.build_synthesis_model(),
        "lookup_items.json": b.build_lookup_items(),
        "stage_boxes.json": b.build_stage_boxes(),
    }
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, payload in outputs.items():
        path = out_dir / name
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        print(f"wrote {path} ({path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
