#!/usr/bin/env bash
set -e
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"

cd "$PROJECT_DIR"
VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
VSIX="oc-sessions-${VERSION}.vsix"
code --install-extension "$VSIX" --force
echo "[install] OK — $VSIX installed locally"
