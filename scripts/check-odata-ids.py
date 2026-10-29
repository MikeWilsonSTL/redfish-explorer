#!/usr/bin/env python3
"""List mockup resources whose @odata.id differs from where they are served.

A resource's @odata.id is its canonical URI, so in a short-form mockup it
should equal /redfish/v1 plus the directory path. Mismatches are almost
always copy-paste leftovers (Slot2 declaring Slot1, Output declaring Input).
The explorer flags these one resource at a time; this lists all of them.

    python3 scripts/check-odata-ids.py [MOCKUPS_DIR]
"""

import json
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else
            Path(__file__).resolve().parent.parent / "vendor/Redfish-Publications/mockups")
count = 0
for f in sorted(root.glob("*/**/index.json")):
    rel = f.parent.relative_to(root).parts
    served = "/redfish/v1" + "".join(f"/{p}" for p in rel[1:])
    try:
        declared = json.loads(f.read_text(encoding="utf-8")).get("@odata.id", "")
    except ValueError as e:
        print(f"{rel[0]}: bad JSON in {f}: {e}")
        continue
    declared = declared.split("#")[0].rstrip("/")
    if declared and declared != served:
        count += 1
        print(f"{rel[0]}: served {served}\n    declares {declared}")
print(f"{count} mismatches")
sys.exit(1 if count else 0)
