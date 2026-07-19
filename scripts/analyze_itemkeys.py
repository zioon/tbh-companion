"""Find patterns in itemKeys — specifically why 620017 appears in memory."""
import csv, io, UnityPy

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

# All keys ending in 0017 or starting with 62.
print("=== Items with ItemKey ending in 0017 ===")
for row in rows:
    ik = row["ItemKey"]
    if ik.endswith("0017"):
        print(f"  {ik:>8}  {row['ITEMTYPE']:<10}  {row['GRADE']:<10}  {row['GEARTYPE']:<10}  NameKey={row['NameKey']}")

print()
print("=== Items with ItemKey starting with 62 ===")
for row in rows:
    ik = row["ItemKey"]
    if ik.startswith("62"):
        print(f"  {ik:>8}  {row['ITEMTYPE']:<10}  {row['GRADE']:<10}  {row['GEARTYPE']:<10}  NameKey={row['NameKey']}")

print()
print("=== Items with NameKey containing 620017 or 620011 ===")
for row in rows:
    nk = row["NameKey"]
    if "620017" in nk or "620011" in nk:
        print(f"  ItemKey={row['ItemKey']:>8}  NameKey={nk}  GEARTYPE={row['GEARTYPE']}  GRADE={row['GRADE']}")
