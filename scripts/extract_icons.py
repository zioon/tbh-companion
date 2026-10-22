"""Export item-icon sprites for every iconPath referenced by the bundled
lookup_items.json to data/icons/<iconPath>.png, skipping existing files.

Sprite names in sharedassets0 use "<PREFIX>_<id>" (e.g. Item_150101,
SWORD_300019); iconPath is the lowercase-dash form (item-150101,
sword-300019).

Both standalone sprites and SpriteAtlas-packed sprites are decoded through
UnityPy's SpriteHelper.get_image_from_sprite, which links a sprite to its
render data via m_RenderDataKey (GUID) — the atlas's m_RenderDataMap — and
applies the correct texture rect / packing rotation. The .resS file must be
attached so streamed atlas textures can be read.

Stage-box (STAGEBOX) items are NOT in lookup_items.json, so their band icons
are listed explicitly in BOX_BAND_ICONS below — one representative sprite per
9xxx band. Keep it in sync with `app/src/renderer/lib/boxIconPath.ts`, which
maps a box id to its iconPath.

Usage:
  python scripts/extract_icons.py
"""
from pathlib import Path
import json
import re

import UnityPy
from UnityPy.export.SpriteHelper import get_image_from_sprite

_SHARED = Path(r"D:\SteamLibrary\steamapps\common\TaskbarHero\TaskbarHero_Data") / "sharedassets0.assets"
_REPO = Path(__file__).resolve().parent.parent
_OUT = _REPO / "data" / "icons"

# iconPath "sword-300019" -> sprite name "SWORD_300019";
# materials use "Item_<id>" (title-case Item prefix)
SPRITE_RE = re.compile(r"^(?P<prefix>[a-z0-9]+)-(?P<id>\d+)$")

# Stage-box band icons (one per 9xxx band). The game reuses a single sprite
# across a band's difficulties, e.g. all of 940001/940101/940201 point at
# "Item_940001" in ItemInfoData.IconPath.
#   910 = normal monster box, 915 = plague common, 920 = stage boss box,
#   925 = plague stage boss, 930 = act boss box, 935 = plague act boss,
#   940 = Halloween normal (v1.3.0), 941 = Halloween stage boss (v1.3.0).
BOX_BAND_ICONS = [
    "item-910011",
    "item-915001",
    "item-920011",
    "item-925001",
    "item-930011",
    "item-935001",
    "item-940001",
    "item-941001",
]


def sprite_name_for_icon_path(icon_path: str) -> str | None:
    m = SPRITE_RE.match(icon_path)
    if not m:
        return None
    prefix = m.group("prefix")
    sid = m.group("id")
    if prefix == "item":
        return f"Item_{sid}"
    return f"{prefix.upper()}_{sid}"


def main() -> int:
    _OUT.mkdir(parents=True, exist_ok=True)
    items = json.loads((_REPO / "data" / "lookup_items.json").read_text(encoding="utf-8-sig"))
    wanted = {}  # spriteName -> iconPath (for missing PNGs only)
    for it in items:
        ip = it.get("iconPath") or ""
        if not ip:
            continue
        if (_OUT / f"{ip}.png").exists():
            continue
        sn = sprite_name_for_icon_path(ip)
        if sn:
            wanted.setdefault(sn, ip)

    # Stage-box band icons are not referenced by lookup_items.json.
    for ip in BOX_BAND_ICONS:
        if (_OUT / f"{ip}.png").exists():
            continue
        sn = sprite_name_for_icon_path(ip)
        if sn:
            wanted.setdefault(sn, ip)

    # resS must be attached: atlas (and many standalone) sprite textures stream
    # their pixel data from the .resS sidecar.
    env = UnityPy.load(str(_SHARED), str(_SHARED.with_suffix(".assets.resS")))
    exported = 0
    missing = []
    for obj in env.objects:
        if obj.type.name != "Sprite":
            continue
        name = obj.read().m_Name
        ip = wanted.pop(name, None)
        if ip is None:
            continue
        try:
            spr = obj.read()
            img = get_image_from_sprite(spr)
            if img is None:
                missing.append((name, ip))
                continue
            img.save(str(_OUT / f"{ip}.png"))
            exported += 1
        except Exception as e:
            print(f"  failed {name} ({ip}): {e}")
            missing.append((name, ip))

    remaining = {sn: ip for sn, ip in wanted.items()}
    print(f"exported {exported} new icons, missing in asset {len(missing) + len(remaining)}")
    for sn, ip in sorted(remaining.items())[:12]:
        print(f"  MISSING {sn} ({ip})")
    for sn, ip in missing[:6]:
        print(f"  FAILED {sn} ({ip})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
