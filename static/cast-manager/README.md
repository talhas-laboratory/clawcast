# Cast Manager Mini App

A web-based interface for managing Cast System personas, profiles, and context.

## 🚀 Quick Access

**Local URL:** http://localhost:3456  
**Network URL:** https://talhas-laboratory.tailefe062.ts.net:3456 (if Tailscale connected)

## 📱 Features

### 1. Cast List (Sidebar)
- View all your casts
- Switch between casts with one click
- See document counts at a glance
- Active cast highlighted with badge

### 2. Profile Editor
- Edit cast name and profile
- Full Markdown/YAML editing
- Save changes instantly
- Export cast to ZIP

### 3. Context Manager
- Upload documents (PDF, MD, TXT, JSON)
- Drag & drop file upload
- View indexed documents
- See token counts and file sizes
- Remove documents

### 4. Memory Viewer
- Browse cast memories
- Filter by importance (normal, high, critical)
- View timestamps
- See shared vs private memories

### 5. Handoffs
- View pending messages from other casts
- See who sent what and when
- Mark handoffs as read

## 🎨 UI Overview

```
┌─────────────────────────────────────────────────────────────┐
│ 🎭 Cast Manager          [🔵 Active: Software Developer]    │
├──────────────┬──────────────────────────────────────────────┤
│              │  [Profile] [Context] [Memory] [Handoffs]    │
│  YOUR CASTS  ├──────────────────────────────────────────────┤
│              │                                              │
│  🎭 System   │  Name: Software Developer                    │
│     Architect│                                              │
│     (1 docs) │  [Edit Profile Text Area]                    │
│              │                                              │
│  💻 Software │  [💾 Save Profile] [📦 Export Cast]          │
│     Developer│                                              │
│     👈 ACTIVE│                                              │
│              │                                              │
│  🔬 Research │                                              │
│     Analyst  │                                              │
│     (0 docs) │                                              │
│              │                                              │
│  [+ Create   │                                              │
│   New Cast]  │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

## 🔌 Backend API

The Mini App connects to a local API server:

### Endpoints

**POST /api/cast-manager**
```json
{
  "action": "listCasts" | "switchCast" | "getProfile" | 
            "saveProfile" | "listContext" | "getMemory" | "getHandoffs",
  ...params
}
```

**POST /api/cast-manager/upload**
- Multipart form upload
- Requires: `castId`, `files`

## 🚀 Starting the Server

```bash
# From workspace directory
node cast-system/api-server.js

# Or use the startup script
./cast-system/start-api.sh
```

Server runs on port 3456 by default.

## 🔗 Integration with OpenClaw

The Cast Manager can be accessed:
1. **Direct URL** - Open browser to http://localhost:3456
2. **Telegram Mini App** - Add to your Mini Apps menu
3. **Through /app command** - If registered with OpenClaw

## 📝 Using in Telegram

Once the server is running, you can access it via:
- Direct link: http://localhost:3456
- Or add to OpenClaw Mini Apps menu

## 🛠️ Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS, Telegram WebApp SDK
- **Backend:** Node.js, Express
- **File Upload:** Multer
- **Design:** Dark theme, Inter font, CSS Grid/Flexbox

## 🔒 Security

- CORS enabled for local development
- File uploads restricted to safe extensions
- Paths validated before file operations
