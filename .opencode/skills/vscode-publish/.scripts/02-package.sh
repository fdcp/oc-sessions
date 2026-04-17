#!/usr/bin/env bash
set -e
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"
CREDS="$SKILL_DIR/.assets/credentials.json"
NVM_INIT=$(python3 -c "import json; print(json.load(open('$CREDS'))['env']['nvm_init'])")

cd "$PROJECT_DIR"
eval "$NVM_INIT"
rm -f yarn.lock
VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
npx @vscode/vsce package --no-dependencies --no-yarn --allow-missing-repository
echo "[package] OK — oc-sessions-${VERSION}.vsix"
