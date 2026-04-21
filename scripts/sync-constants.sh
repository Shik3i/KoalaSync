#!/bin/sh
# KoalaSync - Protocol Synchronization Script (Linux/macOS)
#
# This script copies the master constants.js file from the shared directory
# to the extension directory. Since Chrome Extensions cannot load files
# outside their root, this manual sync is required after any changes to
# the shared protocol.

mkdir -p extension/shared
cp shared/constants.js extension/shared/constants.js
cp shared/blacklist.js extension/shared/blacklist.js
echo "✓ constants.js and blacklist.js synced to extension/shared/"
