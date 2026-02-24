# Releasing ClawCast (Stop-Before-Publish Workflow)

This file documents the exact release process for this plugin.

## 1) Preflight

```bash
npm run build
npm test
forge verify
forge test
npm pack --dry-run
```

## 2) Build package artifact

```bash
npm pack
```

Expected artifact:
- `talhas-laboratory-clawcast-1.0.0.tgz`

## 3) Smoke install checks

```bash
openclaw plugins install -l .
openclaw plugins install ./talhas-laboratory-clawcast-1.0.0.tgz
openclaw plugins list
openclaw plugins doctor
```

## 4) Runtime/UI checks

Run gateway and verify:
- `/health` returns plugin status JSON
- `/cast-manager/` loads UI
- `/cast-system/` redirects to `/cast-manager/`
- `POST /api/cast-manager` with `{"action":"listCasts"}` returns success

## 5) GitHub release prep

- Tag: `v1.0.0`
- Attach:
  - plugin `.tgz`
  - checksums
  - release notes

## 6) NPM publish (owner step)

Publish command (owner-auth only):

```bash
npm publish --access public
```

Install command for users:

```bash
openclaw plugins install @talhas-laboratory/clawcast
```

## 7) Stop point

Automation/agent should stop before `npm publish` unless explicitly instructed by owner.
