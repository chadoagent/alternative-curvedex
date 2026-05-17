#!/usr/bin/env bash
# Публикует текущий прод CurveDEX в IPFS и обновляет IPNS-ключ curvedex
# (= contenthash ENS curvedex.eth). Один прогон синхронит .eth-зеркало с
# llama.box-продом. Запускать ПОСЛЕ деплоя Caddy-прода:  build/publish_ipfs.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="$(dirname "$SCRIPT_DIR")"
KEY=curvedex
IPNS=k51qzi5uqu5dm5yr0ehgx0jv4j8nstygx18i9m47hz14ay9fv74ten48wtihia
GW=https://ipfs.llama.box
VER="$(grep -o "__APP_VERSION__ = '[0-9a-z]*'" "$SITE/index.html" | head -1 | sed "s/.*'\([0-9a-z]*\)'.*/\1/")"
[ -n "$VER" ] || { echo "cannot read __APP_VERSION__ from index.html" >&2; exit 1; }

BUNDLE="$("$SCRIPT_DIR/build_static_bundle.sh")"
CID="$(ipfs add -rQ "$BUNDLE")"

# verify baked bundle by CID before publishing.
# NB: читаем содержимое в переменную и матчим bash-globом — НЕ через `| grep -q`
# (grep -q закрывает пайп после первого матча, ipfs cat ловит SIGPIPE и под
#  pipefail пайплайн ложно-падает).
IDX="$(ipfs cat "/ipfs/$CID/index.html")"
[[ "$IDX" == *"window.__DYNAMIC_BASE = 'https://llama.box';"* ]] \
  || { echo "BAKE VERIFY FAILED: __DYNAMIC_BASE not absolute in $CID" >&2; exit 1; }
GOT="$(printf '%s' "$IDX" | grep -o "__APP_VERSION__ = '[0-9a-z]*'" | head -1 | sed "s/.*'\([0-9a-z]*\)'.*/\1/")"
[ "$GOT" = "$VER" ] || { echo "VERSION MISMATCH bundle=$GOT prod=$VER" >&2; exit 1; }

ipfs pin add "/ipfs/$CID" >/dev/null
ipfs name publish --key="$KEY" --lifetime=72h "/ipfs/$CID" >/dev/null
RES="$(ipfs name resolve --nocache "/ipns/$IPNS")"
[ "$RES" = "/ipfs/$CID" ] || { echo "IPNS RESOLVE MISMATCH: $RES != /ipfs/$CID" >&2; exit 1; }

printf '{"ts":"%s","version":"%s","cid":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$VER" "$CID" >> "$SCRIPT_DIR/cid_history.jsonl"
rm -rf "$BUNDLE"
echo "PUBLISHED version=$VER cid=$CID"
echo "ipns=$IPNS  verify: $GW/ipfs/$CID/index.html"
