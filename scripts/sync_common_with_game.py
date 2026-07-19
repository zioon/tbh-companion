#!/usr/bin/env python3
"""Sync common.json labels sections with game bundle translations.

For each language, replaces our translations with the game's where a
corresponding game key exists. Companion-specific keys (no game equivalent)
are left untouched.

Game key mapping:
  - labels.grades.<X>      <- Grade_<X>
  - labels.types.<X>       <- GearType_<X> | ItemType_<X> | <X> (single key)
  - labels.stats.<X>       <- StatName_<X>
  - labels.classes.<X>     <- HeroName_<heroId>  (mapped via class->heroId table)
"""
import json
import sys
from pathlib import Path

DUMP_PATH = Path(__file__).resolve().parent.parent / "data" / "_game_locale_dump.json"
LOCALES_DIR = Path(__file__).resolve().parent.parent / "app" / "shared" / "locales"

LANGS = ["en", "zh-CN", "ja", "ko"]

# Hero class name -> HeroName_<id> in game bundle
CLASS_TO_HERO_ID = {
    "Knight": "101",
    "Ranger": "201",
    "Sorcerer": "301",
    "Priest": "401",
    "Hunter": "501",
    "Slayer": "601",
}


def load_dump() -> dict:
    with DUMP_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_common(lang: str) -> dict:
    path = LOCALES_DIR / lang / "common.json"
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_common(lang: str, data: dict) -> None:
    path = LOCALES_DIR / lang / "common.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def sync_section(
    labels: dict,
    section: str,
    game: dict[str, str],
    lookup: dict[str, str],
    lang: str,
    dry_run: bool = False,
) -> tuple[int, int, int]:
    """Sync one section. Returns (matched, changed, untouched).

    `lookup` maps our section key -> game key.
    """
    section_data = labels.get(section, {})
    if not section_data:
        return 0, 0, 0

    matched = 0
    changed = 0
    untouched = 0
    for our_key, our_val in list(section_data.items()):
        game_key = lookup.get(our_key)
        if not game_key:
            untouched += 1
            continue
        game_val = game.get(game_key)
        if game_val is None:
            untouched += 1
            continue
        matched += 1
        if game_val != our_val:
            if not dry_run:
                section_data[our_key] = game_val
            changed += 1
            print(f"  [{lang}/{section}] {our_key}: {our_val!r} -> {game_val!r}")
    return matched, changed, untouched


def build_grades_lookup() -> dict[str, str]:
    return {  # our_key -> game_key
        "COMMON": "Grade_COMMON",
        "UNCOMMON": "Grade_UNCOMMON",
        "RARE": "Grade_RARE",
        "LEGENDARY": "Grade_LEGENDARY",
        "IMMORTAL": "Grade_IMMORTAL",
        "ARCANA": "Grade_ARCANA",
        "BEYOND": "Grade_BEYOND",
        "CELESTIAL": "Grade_CELESTIAL",
        "DIVINE": "Grade_DIVINE",
        "COSMIC": "Grade_COSMIC",
    }


def build_types_lookup() -> dict[str, str]:
    """types.X may come from GearType_X, ItemType_X, or single key X."""
    lookup = {}
    # Gear types
    gear_types = [
        "SWORD", "BOW", "STAFF", "SCEPTER", "CROSSBOW", "AXE", "SHIELD",
        "ARROW", "ORB", "TOME", "BOLT", "HELMET", "ARMOR", "BOOTS",
        "GLOVES", "AMULET", "RING", "EARING", "BRACER", "HATCHET",
    ]
    for gt in gear_types:
        lookup[gt] = f"GearType_{gt}"
    # Item categories
    item_types = ["GEAR", "MATERIAL", "STAGEBOX"]
    for it in item_types:
        lookup[it] = f"ItemType_{it}"
    # Material kinds (single keys, no prefix)
    material_kinds = ["OFFERING", "INSCRIPTION", "DECORATION", "ENGRAVING", "CRAFTING"]
    for mk in material_kinds:
        lookup[mk] = mk  # exact match
    return lookup


def build_stats_lookup(our_stats_keys: set[str], game_keys: set[str]) -> dict[str, str]:
    """stats.X <- StatName_X. Build from our keys that have a matching game key."""
    return {k: f"StatName_{k}" for k in our_stats_keys if f"StatName_{k}" in game_keys}


def build_classes_lookup() -> dict[str, str]:
    return {cls: f"HeroName_{hid}" for cls, hid in CLASS_TO_HERO_ID.items()}


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    dump = load_dump()

    sections = sys.argv[1:]
    sections = [s for s in sections if not s.startswith("--")]
    if not sections:
        sections = ["grades", "types", "stats", "classes"]

    for lang in LANGS:
        print(f"\n=== {lang} ===")
        common = load_common(lang)
        labels = common.get("labels", {})
        game = dump.get(lang, {})
        game_keys = set(game.keys())

        totals = {"matched": 0, "changed": 0, "untouched": 0}
        for section in sections:
            if section == "grades":
                lookup = build_grades_lookup()
            elif section == "types":
                lookup = build_types_lookup()
            elif section == "stats":
                our_keys = set(labels.get("stats", {}).keys())
                lookup = build_stats_lookup(our_keys, game_keys)
            elif section == "classes":
                lookup = build_classes_lookup()
            else:
                continue

            print(f"--- {section} ---")
            m, c, u = sync_section(labels, section, game, lookup, lang, dry_run=dry_run)
            totals["matched"] += m
            totals["changed"] += c
            totals["untouched"] += u

        if not dry_run and totals["changed"] > 0:
            save_common(lang, common)

        print(f"  total: {totals['matched']} matched, {totals['changed']} changed, {totals['untouched']} untouched (companion-specific)")


if __name__ == "__main__":
    main()
