"""Audit the generated gamedata.json for data quality."""
import json
from collections import Counter
from pathlib import Path

CATALOG = Path(__file__).resolve().parent.parent / "data" / "gamedata.json"


def main():
    d = json.loads(CATALOG.read_text(encoding="utf-8"))
    items = d["items"]
    by_id = {it["id"]: it for it in items}

    print("=== Spot-checks ===")
    for ik in [110001, 120001, 530017, 620017, 628111, 910011, 910051, 620111, 530111]:
        it = by_id.get(ik)
        if it:
            name = it["name"]
            t = it["type"]
            g = it["grade"]
            lvl = it["level"]
            mt = it["marketTradable"]
            print(f"  {ik}: name={name!r:35} type={t:10} grade={g:10} level={lvl} tradable={mt}")
        else:
            print(f"  {ik}: NOT FOUND")

    print(f"\nTotal items: {len(items)}")
    types = Counter(it["type"] for it in items)
    print(f"By type: {dict(types)}")
    grades = Counter(it["grade"] for it in items)
    print(f"By grade: {dict(grades)}")

    empty_name = sum(1 for it in items if not it.get("name"))
    print(f"Empty name count: {empty_name}")

    unresolved = sum(1 for it in items if it.get("name", "").startswith("ItemName_"))
    print(f"Items still showing raw ItemName_: {unresolved}")

    # Sample 5 unresolved.
    print("\nSample unresolved (raw ItemName_ kept):")
    shown = 0
    for it in items:
        if it.get("name", "").startswith("ItemName_"):
            print(f"  id={it['id']} name={it['name']} type={it['type']} grade={it['grade']}")
            shown += 1
            if shown >= 8:
                break


if __name__ == "__main__":
    main()
