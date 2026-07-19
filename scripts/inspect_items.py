"""Inspect specific ItemKey rows in the ItemInfoData CSV."""
import csv, io, os, sys, UnityPy

env = UnityPy.load(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data\sharedassets0.assets")
item = next(o for o in env.objects if o.type.name == "TextAsset" and o.read().m_Name == "ItemInfoData")
data = item.read()
text = getattr(data, "m_Text", None)
if text is None:
    script = getattr(data, "m_Script", None)
    if isinstance(script, bytes):
        text = script.decode("utf-8-sig", errors="replace")
    elif script is not None:
        text = str(script)
text = text.lstrip("\ufeff")
rows = list(csv.DictReader(io.StringIO(text)))
print(f"Total rows: {len(rows)}")
print(f"Columns: {list(rows[0].keys())}")
print()
# Show specific items.
targets = {"530017", "620011", "620017", "628111", "628112", "910011"}
for row in rows:
    if row["ItemKey"] in targets:
        print(f"ItemKey={row['ItemKey']}")
        for k, v in row.items():
            print(f"  {k}: {v!r}")
        print()
