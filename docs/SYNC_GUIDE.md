# KoalaSync Protocol Synchronization Guide

## Why do we need to sync?
KoalaSync uses a "Single Source of Truth" for its communication protocol constants located in the root `shared/` directory. However, Browser Extensions (Manifest V3) are strictly sandboxed and **cannot load or import files from outside their root directory**.

To ensure that the extension and the relay server are always using the exact same event names and protocol versions, we maintain a mirrored copy of the shared files within the `extension/shared/` folder.

## When should you run the build script?
You MUST run the build script in any of the following scenarios:
1. **After a fresh `git clone` or `git pull`** (as the synced files are ignored by git).
2. **After modifying** `shared/constants.js`.
3. **After modifying** `shared/blacklist.js`.
4. **After modifying** `shared/names.js`.
5. **Before committing** changes to the repository if any shared protocol or extension-mirrored files were touched.
6. **Before deploying** the server or releasing the extension.

## How to sync

Run the Node.js build script from the repository root:
```bash
node scripts/build-extension.cjs
# or simply:
npm run build:extension
```

## What does it do?
The build script performs the following actions:
1. Synchronizes shared files by copying `shared/constants.js`, `shared/blacklist.js`, `shared/names.js`, and `shared/README.md` into `extension/shared/`.
2. Injects `EVENTS`, `HEARTBEAT_INTERVAL`, and `episode-utils.js` functions (`extractEpisodeId`, `sameEpisode`) into `content.js` via marker-based replacement.
3. Injects browser-specific uninstall URL constants into `background.js` and a build timestamp into `popup.html`.
4. Compiles browser-specific manifest files.
5. Packages the final ready-to-publish extension artifacts for Chrome and Firefox into the `dist/` directory.

## Protocol Versioning
The system enforces a strict `protocolVersion` check during the `JOIN_ROOM` handshake. 
- The version is defined in `shared/constants.js`.
- If the extension and server versions mismatch, the server will reject the connection with an `Incompatible protocol version` error.
- **Never manually bump version numbers**. The CI pipeline automatically injects the version from the git tag into `manifest.base.json`, `shared/constants.js`, and `package.json` during release builds. Run the build script to synchronize other constant updates.

> [!CAUTION]
> **NEVER** edit the files inside `extension/shared/` directly. They will be overwritten the next time the build script is run. Always edit the files in the root `shared/` directory and then run the build script.
