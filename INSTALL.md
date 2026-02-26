# ClawCast Install Guide

This guide is for OpenClaw users installing ClawCast from scratch.

## 1) Install plugin

From npm (recommended):

```bash
openclaw plugins install @talhas-laboratory/clawcast
```

From package archive (`.tgz`):

```bash
openclaw plugins install /absolute/path/to/talhas-laboratory-clawcast-1.0.2.tgz
```

For local development source:

```bash
openclaw plugins install -l /absolute/path/to/cast-system
```

## 2) Verify plugin loaded

```bash
openclaw plugins list
openclaw plugins doctor
```

You should see `ClawCast (clawcast)` as loaded.

## 3) Start OpenClaw gateway

```bash
openclaw gateway --allow-unconfigured --bind loopback --port 19001 --force
```

## 4) Open Cast Manager UI

Canonical URL:
- `http://127.0.0.1:19001/cast-manager/`

Alias URL (redirects to canonical):
- `http://127.0.0.1:19001/cast-system/`

## 5) API smoke checks

```bash
curl -i http://127.0.0.1:19001/health
curl -i -X POST http://127.0.0.1:19001/api/cast-manager \
  -H 'content-type: application/json' \
  --data '{"action":"listCasts"}'
```

## 6) Telegram vs non-Telegram usage

- Telegram users can access the same Cast Manager route through Telegram/OpenClaw integration.
- Non-Telegram users can use Cast Manager directly in browser at `/cast-manager/`.
- All channels can still use backend features (`/cast`, `/context`, tools, API).

## 7) Manual config fallback (only if needed)

If install does not auto-register, add this in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "clawcast": {
        "enabled": true,
        "source": "~/.openclaw/extensions/clawcast/dist/index.js"
      }
    }
  }
}
```

Then restart gateway.


## Security scanner note

ClawCast does not read environment variables to exfiltrate credentials.

If your environment reports static-analysis warnings, inspect the flagged lines and confirm they are configuration/runtime routing logic only.

Recommended verification:

```bash
openclaw plugins doctor
openclaw plugins list
```
