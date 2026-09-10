"""Verify item-icon sprites named `Item_<id>` exist in sharedassets0 (the
sprite names referenced by ItemInfoData.IconPath), and check a few sample ids.
"""
from pathlib import Path
import UnityPy

SHARED = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data") / "sharedassets0.assets"


def main():
    env = UnityPy.load(str(SHARED))
    ids = set()
    for obj in env.objects:
        if obj.type.name != "Sprite":
            continue
        nm = getattr(obj.read(), "m_Name", "")
        if nm.startswith("Item_") and nm[len("Item_"):].isdigit():
            ids.add(int(nm[len("Item_"):]))
    s = sorted(ids)
    print(f"sprites named 'Item_<id>': {len(s)} distinct ids")
    for probe in (110001, 150001, 160003, 600001, 620001, 910011):
        print(f"  has {probe}: {probe in ids}")
    print("sample id range:", s[:5], "...", s[-5:] if len(s) > 5 else s)


if __name__ == "__main__":
    main()