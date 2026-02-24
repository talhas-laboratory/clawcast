# ClawCast Agent Release Reference

Use this checklist to prepare ClawCast for open-source distribution.

## Required validation

```bash
npm run build
npm test
forge verify
forge test
npm pack --dry-run
```

Expected:
- build/test pass
- forge verify/test pass
- pack contains no backup artifacts

## Required runtime checks

```bash
openclaw plugins install -l .
openclaw plugins list
openclaw plugins doctor
```

Expected:
- plugin id `clawcast` loaded
- no Cast System contract violations

## Route/API contract

Canonical app route:
- `/cast-manager/`

Legacy alias route:
- `/cast-system/` -> redirect to `/cast-manager/`

API route:
- `POST /api/cast-manager`

Health route:
- `GET /health`

## Add app from scratch

1. Declare mini app in `openclaw.plugin.json`:

```json
{
  "miniApps": [
    {
      "path": "/cast-manager",
      "title": "Cast Manager",
      "description": "Manage AI agent personas"
    }
  ]
}
```

2. Provide static app files under `static/cast-manager/`.
3. Serve `/cast-manager` in plugin HTTP handler.
4. Keep one canonical route and redirect legacy routes.

## Non-Telegram support

- Mini app embedding is Telegram-specific.
- Browser access is channel-agnostic through `/cast-manager/`.
- Commands + API work across channels.

## Publish stop point

Stop before publishing; hand off to owner for npm auth and `npm publish`.
