## Version Bump Rules

| Change type | Which part to bump |
|---|---|
| Bug fix / minor tweak | patch: `0.8.0 → 0.8.1` |
| New feature (backward-compat) | minor: `0.8.0 → 0.9.0` |
| Breaking/restructure | major: `0.8.0 → 1.0.0` |

## Git Commit Message Format

```
v{VERSION}: {short imperative description}
```

Examples:
- `v0.8.0: remove batch delete, part type chips, add DISPLAY/EXPORT tabs`
- `v0.7.0: add session search, todos panel, token cost display`

## GitHub Release Format

- **Tag**: `v{VERSION}` (e.g. `v0.8.0`)
- **Title**: `v{VERSION}`
- **Body**: same as git commit message
- **Asset**: `oc-sessions-{VERSION}.vsix`

## VSIX Naming

```
oc-sessions-{VERSION}.vsix
```

## Marketplace Publish Rules

- `vsce publish` will error `already exists` if version not bumped first
- Must use `--no-yarn` (no yarn.lock in repo)
- Must unset conflicting proxy env vars before setting the correct proxy
- Proxy: `http://172.16.5.77:8889` (NOT `172.16.5.2`)
- `vsce publish` always runs the prepublish webpack step — no need to build separately

## Proxy Troubleshooting

```bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
export HTTPS_PROXY=http://172.16.5.77:8889
```

The environment may have a stale `HTTP_PROXY=http://172.16.5.2:8889` which causes `ECONNREFUSED`. Always unset all proxy vars first, then set only `HTTPS_PROXY` with the correct address.

## README Update Checklist

Before publishing, verify README reflects current version:
- [ ] VSIX filename in install command matches new version
- [ ] Features list matches current functionality
- [ ] Settings table is up to date
