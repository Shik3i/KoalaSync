@echo off
REM KoalaSync - Protocol Synchronization Script (Windows)
REM
REM This script copies the master constants.js file from the shared directory
REM to the extension directory. Since Chrome Extensions cannot load files
REM outside their root, this manual sync is required after any changes to
REM the shared protocol.

if not exist extension\shared mkdir extension\shared
copy /y shared\constants.js extension\shared\constants.js
copy /y shared\blacklist.js extension\shared\blacklist.js
echo ✓ constants.js and blacklist.js synced to extension\shared\
