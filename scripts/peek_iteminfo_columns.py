"""Peek at the ItemInfoData CSV header + a sample row to find an icon field."""
from pathlib import Path
import UnityPy

DATA = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data")
SHARED = DATA / "sharedassets0.assets"


def main():
    env = UnityPy.load(str(SHARED))
    target = None
    for obj in env.objects:
        if obj.type.name != "TextAsset":
            continue
        d = obj.read()
        script = ""
        for attr in ("m_Script", "script", "text"):
            v = getattr(d, attr, None)
            if isinstance(v, bytes):
                script = v.decode("utf-8", "ignore")
                break
            if isinstance(v, str):
                script = v
                break
        if "ItemKey" in script and "ITEMTYPE" in script:
            target = script
            nm = getattr(d, "m_Name", "") or ""
            print(f"found ItemInfoData-like TextAsset (m_Name={nm!r})")
            break
    if target is None:
        print("no TextAsset containing 'ItemKey' found")
        return
    text = target.lstrip("\ufeff")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    header = lines[0].split(",")
    print(f"rows={len(lines)-1} cols={len(header)}")
    for i, c in enumerate(header):
        val = ""
        if len(lines) > 1:
            vals = lines[1].split(",")
            val = vals[i] if i < len(vals) else ""
        print(f"  [{i}] {c.strip()!r}  e.g.={val.strip()!r}")


if __name__ == "__main__":
    main()