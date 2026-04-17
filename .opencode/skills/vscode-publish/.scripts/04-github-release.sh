#!/usr/bin/env bash
# 04-github-release.sh — Create GitHub Release and upload vsix asset
set -e
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"
CREDS="$SKILL_DIR/.assets/credentials.json"

GITHUB_USER=$(python3 -c "import json; print(json.load(open('$CREDS'))['github']['username'])")
GITHUB_PAT=$(python3 -c  "import json; print(json.load(open('$CREDS'))['github']['pat'])")
GITHUB_REPO=$(python3 -c  "import json; print(json.load(open('$CREDS'))['github']['repo'])")

cd "$PROJECT_DIR"
VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
VSIX="oc-sessions-${VERSION}.vsix"
TAG="v${VERSION}"

if [ ! -f "$VSIX" ]; then
  echo "[github-release] ERROR — $VSIX not found, run 02-package.sh first"
  exit 1
fi

RELEASE_JSON=$(curl -sf -X POST "https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/releases" \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "Content-Type: application/json" \
  -d "{\"tag_name\":\"${TAG}\",\"name\":\"${TAG}\",\"draft\":false,\"prerelease\":false}")

RELEASE_ID=$(echo "$RELEASE_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")

curl -sf -X POST "https://uploads.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?name=${VSIX}" \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"${VSIX}" > /dev/null

echo "[github-release] OK — https://github.com/${GITHUB_USER}/${GITHUB_REPO}/releases/tag/${TAG}"
