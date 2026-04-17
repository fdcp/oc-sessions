#!/usr/bin/env bash
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

RELEASE_RESPONSE=$(curl -s -X POST "https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/releases" \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "Content-Type: application/json" \
  -d "{\"tag_name\":\"${TAG}\",\"name\":\"${TAG}\",\"draft\":false,\"prerelease\":false}")

RELEASE_ID=$(python3 -c "import json,sys; print(json.loads('''${RELEASE_RESPONSE}''')['id'])")

curl -s -X POST "https://uploads.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?name=${VSIX}" \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"${VSIX}" > /dev/null

echo "[github-release] OK — https://github.com/${GITHUB_USER}/${GITHUB_REPO}/releases/tag/${TAG}"
