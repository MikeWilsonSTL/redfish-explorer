#!/usr/bin/env bash
# Fetch (or update) the DMTF mockups and JSON schemas into vendor/.
# Sparse checkout of DMTF/Redfish-Publications: mockups (~32 MB) and
# json-schema (~250 MB). Rerun after a new DMTF release to pick it up.
set -euo pipefail
cd "$(dirname "$0")/.."
dest=vendor/Redfish-Publications
if [[ -d $dest/.git ]]; then
  git -C "$dest" pull --ff-only --quiet
else
  git clone --quiet --depth 1 --filter=blob:none --sparse \
    https://github.com/DMTF/Redfish-Publications.git "$dest"
fi
git -C "$dest" sparse-checkout set mockups json-schema
git -C "$dest" log -1 --format='DMTF Redfish-Publications at %h (%cd)'
