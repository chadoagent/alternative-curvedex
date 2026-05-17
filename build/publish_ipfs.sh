#!/bin/bash
# publish_ipfs.sh — build static bundle + ipfs add + pin on a remote node.
#
# Workflow (run from the local checkout):
#   1. Out-of-band: keep the remote IPFS host's $REMOTE_CURVEDEX_SRC in
#      sync with this checkout (rsync, or any sync mechanism you prefer).
#   2. This script SSHes to the host configured as `ovh` in ~/.ssh/config,
#      stages a filtered bundle in /tmp on the remote, bakes
#      __DYNAMIC_BASE and __CDX_API_BASE into index.html, runs
#      `ipfs add -r --cid-version=0 -Q`, pins the CID, republishes the
#      IPNS record under key "curvedex", and appends a record to
#      build/cid_history.jsonl locally.
#
# Default targets:
#   DYNAMIC_BASE  = https://llama.box           (cache.json + chains_config.json)
#   CDX_API_BASE  = https://t.llama.box/cdx-api (trade ohlc + history)
# Override via env: DYNAMIC_BASE=... CDX_API_BASE=... ./publish_ipfs.sh
#
# Output: CID printed to stdout + history line appended.

set -euo pipefail

DYNAMIC_BASE="${DYNAMIC_BASE:-https://llama.box}"
CDX_API_BASE="${CDX_API_BASE:-https://t.llama.box/cdx-api}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HISTORY="$SCRIPT_DIR/cid_history.jsonl"

# static file list — keep in sync with the inventory documented in README.md.
STATIC_FILES=(
    index.html
    styles.css
    app.js
    trade.js
    router.js
    portfolio.js
    yield.js
    swap.js
    panels.js
    info_tab.js
    gauge_weights.js
    aggregators.js
    logo.svg
    icons.svg
    chains_config.json
    bench_rpc.html
)

echo "[publish_ipfs] DYNAMIC_BASE=$DYNAMIC_BASE"
echo "[publish_ipfs] CDX_API_BASE=$CDX_API_BASE"
echo "[publish_ipfs] sshing ovh to build bundle..."

REMOTE_OUTPUT=$(ssh -o ConnectTimeout=15 -o BatchMode=yes ovh bash <<REMOTE
set -euo pipefail
SRC="${REMOTE_CURVEDEX_SRC:-$HOME/sites/curvedex}"
DST=/tmp/curvedex_ipfs_bundle
rm -rf "\$DST" && mkdir -p "\$DST"
for f in ${STATIC_FILES[@]}; do
  if [ -f "\$SRC/\$f" ]; then
    cp "\$SRC/\$f" "\$DST/"
  else
    echo "[warn] missing: \$f" >&2
  fi
done
# bake DYNAMIC_BASE + CDX_API_BASE into index.html (idempotent)
python3 - <<PYEOF
p = "\$DST/index.html"
s = open(p).read()
if "window.__DYNAMIC_BASE = ''" in s:
    s = s.replace("window.__DYNAMIC_BASE = ''", "window.__DYNAMIC_BASE = '$DYNAMIC_BASE'", 1)
if "__CDX_API_BASE" not in s:
    needle = "<script>window.__DYNAMIC_BASE = '$DYNAMIC_BASE';</script>"
    s = s.replace(needle, needle + "\n<script>window.__CDX_API_BASE = '$CDX_API_BASE';</script>")
open(p, "w").write(s)
PYEOF
# add to IPFS + pin (CIDv0 = Qm... for wider ENS/IPNS UI compat)
CID=\$(ipfs add -r --cid-version=0 -Q "\$DST")
ipfs pin add "\$CID" >/dev/null 2>&1 || true
# publish IPNS record under key "curvedex" — ENS contenthash points at this IPNS
# name once and stays static; each release just re-publishes the underlying CID.
IPNS_KEY="curvedex"
IPNS_NAME=\$(ipfs key list -l 2>/dev/null | awk -v k="\$IPNS_KEY" '\$2==k{print \$1}')
IPNS_PUB_OUT=""
if [ -n "\$IPNS_NAME" ]; then
    IPNS_PUB_OUT=\$(ipfs name publish --key="\$IPNS_KEY" --lifetime=720h --ttl=60s "/ipfs/\$CID" 2>&1 | tail -1)
fi
# extract version stamped in index.html
VER=\$(grep -oP "__APP_VERSION__ = '\K[^']+" "\$DST/index.html" | head -1)
SIZE=\$(du -sh "\$DST" | awk '{print \$1}')
# print machine-parseable line
echo "CID=\$CID"
echo "IPNS_NAME=\$IPNS_NAME"
echo "IPNS_PUB=\$IPNS_PUB_OUT"
echo "VER=\$VER"
echo "SIZE=\$SIZE"
REMOTE
)

CID=$(echo "$REMOTE_OUTPUT" | grep "^CID=" | head -1 | cut -d= -f2)
VER=$(echo "$REMOTE_OUTPUT" | grep "^VER=" | head -1 | cut -d= -f2)
SIZE=$(echo "$REMOTE_OUTPUT" | grep "^SIZE=" | head -1 | cut -d= -f2)

if [ -z "$CID" ]; then
    echo "[publish_ipfs] failed to obtain CID. Output was:" >&2
    echo "$REMOTE_OUTPUT" >&2
    exit 1
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$SCRIPT_DIR"
printf '{"ts":"%s","ver":"%s","cid":"%s","size":"%s","dynamic_base":"%s","cdx_api_base":"%s"}\n' \
    "$TS" "$VER" "$CID" "$SIZE" "$DYNAMIC_BASE" "$CDX_API_BASE" >> "$HISTORY"

echo ""
echo "[publish_ipfs] DONE"
echo "  version: $VER"
echo "  size:    $SIZE"
echo "  CID:     $CID"
echo "  URL:     https://ipfs.llama.box/ipfs/$CID/index.html"
echo ""
echo "  Pin on home node:  ipfs pin add $CID"
echo "  History appended to: $HISTORY"
