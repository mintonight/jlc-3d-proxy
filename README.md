# JLC 3D Viewer Proxy

**[中文版](中文版.md)**

Reverse engineering of the JLC (JLCPCB/JLCFA) 3D model viewer API (https://3d-viewer.jlc.com) + a local HTTP proxy service.

**Core capability**: After a one-time browser login, upload model files via pure HTTP with **unlimited previews** and get shareable preview links.


## Reverse Engineering Findings

### The 5-Preview Limit

Anonymous users are limited to 5 previews. After a thorough examination of local storage (localStorage / sessionStorage / cookies) and static analysis of the frontend JS, it was confirmed that:

- **The counter is tracked server-side**, keyed by visitor identity (account/IP)
- The `countPreviewNum` API in the frontend is purely a post-hoc analytics call with **no enforcement logic**
- **The limit cannot be cleared locally**

### Logged-in vs Anonymous

| Behavior | Anonymous | Logged-in |
|----------|-----------|-----------|
| `windowLogin` | 401 | 200 → returns JWT |
| `token` request header | absent | JWT |
| `countPreviewNum` | ✅ called | ❌ skipped entirely |

Once logged in, the server skips the entire counting mechanism → effectively unlimited.

### API Architecture

Base URL: `https://api.forface3d.com/forface`

**Core upload pipeline** (fully reversed and reproduced):

```
genUploadFileUrl → OSS direct upload (PUT) → updateFileStatus → uploadModel → shareModel → previewShareModel → share URL
```

### Two Critical Signature Algorithms

**1. API signature** (used by `getWebSystemConfig` / `genUploadFileUrl`):

```js
sign = MD5( requestId + "NjVkczQxczRkNTZBQVMxRDU2MWQwMzJBQTFTRCAzMmExZDU2czFkMzFTMEQzc2RT" )
requestId = Date.now().toString()
```

**2. OSS direct-upload signature** (critical: `content-type` must be an empty string):

```
PUT
Content-MD5: <file MD5 in Base64>
Content-Type:                     ← must be empty string
Content-Disposition: attachment; filename*=UTF-8''<filename>
token: <JWT>
```

### Auth Chain

```
passport.jlc.com CAS login (QR code / credentials)
  → cookies: PROD-JLC-CAS-SID + tgc
  → windowLogin(appId=JLC_FORFACE&code=<ticket>)
  → returns JWT token
  → all subsequent requests carry the token header
```

### Shareable Preview Link

```
https://3d-viewer.jlc.com/share?modelId=<id>&tokenKey=<key>
```

Valid for 24 hours. Openable in any browser (including incognito). No login required to view.


## Quick Start

```bash
# 1. Install dependencies (first run includes Chromium download)
npm install

# 2. Start
npm start
# → http://localhost:3721
```

## Usage Flow

1. Open `http://localhost:3721`
2. Click **JLC Login** → a browser window pops up for QR/credential login → **browser closes automatically** (credentials saved)
3. Select a model file to upload → wait 5–60 seconds → receive a preview link, **auto-opens in a new window**
4. Repeat — unlimited uploads

## HTTP API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/status` | Check login status |
| GET | `/login?wait=1` | Launch browser login (SSE real-time progress) |
| POST | `/upload` | Upload file (multipart field: `file`), returns preview link |
| POST | `/logout` | Clear local credentials |

### Integration Examples

```python
import requests

# Upload (assuming already logged in)
with open('model.SLDPRT', 'rb') as f:
    r = requests.post('http://localhost:3721/upload', files={'file': f})
print(r.json())  # { ok, modelId, shareUrl, ... }
```

```bash
# CLI
curl -X POST http://localhost:3721/logout               # logout
curl "http://localhost:3721/login?wait=1"               # login
curl -F "file=@model.SLDPRT" http://localhost:3721/upload # upload
```

### Upload Response Example

```json
{
  "ok": true,
  "file": "eye.SLDPRT",
  "modelId": "2070790253148254208",
  "shareUrl": "https://3d-viewer.jlc.com/share?modelId=2070790253148254208&tokenKey=fbdc34eb...",
  "message": "Upload succeeded, preview link generated"
}
```

## Architecture

```
Browser Login (once)            Pure HTTP Upload (unlimited)
     │                              │
     ▼                              ▼
┌──────────┐                  ┌───────────┐
│ Playwright│ captures token   │ JlcClient │  Pure Node HTTP
│ popup     │──────────────▶   │ sign      │  genUploadFileUrl
│ login     │ writes creds.json│ OSS PUT   │  OSS direct upload
│ closes    │                  │ share     │  uploadModel
└──────────┘                  └─────┬─────┘
                                    │
                              ┌─────▼─────┐
                              │  Express   │  HTTP server
                              │  /upload   │  port 3721
                              └───────────┘
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `multer` | Receive file uploads |
| `playwright` | **Login only** — pops a browser to capture credentials, then closes |

## File Structure

```
jlc-3d-proxy/
├── src/
│   ├── server.js          # Express server + routes
│   ├── jlc-client.js      # Pure HTTP client (signing + upload)
│   └── login-manager.js   # Browser login + credential persistence
├── public/
│   └── index.html         # Frontend UI
├── package.json
├── .gitignore
├── README.md              # English (this file)
└── 中文版.md              # Chinese version
```

## Notes

- The service runs in a desktop environment (GUI required for the initial login)
- Login credentials (token) are valid for ~24h; re-login when expired
- `creds.json` and `browser-state/` contain sensitive data and are gitignored
- This project is for educational/research purposes only — please comply with JLC's terms of service
