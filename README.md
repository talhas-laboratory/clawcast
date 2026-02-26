# ClawCast (OpenClaw Plugin)

stop using openclaw to automate your life. use it to explore your ideas.

ClawCast is an OpenClaw plugin for cast/persona management with shared context, scratchpad memory, and a Cast Manager UI.

## Install

Install from npm spec (recommended):

```bash
openclaw plugins install @talhas-laboratory/clawcast
```

Install from packaged archive (`.tgz`):

```bash
openclaw plugins install /absolute/path/to/talhas-laboratory-clawcast-1.0.1.tgz
```

Install from local development source:

```bash
openclaw plugins install -l /absolute/path/to/cast-system
```

## Verify

```bash
openclaw plugins list
openclaw plugins doctor
```

## Canonical URLs

- Canonical UI: `/cast-manager/`
- Canonical app page: `/cast-manager/redesigned.html`
- Legacy alias: `/cast-system/` (redirects to `/cast-manager/`)
- API: `POST /api/cast-manager`
- Health: `GET /health`

---

## One-Shot Setup Tutorials

### 1) Browser only (no Telegram mini app)
Use this if users open ClawCast directly in browser.

```bash
openclaw gateway --allow-unconfigured --bind loopback --port 19001 --force
```

Open:
- `http://127.0.0.1:19001/cast-manager/`

No `miniapps.config.baseUrl` is required for browser-only usage.

### 2) VPS + public HTTPS domain (phone + browser + Telegram mini app)
Use this if users run OpenClaw on VPS and access from phone.

1. Keep gateway local:

```bash
openclaw gateway --allow-unconfigured --bind loopback --port 19001 --force
```

2. Put reverse proxy in front (Nginx/Caddy/Traefik) to expose HTTPS domain.
3. Set miniapps base URL in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "miniapps": {
        "config": {
          "baseUrl": "https://your-domain-or-tailnet/apps",
          "appsRoot": "~/.openclaw/workspace/apps/miniapps"
        }
      }
    }
  }
}
```

4. Restart gateway.

Then:
- Browser users: `https://your-domain-or-tailnet/cast-manager/`
- Telegram users: `/cast manager` opens mini app link from same origin.

### 3) VPS + Tailscale Serve (no public internet exposure)
Use this for private mobile access.

1. Run gateway on loopback (same as above).
2. Expose with Tailscale Serve HTTPS.
3. Set:

- `plugins.entries.miniapps.config.baseUrl = "https://<your-tailnet-host>/apps"`

4. Restart gateway.

Then open:
- `https://<your-tailnet-host>/cast-manager/`

### 4) Telegram mini app creation from scratch

1. Ensure `miniapps` plugin is enabled.
2. Ensure `miniapps.config.baseUrl` is set (HTTPS).
3. Ensure app manifest exists at:

- `~/.openclaw/workspace/apps/miniapps/cast-manager/app.json`

4. Confirm URL in manifest points to ClawCast app route:

```json
{
  "url": "/cast-manager/redesigned.html"
}
```

5. Restart gateway and run `/cast manager` in Telegram.

If Telegram says `Cast manager is not configured yet`, it means `miniapps.config.baseUrl` is missing or invalid.

---

## URL behavior by channel

- Telegram mini app: requires `miniapps.config.baseUrl`.
- Browser web app: does not require miniapps base URL if opened directly on reachable gateway URL.
- Backend cast features (`/cast`, `/context`, API tools): work across channels regardless of mini app embedding.

## Security scanner note

Some environments run heuristic static checks during plugin installation.

ClawCast does not use environment-variable credential forwarding logic for exfiltration. If warnings appear, review flagged lines and run:

```bash
openclaw plugins doctor
openclaw plugins list
```

## Common actions

- `listCasts`
- `switchCast`
- `getPromptContext`
- `autoCapture`
- `answerFromContext`
- `getContextSnapshot`
- `listContractRules`
- `setContractRule`
- `removeContractRule`

## Compatibility

- OpenClaw: `>=2026.2.21-2 <2027.0.0`
- Node.js: `>=22.12.0`
- OS: Linux, macOS, Windows (gateway-supported environments)
