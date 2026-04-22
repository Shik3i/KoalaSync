# KoalaSync Protocol Synchronization Guide (SYNC_GUIDE.md)

## Why do we need to sync?
KoalaSync uses a "Single Source of Truth" for its communication protocol constants located in the `shared/` directory. However, Chrome Extensions (Manifest V3) are strictly sandboxed and **cannot load or import files from outside their root directory**.

To ensure that the extension and the relay server are always using the exact same event names and protocol versions, we must maintain a mirrored copy of the shared files within the extension folder.

## When should you run the sync script?
You MUST run the synchronization script in any of the following scenarios:
1. **After modifying** `shared/constants.js`.
2. **After modifying** `shared/blacklist.js`.
3. **Before committing** changes to the repository if any protocol-related files were touched.
4. **Before deploying** the server or releasing the extension.

## How to sync

### On Windows
Run the batch script from the repository root:
```powershell
.\scripts\sync-constants.bat
```

### On macOS / Linux
Run the shell script from the repository root:
```bash
./scripts/sync-constants.sh
```

## What does it do?
The script performs the following actions:
1. Ensures the `extension/shared/` directory exists.
2. Copies `shared/constants.js` to `extension/shared/constants.js`.
3. Copies `shared/blacklist.js` to `extension/shared/blacklist.js`.

> [!CAUTION]
> **NEVER** edit the files inside `extension/shared/` directly. They will be overwritten the next time the sync script is run. Always edit the files in the root `shared/` directory and then run the sync script.
