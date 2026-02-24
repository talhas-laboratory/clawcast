# ClawCast (OpenClaw Plugin)

stop using openclaw to automate your life. use it to explore your ideas.

ClawCast is an OpenClaw plugin for cast/persona management with shared context, scratchpad memory, and a Cast Manager UI.

## Install

Install from npm spec (recommended for public users):

```bash
openclaw plugins install @talhas-laboratory/clawcast
```

Install from packaged archive (`.tgz`):

```bash
openclaw plugins install /absolute/path/to/talhas-laboratory-clawcast-1.0.0.tgz
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
- Legacy alias: `/cast-system/` (HTTP redirect to `/cast-manager/`)

Example local browser URL:

- `http://127.0.0.1:19001/cast-manager/`

## API

- `POST /api/cast-manager`
- `GET /health`

Common actions:
- `listCasts`
- `switchCast`
- `getPromptContext`
- `autoCapture`
- `answerFromContext`
- `getContextSnapshot`
- `listContractRules`
- `setContractRule`
- `removeContractRule`

## Telegram + non-Telegram nuance

- Telegram mini app embedding is Telegram-specific.
- The same frontend can still be opened by non-Telegram users in browser via `/cast-manager/`.
- All channels can use backend capabilities (`/cast`, `/context`, tools, and API endpoints), even without mini app embedding.

## Current known limitations

- Deep semantic retrieval is lexical-plus first; vector retrieval is optional and not mandatory for setup.
- Plugin health checks can show unrelated warnings if other installed plugins are broken.
- Cast quality depends on cast profile + document hygiene; stale documents can reduce answer quality.

## Compatibility

- OpenClaw: `>=2026.2.21-2 <2027.0.0`
- Node.js: `>=22.12.0`
- OS: Linux, macOS, Windows (gateway-supported environments)
