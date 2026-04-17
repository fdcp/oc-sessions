#!/usr/bin/env bash
# 05-marketplace-publish.sh — Publish vsix to VS Code Marketplace and verify
set -e
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"
CREDS="$SKILL_DIR/.assets/credentials.json"
NVM_INIT=$(python3 -c "import json; print(json.load(open('$CREDS'))['env']['nvm_init'])")
PROXY=$(python3 -c    "import json; print(json.load(open('$CREDS'))['env']['proxy'])")
MP_PAT=$(python3 -c   "import json; print(json.load(open('$CREDS'))['marketplace']['pat'])")
PUBLISHER=$(python3 -c "import json; print(json.load(open('$CREDS'))['marketplace']['publisher'])")

cd "$PROJECT_DIR"
eval "$NVM_INIT"
rm -f yarn.lock

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
VSIX="oc-sessions-${VERSION}.vsix"

# Ensure vsix exists
if [ ! -f "$VSIX" ]; then
  echo "[marketplace] ERROR — $VSIX not found, run 02-package.sh first"
  exit 1
fi

# Verify vsix does not contain credentials
if unzip -l "$VSIX" | grep -q "credentials.json"; then
  echo "[marketplace] ERROR — vsix contains credentials.json! Add .opencode/** to .vscodeignore and re-package."
  exit 1
fi

# Proxy must use uppercase
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
export HTTPS_PROXY="$PROXY"

# Publish using pre-built vsix (not re-build)
npx @vscode/vsce publish --packagePath "$VSIX" --pat "$MP_PAT"

echo "[marketplace] Published zhaoxiuwei.oc-sessions v${VERSION} — verifying..."

# API verification: check flags = validated (may take a few seconds to propagate)
for i in 1 2 3 4 5; do
  sleep 5
  RESULT=$(curl -s -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json;api-version=6.1-preview.1" \
    -d "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"${PUBLISHER}.oc-sessions\"}]}],\"flags\":1}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = d['results'][0]['extensions'][0]['versions'][0]
print(v['version'], v.get('flags', 'unknown'))
")
  VER=$(echo "$RESULT" | awk '{print $1}')
  FLAGS=$(echo "$RESULT" | awk '{print $2}')
  if [ "$VER" = "$VERSION" ] && [ "$FLAGS" = "validated" ]; then
    echo "[marketplace] OK — v${VERSION} validated ✓"
    echo "[marketplace] URL: https://marketplace.visualstudio.com/items?itemName=${PUBLISHER}.oc-sessions"
    exit 0
  fi
  echo "[marketplace] Waiting for validation... attempt $i/5 (current: $VER / $FLAGS)"
done

echo "[marketplace] WARNING — v${VERSION} published but validation status not yet confirmed."
echo "  Check manually: flags should be 'validated', not 'none'"
echo "  If 'none' with secrets error — vsix contains sensitive files, bump version and re-publish after fixing .vscodeignore"
