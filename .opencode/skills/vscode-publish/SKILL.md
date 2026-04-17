# vscode-publish Skill

Handles the full release pipeline for the `oc-sessions` VS Code extension: README update → build → package → local install → GitHub Release → Marketplace publish.

## Trigger Scenarios

Load this skill when the user says any of:
- "发布" / "publish" / "release"
- "更新 GitHub" / "推送" / "push to marketplace"
- "打包安装" / "本地安装"
- "更新 README 然后发布"

## Resources

All credentials are stored in `.assets/credentials.json`.

**First-run prompt** — if `.assets/credentials.json` is missing or any field is empty, ask the user:
1. GitHub username
2. GitHub PAT (needs `repo` + `write:packages` scope)
3. GitHub repo name
4. VS Code Marketplace publisher name
5. VS Code Marketplace PAT (Azure DevOps PAT with `Marketplace (Publish)` scope)
6. HTTP proxy address (leave blank if none)

Then write them to `.assets/credentials.json` using the template:
```json
{
  "github": { "username": "", "email": "", "pat": "", "repo": "" },
  "marketplace": { "publisher": "", "pat": "" },
  "env": { "proxy": "", "node_version": "20", "nvm_init": "source /root/.nvm/nvm.sh && nvm use 20" }
}
```

## Execution Steps

### Step 0 — Determine scope

Ask (or infer from context) which steps to run:
- **Local only**: steps 1–3
- **Full release**: steps 1–6

### Step 1 — Bump version in `package.json`

Determine bump type from context (see `.ref/publish-standards.md`).
Edit `package.json` `"version"` field directly.

### Step 2 — Update README

Check `.ref/publish-standards.md` README checklist:
- Update VSIX filename in install command
- Update features list if functionality changed

### Step 3 — Build + Package

```bash
bash .opencode/skills/vscode-publish/.scripts/01-build.sh
bash .opencode/skills/vscode-publish/.scripts/02-package.sh
```

Verify output: `oc-sessions-{VERSION}.vsix` exists.

### Step 4 — Local install + verify

```bash
bash .opencode/skills/vscode-publish/.scripts/03-install-local.sh
```

Tell user to **Reload Window** (`Ctrl+Shift+P → Developer: Reload Window`) and verify.
Wait for user confirmation before proceeding to Step 5.

### Step 5 — Git commit + push

```bash
cd /workspace/workspace_vscode_plugins/oc_sessions
git add -A
git commit -m "v{VERSION}: {description}"
git push origin main
```

Commit message format: see `.ref/publish-standards.md`.

### Step 6 — GitHub Release

```bash
bash .opencode/skills/vscode-publish/.scripts/04-github-release.sh
```

Verify output URL: `https://github.com/{user}/{repo}/releases/tag/v{VERSION}`

### Step 7 — Marketplace Publish

```bash
bash .opencode/skills/vscode-publish/.scripts/05-marketplace-publish.sh
```

Expected terminal output:
```
[marketplace] OK — zhaoxiuwei.oc-sessions v{VERSION} published
```

**If error `already exists`**: version was not bumped — go back to Step 1.
**If error `ECONNREFUSED`**: proxy conflict — the script already handles this, but check credentials.json proxy address.

## Output Standard

After completing all steps, report:

```
✅ v{VERSION} released

- Local install:   oc-sessions-{VERSION}.vsix installed
- Git commit:      {SHORT_SHA} — v{VERSION}: {description}
- GitHub Release:  https://github.com/{user}/{repo}/releases/tag/v{VERSION}
- Marketplace:     https://marketplace.visualstudio.com/items?itemName={publisher}.oc-sessions
```

## Known Issues & Fixes

| Symptom | Cause | Fix |
|---|---|---|
| `already exists` on marketplace publish | Version not bumped | Bump version in package.json first |
| `ECONNREFUSED 172.16.5.2:8889` | Stale `HTTP_PROXY` env var | Script unsets all proxy vars before setting correct one |
| `yarn failed with exit code 127` | `yarn.lock` present but yarn not installed | Script deletes `yarn.lock` before publish |
| `Aborted` on `vsce unpublish` | Interactive confirmation required | Not needed — just bump version and republish |

## File Map

```
.opencode/skills/vscode-publish/
├── SKILL.md                        this file
├── .assets/
│   └── credentials.json            GitHub PAT, Marketplace PAT, proxy config
├── .scripts/
│   ├── 01-build.sh                 webpack production build
│   ├── 02-package.sh               vsce package → .vsix
│   ├── 03-install-local.sh         code --install-extension
│   ├── 04-github-release.sh        create GitHub Release + upload vsix
│   └── 05-marketplace-publish.sh   vsce publish with proxy + PAT
└── .ref/
    └── publish-standards.md        version bump rules, commit format, checklist
```
