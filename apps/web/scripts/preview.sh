#!/bin/zsh
# Builds the static app, pins it on Pinata as a preview and prints the preview URLs.
# Usage: ./scripts/preview.sh [label]     (needs PINATA_JWT; read from ../../.env.local if present)
set -e
cd "${0:A:h}/.."
[[ -z $PINATA_JWT && -f ../../.env.local ]] && { set -a; . ../../.env.local >/dev/null 2>&1; set +a; unset PRIVATE_KEY PRIYA_KEY CFO_KEY RAVI_KEY MEERA_KEY PINATA_API_KEY PINATA_API_SECRET; }
[[ -n $PINATA_JWT ]] || { echo "PINATA_JWT is required"; exit 1; }
STAMP=${NEXT_PUBLIC_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
LABEL=${1:-preview}
NEXT_PUBLIC_BUILD_TIME=$STAMP pnpm -s build:ipfs > /tmp/tazor-preview-build.log 2>&1 || { tail -20 /tmp/tazor-preview-build.log; exit 1; }
ROOT=$(grep -E '^root' /tmp/tazor-preview-build.log | awk '{print $2}')
OUT=$(PIN_NAME="tazor-$LABEL-$STAMP" node scripts/ipfs-pin.mjs ipfs/site.car "$ROOT")
CID=$(echo "$OUT" | awk '/^cid/{print $2}')
echo "$OUT" | grep -E "^mode|matches"
mkdir -p ipfs && echo "$STAMP $LABEL $CID" >> ipfs/previews.txt
echo
echo "build stamp : $STAMP   (rebuild with NEXT_PUBLIC_BUILD_TIME=$STAMP for the same CID)"
echo "CID         : $CID"
echo "preview URL : https://$CID.ipfs.inbrowser.link/"
echo "contenthash : ipfs://$CID   (only for the FINAL preview)"
