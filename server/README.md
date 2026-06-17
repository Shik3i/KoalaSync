# KoalaSync Relay Server

A Node.js relay server for synchronized video playback.

## Key Features
- **Zero-Persistence**: No database. All state is held in RAM.
- **Privacy First**: No tracking, no persistent logging of user data.
- **WebSocket Only**: Minimal overhead with efficient transport.

## Setup

### Environment
Copy `.env.example` to `.env` and configure your settings.
```bash
PORT="3000"
MAX_ROOMS="1000"
MAX_PEERS_PER_ROOM="25"
MIN_VERSION="1.0.0"
# Optional: enables aggregate-only admin metrics on /health with Authorization: Bearer <token>
# Use a long random token, 32+ characters recommended.
ADMIN_METRICS_TOKEN=""

# Optional: Comma-separated list of allowed Chrome extension IDs. If unset, any Chrome extension origin is allowed.
# Note: This is an optional browser-side hardening mechanism, not real authentication.
ALLOWED_EXTENSION_IDS=""

# Optional: set to "1" to enable verbose connection, room-join/leave, and CORS logs in the console. Default is "0" (disabled).
DEBUG_LOGGING="0"
```

### Health & Metrics
`GET /` and `GET /health` are IP-rate-limited to 10 requests per minute per client IP. These health-style responses are cached server-side for 60 seconds and refreshed lazily on request. By default `/health` returns only basic service status, uptime, room count, connection count, and a timestamp.

If `ADMIN_METRICS_TOKEN` is set, requests with `Authorization: Bearer <token>` receive additional aggregate metrics such as total peers, average peers per room, max room size, active lobby count, rate-limit map sizes, and process memory usage. Wrong admin bearer attempts are separately limited to 5 requests per minute per client IP. The metrics response does not include room IDs, peer IDs, usernames, IP addresses, media titles, or other user-level data.

Use a long random `ADMIN_METRICS_TOKEN` of at least 32 characters. Shorter configured tokens still work, but the server logs a startup warning.

Generate a token with one of these commands:
```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

For Docker Compose deployments, set the generated value in `server/.env`:
```bash
ADMIN_METRICS_TOKEN=replace-with-a-long-random-token
```

When polling `/health` from Prometheus, Uptime Kuma, cron, or a load balancer, keep the interval comfortably below the public limit of 10 requests per minute per client IP. A 30-60 second interval is recommended for routine monitoring. Use the admin bearer token only from trusted monitoring hosts, and keep the Node server private behind Caddy or another trusted reverse proxy because IP-based limits depend on the configured proxy boundary.

### Docker (Recommended)
The server is available as a pre-built image on GHCR.
```bash
# Pull from GHCR
docker pull ghcr.io/shik3i/koalasync:latest

# Or build from the repository root
docker build -t koala-sync-server -f server/Dockerfile .
```
See [Docker network compose](../examples/docker-compose.caddy.example.yml) or [Static IP compose](../examples/docker-compose.ip.example.yml) in the root directory for ready-to-use Docker Compose files.

### Manual Setup
```bash
cd server
npm install
npm start
```

## Security
- **Rate Limiting**: IP-based connection limits and socket-based event limits.
- **Health Endpoint Throttle**: `GET /` and `GET /health` are limited to 10 requests per minute per IP, with 60-second lazy server-side response caching and stricter throttling for wrong admin bearer attempts.
- **Room Discovery Throttle**: Room-list refreshes are rate-limited server-side to one request every 10 seconds per socket.
- **Token Handshake**: Requires a valid token defined in the root `shared/constants.js`.
- **Single Source of Truth**: The server imports constants directly from the root `shared/` directory.
- **In-Memory**: Rooms are automatically pruned after 2 hours of inactivity.
- **Reverse Proxy Boundary**: The server trusts one reverse proxy hop for client IP detection. Keep the Node port private/firewalled so clients can only reach it through Caddy or another trusted proxy.

## Module Structure

| File | Purpose |
|---|---|
| `index.js` | Express + Socket.IO server: room management, relay loop, graceful shutdown |
| `rate-limiter.js` | Connection, event, health, and auth rate limiting with 6 functions + cleanup intervals |
| `ops.js` | Health endpoint helpers, metrics payload builder, auth validation |
