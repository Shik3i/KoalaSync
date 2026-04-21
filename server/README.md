# KoalaSync Relay Server

A high-performance Node.js relay server for synchronized video playback.

## Key Features
- **Zero-Persistence**: No database. All state is held in RAM.
- **Privacy First**: No tracking, no logging of user data.
- **WebSocket Only**: High performance with minimal overhead.

## Setup

### Environment
Copy `.env.example` to `.env` and configure your settings.
```bash
PORT=3000
MAX_ROOMS=100
MAX_PEERS_PER_ROOM=20
MIN_VERSION=1.0.0
```

### Docker (Recommended)
The server is designed to run in a Docker container.
```bash
# Build from the repository root
docker build -t koala-sync-server -f server/Dockerfile .
```

### Manual Setup
```bash
cd server
npm install
npm start
```

## Security
- **Rate Limiting**: IP-based connection limits and socket-based event limits.
- **Token Handshake**: Requires a valid token defined in `shared/constants.js`.
- **In-Memory**: Rooms are automatically pruned after 2 hours of inactivity.
