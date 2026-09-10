"""Probe game .assets files for icon textures/sprites keyed by item id.

Lists Texture2D/Sprite object whose m_Name is a pure number (a candidate item
id), to locate where data/icons should come from. Read-only; outputs sample ids.
"""
from pathlib import Path
import UnityPy

_DATA = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data")


def probe(name):
    path = _DATA / name
    if not path.exists():
        print(f"{name}: MISSING")
        return
    try:
        env = UnityPy.load(str(path))
    except Exception as e:  # noqa: BLE001
        print(f"{name}: load FAIL {e}")
        return
    counts = {"Texture2D": 0, "Sprite": 0}
    ids = set()
    digit_names = []
    for obj in env.objects:
        try:
            if obj.type.name not in counts:
                continue
            data = obj.read()
            nm = getattr(data, "m_Name", None)
            if isinstance(nm, str):
                if nm.lstrip("-").isdigit():
                    ids.add(int(nm))
                elif any(ch.isdigit() for ch in nm):
                    digit_names.append(nm)
            counts[obj.type.name] += 1
        except Exception:  # skip unreadable objects
            continue
    print(f"{name}: {counts}; numeric-id = {len(ids)}; digit-in-name = {len(digit_names)}")
    print("  digit-in-name samples:")
    for nm in sorted(set(digit_names))[:40]:
        print(f"    {nm}")


if __name__ == "__main__":
    for n in ["level0"]:
        probe(n)