#!/usr/bin/env python3
"""Verify icon coverage across lookup_items."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def main() -> int:
    li = json.loads((REPO / "data" / "lookup_items.json").read_text(encoding="utf-8-sig"))
    icons = REPO / "data" / "icons"
    no_path = []
    missing = []
    ok = 0
    for it in li:
        ip = it.get("iconPath") or ""
        if not ip:
            no_path.append(it)
            continue
        if (icons / f"{ip}.png").exists():
            ok += 1
        else:
            missing.append(it)
    print(f"items={len(li)} with_icon_path={len(li)-len(no_path)} ok={ok} missing_png={len(missing)} no_icon_path={len(no_path)}")
    print("no_icon_path sample:", [(it["id"], it["name"]) for it in no_path[:8]])
    print("missing_png sample:", [(it["id"], it["name"], it["iconPath"]) for it in missing[:8]])
    return 0


if __name__ == "__main__":
    sys.exit(main())
