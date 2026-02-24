# ClawCast v1.0.0

> as intelligence becomes a commodity the real skill of human intellect will inevitably be to curate and connect information. while using openclaw to automate your email inbox is helpful but in my opinion misses the potential this technology provides for us. clawcast is a first step in that direction for me, in shifting the view on agents as task automators, to thinking partners to develop ideas end-to-end with, leaving the heavy lifting to the artificial intelligence and using your organic intelligence to distill and steer the agent into what is actually meaningful.

## Release Summary

ClawCast v1.0.0 is the first stable public release of the cast/persona orchestration plugin for OpenClaw.

This release packages:
- cast switching and persona profiles
- shared context + context-v2 memory architecture
- deterministic prompt context assembly
- Cast Manager frontend served by plugin HTTP routes
- install/operator documentation for both users and agents

## Installation

Install from npm:

```bash
openclaw plugins install @talhas-laboratory/clawcast
```

Install from package archive:

```bash
openclaw plugins install /path/to/talhas-laboratory-clawcast-1.0.0.tgz
```

## Canonical Routes

- UI: `/cast-manager/`
- Alias redirect: `/cast-system/` -> `/cast-manager/`
- API: `POST /api/cast-manager`
- Health: `GET /health`

## Compatibility

- OpenClaw: `>=2026.2.21-2 <2027.0.0`
- Node.js: `>=22.12.0`
- OS: Linux, macOS, Windows (gateway-supported environments)

## Telegram and Channel Nuance

- Telegram mini app embedding is Telegram-specific.
- Non-Telegram users can still open the same frontend in browser via `/cast-manager/`.
- Backend features (`/cast`, `/context`, tools, API) remain usable across channels.

## Validation Performed

Release candidate passed:
- `npm run build`
- `npm test`
- `forge analyze`
- `forge map`
- `forge verify`
- `forge test`
- `npm pack --dry-run`

## Known Limitations

- Retrieval is lexical-plus first; vector retrieval is optional.
- Global `openclaw plugins doctor` can include unrelated warnings from other installed plugins.
- Response quality depends on cast profile quality and context/document hygiene.

## Security

Vulnerability reports:
- `talhaslaboratory@gmail.com`
