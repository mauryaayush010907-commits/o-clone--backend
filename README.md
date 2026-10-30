# Drift — Random Stranger Video & Text Chat

A complete, production-oriented Omegle-style application: real random matchmaking, **real peer-to-peer WebRTC video/audio**, real-time text chat, a reliable **Next stranger** flow, abuse reporting + moderation, and a modern responsive UI.

```
stranger-chat/
├── frontend/          # Vite + React (JSX) + React Router + Socket.IO client + native WebRTC
├── backend/           # Express + Socket.IO + Redis + MongoDB (signaling, matchmaking, moderation)
├── docker-compose.yml # Local Redis + MongoDB (+ optional Coturn)
└── (repo root also contains the sandbox preview harness — see "Sandbox preview" below)
```

> **Note on the root folder.** The repository root contains a small **Next.js sandbox preview** used by this workspace to run the product end-to-end. It is **not** the production frontend. The production frontend that you deploy on Vercel lives in `frontend/` (Vite + React) and is completely independent from the backend. Do not point Vercel at the repository root — point it at `frontend/`.

## Architecture

```
 Browser A                              Browser B
 ┌────────────┐   Socket.IO    ┌─────────────────────┐   Socket.IO   ┌────────────┐
 │ React app  │◄──────────────►│  backend (Node 20)  │◄──────────────►│ React app  │
 │            │                │  ┌───────────────┐  │                │            │
 │ getUserMedia                │  │ matchmaking   │  │                │ getUserMedia
 │ RTCPeerConnection           │  │ (Redis lists, │  │                │ RTCPeerConnection
 └─────┬────────┘              │  │ atomic LPOP)  │  │                └─────┬────────┘
       │                       │  └───────────────┘  │                      │
       │      WebRTC media (video+audio, P2P or TURN relay)                  │
       │        STUN: stun.l.google.com:19302      TURN: your Coturn host    │
       └───────────────────────────────►◄────────────────────────────────────┘
                          (direct — servers never see media)

 backend also: helmet, strict CORS, rate limits, payload validation,
 hashed-IP abuse reports → MongoDB, bans + admin audit API.
```

- **Media never touches the servers.** Only small signaling messages (SDP, ICE candidates) are relayed over Socket.IO.
- **Matchmaking is Redis-backed.** Queues are Redis lists; `LPOP` is atomic, so multiple backend instances can never double-match the same waiter. The `socket.io-redis-adapter` broadcasts events across instances.
- **Sessions have TTLs** in Redis; a periodic sweeper removes stale queue entries and orphaned match state.
- **Deterministic negotiation.** The longest-waiting user is always the *offerer* — no offer glare. ICE candidates arriving before the remote description are buffered client-side and flushed after `setRemoteDescription`. On ICE failure the offerer retries up to 2× with a fresh peer connection.

## Socket event contract (frontend ⇄ backend)

| Client → Server | Server → Client |
|---|---|
| `match:find {mode:"video"\|"text", prefs?}` (prefs optional) | `match:queued {mode, position, refined}` |
| `match:expand` (widen a refined search now) | `match:found {matchId, role:"offerer"\|"answerer", mode}` |
| `match:cancel` | `match:expanding {mode}` (visible auto/manual expansion) |
| `match:next {matchId}` | `match:cancelled` |
| `match:stop {matchId}` | `match:ended {matchId, reason:"next"\|"stopped"\|"disconnected"}` |
| `webrtc:offer {matchId, sdp, retry?}` | `webrtc:offer {matchId, sdp, retry?}` (forwarded) |
| `webrtc:answer {matchId, sdp}` | `webrtc:answer {matchId, sdp}` (forwarded) |
| `webrtc:ice-candidate {matchId, candidate}` | `webrtc:ice-candidate {matchId, candidate}` (forwarded) |
| `chat:message {matchId, text}` (≤500 chars, 6/2s) | `chat:message {matchId, messageId, from, text, ts}` (delivered once to both participants) |
| `chat:typing {matchId}` | `chat:typing {matchId}` (forwarded) |
| `user:report {matchId, reason, details}` | `user:report-ack`, `user:reported` (peer), `banned` |

**Security model:** clients never name a target socket. Every relayed event carries a `matchId`; the server verifies the sender is a *member* of that match in the shared store and forwards to the derived peer. Anything else is rejected with an `error {code, message}` event. Payloads are size-limited (SDP ≤ 64KB, ICE ≤ 4KB, message ≤ 500), rate-limited, and wrapped so malformed data can never crash the server.

## Optional matchmaking filters

All filters are **optional**. With none selected, users get standard instant random matchmaking — nothing changes. Preferences are validated server-side (`sanitizePrefs`: known country/language/interest slugs, gender/age enums, size caps) and persisted in Redis with TTL alongside the queue state.

- **Country** (multi, default worldwide) · **Gender** (everyone/male/female) · **Interests** (multi, overlap-based). The 18+ platform requirement is enforced independently by the age gate.
- **How matching works:** each user's filters describe who they *want*; an optional "about you" block (self-reported, explicitly marked unverified) describes who they *are*. A pair forms only when **both** users' explicit filters are satisfied by the other's profile. Users with unset profile fields are never excluded from the pool — they simply wait for the filtering side to widen.
- **No silent fallback:** a user with active filters enters *refined* mode (`refined: true` in `match:queued`). After `PREFS_PATIENCE_MS` (default 25s) the server **visibly** expands their search (`match:expanding`), or the user clicks "Match with anyone" (`match:expand`) to expand immediately. Expansion relaxes only the user's *own* filters — the other side's unexpanded filters still apply, and safety rules (mode separation, bans) are never bypassed.
- UI: collapsible **Advanced filters** panel on both chat pages (collapsed by default, active-filter count badge, Reset button, localStorage persistence). Start buttons always work with zero configuration. `GET /api/meta` serves the shared filter vocabulary.

## Quickstart (local)

```bash
# 1. Infrastructure (Redis + MongoDB)
docker compose up -d

# 2. Backend  (http://localhost:10000)
cd backend
cp .env.example .env         # defaults work for local dev
npm install
npm run dev

# 3. Frontend (http://localhost:5173, proxies /api + /socket.io to :10000)
cd frontend
npm install
npm run dev

# 4. Test with two browsers/tabs:
#    one incognito window on one machine + one normal window on another
#    (or two browsers on the same machine), both on http://<host>:5173
```

Run the backend test suite (matchmaker + full signaling over real sockets):

```bash
cd backend && npm test
```

## Environment variables

### backend/.env

| Var | Description |
|---|---|
| `PORT`, `HOST` | Listen address (default `0.0.0.0:10000`) |
| `FRONTEND_URL` | Comma-separated CORS origins (required in production) |
| `REDIS_URL` | e.g. `redis://redis:6379` — **required for production** (atomic matchmaking) |
| `MONGODB_URI` | e.g. `mongodb://mongodb:27017/drift` — **required for production** (reports/bans) |
| `STUN_URLS` | Extra STUN servers (Google STUN always included) |
| `TURN_URL` | e.g. `turn:turn.example.com:3478` |
| `TURN_USERNAME` / `TURN_PASSWORD` | Static TURN auth (simple setups) |
| `TURN_USE_CONFIG=true` + `TURN_STATIC_SECRET` | **Recommended:** mint short-lived Coturn credentials (1h TTL) per request via `/api/ice-servers`; the secret never reaches the browser |
| `HASH_SALT` | Salt for IP hashing — long random string |
| `ADMIN_API_KEY` | Enables `/api/admin/*` (leave empty to disable) |
| `MATCH_FIND_COOLDOWN_MS`, `SESSION_TTL_MS`, `QUEUE_MAX_AGE_MS` | Tuning |

### frontend/.env

| Var | Description |
|---|---|
| `VITE_API_URL` | **Production.** Backend origin (e.g. `https://drift-api.onrender.com`). Baked into the bundle at build time. |
| `VITE_SOCKET_URL` | **Production.** Socket.IO origin. Usually the same as `VITE_API_URL`. |
| `VITE_BACKEND_URL` | **Dev only.** The host the Vite dev proxy forwards `/api` and `/socket.io` to. Defaults to `http://localhost:10000`. Has zero effect on the production bundle. |

`VITE_*` variables are read at `npm run build` time and **baked into the static bundle** (Vite convention). Changing them on Vercel requires a redeploy.

## WebRTC, STUN & TURN

- The browser gets `[{urls:[stun…]}, {urls:[turn…], username, credential}]` from `GET /api/ice-servers`.
- Without TURN, most NATs still connect via host/srvreflexive candidates; **heavy NATs (symmetric) need TURN.**
- On `iceconnectionstatechange === "failed"`, the UI offers a retry; the offerer auto-retries negotiation up to 2×, and TURN (when configured) provides the relay fallback.

### Coturn on a VPS (Ubuntu/Debian)

```bash
sudo apt update && sudo apt install -y coturn
# /etc/coturn/turnserver.conf
listening-ip=203.0.113.5          # your public IP
external-ip=203.0.113.5
realm=drift.example.com
use-auth-secret
static-auth-secret=<64 hex chars>
use-alt-auth-secret
api-auth-secret=<64 hex chars>
min-port=49152
max-port=65535
no-tls
fingerprint
```

```bash
sudo systemctl enable --now coturn
# firewall: open 3478/udp+tcp and 49152-65535/udp
sudo ufw allow 3478/udp && sudo ufw allow 3478/tcp && sudo ufw allow 49152:65535/udp
```

Then in `backend/.env`:

```
TURN_URL=turn:203.0.113.5:3478
TURN_USE_CONFIG=true
TURN_STATIC_SECRET=<the static-auth-secret above>
```

Verify: `turnutils_uclient -t -u <user> -w <pass> 203.0.113.5` (credentials from `curl http://localhost:10000/api/ice-servers`).

## Deployment

`frontend/` and `backend/` are **completely independent** — each has its own `package.json`, its own `start` script, and its own runtime. Neither starts the other; the only link is the two env variables below.

### Frontend → Vercel

| Vercel setting | Value |
|---|---|
| **Project root** | repository root (don't change) |
| **Root Directory** | `frontend` |
| **Framework Preset** | Vite (auto-detected) |
| **Build Command** | `npm run build` (default; comes from `frontend/package.json`) |
| **Output Directory** | `dist` (default; comes from `frontend/vite.config.js`) |
| **Install Command** | `npm install` (default) |
| **Environment Variables** | `VITE_API_URL`, `VITE_SOCKET_URL` (see below) |

Set these in **Project → Settings → Environment Variables**:

```
VITE_API_URL=https://drift-api.onrender.com
VITE_SOCKET_URL=https://drift-api.onrender.com
```

The two URLs are usually the same (the backend serves both REST and Socket.IO on one origin). Vite bakes them into the static bundle at build time — a redeploy is required after changing them.

### Backend → Render

| Render setting | Value |
|---|---|
| **Service Type** | Web Service |
| **Root Directory** | `backend` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | Standard or higher (free tier may have cold starts / WebSocket timeouts) |

Set these in **Environment → Environment Variables**:

```
NODE_ENV=production
# Render injects PORT automatically; do NOT set it manually.
FRONTEND_URL=https://drift.vercel.app
REDIS_URL=rediss://default:<password>@<host>:<port>     # Upstash or Render Redis
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/drift # MongoDB Atlas
HASH_SALT=<long random string>
ADMIN_API_KEY=<long random string>                      # optional; enables /api/admin/*
# STUN / TURN (optional but recommended for NAT-traversal reliability)
TURN_URL=turn:turn.example.com:3478
TURN_USE_CONFIG=true
TURN_STATIC_SECRET=<the static-auth-secret in your Coturn config>
TURN_INSTANCE=drift
```

`HOST` defaults to `0.0.0.0` (Render's requirement). `PORT` is read from `process.env.PORT` — Render sets it automatically. The backend refuses to boot in `NODE_ENV=production` if `FRONTEND_URL` is missing, still set to `localhost`, or still points at `127.0.0.1`.

### Verifying the deployment

```bash
# 1) Backend health (should be ok:true, stores.{state,moderation} set)
curl https://drift-api.onrender.com/api/health
curl https://drift-api.onrender.com/api/stats

# 2) CORS: the Vercel origin should be the only allowed browser origin
curl -i -H "Origin: https://drift.vercel.app" https://drift-api.onrender.com/api/stats
# → no "Access-Control-Allow-Origin" wildcard
curl -i -H "Origin: https://evil.com" https://drift-api.onrender.com/api/stats
# → CORS rejection (no Allow-Origin header)

# 3) WebSocket: socket.io-client should connect over HTTPS
node -e "const{io}=require('socket.io-client');const s=io('https://drift-api.onrender.com',{transports:['websocket']});s.on('connect',()=>{console.log('OK',s.id);s.close();process.exit(0)});s.on('connect_error',e=>{console.error('FAIL',e.message);process.exit(1)});setTimeout(()=>{console.error('TIMEOUT');process.exit(2)},8000);"
```

### Other platforms

- **Railway:** same as Render, from `backend/`.
- **Fly.io / VPS:** `cd backend && docker build -t drift-api . && docker run -p 10000:10000 drift-api` (or `pm2 start src/server.js`).
- **Custom reverse proxy:** forward `https://api.example.com` to the backend; ensure WebSocket upgrade is forwarded (Caddy, nginx, Caddy are all fine; example in `/etc/nginx/sites-enabled/api.conf`: see "Scaling out" below).

### Scaling out

- Run N backend instances behind a load balancer with sticky sessions **off** — state lives in Redis (queues, matches, counters) and the Socket.IO Redis adapter relays events. No per-instance state is authoritative.
- MongoDB Atlas M0 + a small Redis (1GB) comfortably support thousands of concurrent conversations; the bottleneck in stranger chat is TURN media, not signaling.

#### nginx example (for VPS or behind Render Frontend/CDN)

```nginx
upstream drift_api {
  server 127.0.0.1:10000;
  keepalive 64;
}

server {
  listen 443 ssl http2;
  server_name api.drift.example.com;
  ssl_certificate     /etc/letsencrypt/live/api.drift.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.drift.example.com/privkey.pem;

  location / {
    proxy_pass http://drift_api;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection        "";
    # WebSocket / Socket.IO upgrade
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";
    proxy_read_timeout 90s;     # long-lived sockets
    proxy_send_timeout 90s;
  }
}
```

Caddy equivalent is one line: `reverse_proxy api.drift.example.com localhost:10000` (Caddy forwards WebSocket upgrades automatically).

## Real video call testing

1. Start backend + frontend (recipe above) on a machine with a public tunnel or on deployed hosts.
2. Open **two different browsers or two different devices** (phone + laptop is the real test — different NATs).
3. Both click **Start Video Chat** → you should see and hear each other within a few seconds.
4. Verify the checklist:

- [ ] Both see the other's live camera feed (not a frozen frame — move and check)
- [ ] Both hear each other's voice
- [ ] Mute button silences your mic for the peer
- [ ] Camera-off shows a blank feed to the peer
- [ ] Text messages arrive verbatim, instantly
- [ ] **Next** closes the call, notifies the peer, and re-matches without page refresh
- [ ] **Stop** tears everything down
- [ ] Closing one browser shows “stranger disconnected” to the other
- [ ] `GET /api/stats` returns to 0 online after both close (no stale sessions)

Browser E2E (UI flow with fake media): `cd frontend && npx playwright install && npm run test:e2e`.

## Safety, reporting & moderation

- In-app **Report** (every chat): validated server-side, stored (MongoDB) as `{reason, details, reporterHash, reportedHash, matchId}`, peer notified, 3 reports/hour per socket, 5/hour per IP on the HTTP route.
- **Bans** are by hashed IP with expiry; banned sockets are disconnected on connect.
- **Admin API** (header `x-admin-key: $ADMIN_API_KEY`):

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" https://api.drift.example.com/api/admin/reports
curl -X POST -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"resolved","note":"banned 24h","banMinutes":1440}' \
  https://api.drift.example.com/api/admin/reports/<reportId>
curl -H "x-admin-key: $ADMIN_API_KEY" https://api.drift.example.com/api/admin/stats
```

- **What is stored:** hashed IPs, report metadata, bans, admin audit entries. **What is never stored:** video, audio, chat text, recordings. Full details in the in-app Privacy Policy.

## What is verified vs. what needs your infrastructure

| Area | Status |
|---|---|
| Backend test suite (matchmaker semantics, race safety, signaling relay, authz, rate limits, validation) | ✅ 23/23 passing (`cd backend && npm test`) |
| Frontend production build (Vite) | ✅ compiles clean |
| Sandbox preview build (root Next.js harness, real-time + Postgres reports) | ✅ builds & healthcheck passing |
| Live two-device video over the internet | ⚠️ Requires your deployment + TURN for symmetric NATs — follow the real call checklist |
| Playwright E2E | ✅ Spec provided; run locally against the full stack (needs a browser download) |
| MongoDB persistence path | ⚠️ Same code paths run in tests via the store interface; run with Atlas for the production path |

## Sandbox preview (this repository root)

The sandbox that hosts this workspace cannot run a raw Socket.IO/Redis server, so the repo root also contains a small Next.js harness that runs the **same product** against the sandbox runtime: real WebRTC, real matchmaking, live connection counts, and **MongoDB-backed** connections/matches/reports — with signaling over a persistent event stream instead of Socket.IO (identical event contract). The production application you deploy is `frontend/` + `backend/` as specified.

The sandbox requires a local MongoDB instance on `127.0.0.1:27017`:

```bash
# download + run a single mongod binary (no apt install needed)
curl -sSLO https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-debian12-7.0.16.tgz
tar -xzf mongodb-linux-x86_64-debian12-7.0.16.tgz
./mongodb-linux-x86_64-debian12-7.0.16/bin/mongod --dbpath ./mongo-data --bind_ip 127.0.0.1 --port 27017 --logpath mongod.log --logappend --quiet --fork
# .env  →  MONGODB_URI=mongodb://127.0.0.1:27017/drift
```
