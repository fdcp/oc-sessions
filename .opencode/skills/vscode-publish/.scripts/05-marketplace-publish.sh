#!/usr/bin/env bash
set -e
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"
CREDS="$SKILL_DIR/.assets/credentials.json"
NVM_INIT=$(python3 -c "import json; print(json.load(open('$CREDS'))['env']['nvm_init'])")
PROXY=$(python3 -c    "import json; print(json.load(open('$CREDS'))['env']['proxy'])")
MP_PAT=$(python3 -c   "import json; print(json.load(open('$CREDS'))['marketplace']['pat'])")

cd "$PROJECT_DIR"
eval "$NVM_INIT"
rm -f yarn.lock

unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
export HTTPS_PROXY="$PROXY"

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")

npx @vscode/vsce publish --no-yarn --pat "$MP_PAT"
echo "[marketplace] OK — zhaoxiuwei.oc-sessions v${VERSION} published"
echo "[marketplace] URL: https://marketplace.visualstudio.com/items?itemName=zhaoxiuwei.oc-sessions"
