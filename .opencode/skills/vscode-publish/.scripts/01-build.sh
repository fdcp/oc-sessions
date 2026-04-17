#!/usr/bin/env bash
# 01-build.sh — Compile TypeScript via webpack
set -e
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"
CREDS="$SKILL_DIR/.assets/credentials.json"
NVM_INIT=$(python3 -c "import json; print(json.load(open('$CREDS'))['env']['nvm_init'])")

cd "$PROJECT_DIR"
eval "$NVM_INIT"
rm -f yarn.lock
npx webpack --mode production
echo "[build] OK — dist/extension.js updated"
