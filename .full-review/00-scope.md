# Review Scope

## Target

KoalaSync (v2.5.0) - A full-stack podcast synchronization application consisting of:

- **extension/** - Chrome/Firefox browser extension for podcast sync (Manifest V3)
- **server/** - Node.js backend API server with Docker support
- **shared/** - Shared utilities (blacklist, constants, names)
- **website/** - Public website/frontend (static HTML + JS + CSS)

Tech stack: Node.js, Chrome Extension API, Docker, ESM modules (Node.js project), ESLint for linting, esbuild for bundling.

## Files

The entire workspace will be reviewed across all four main modules:
- `extension/` - Browser extension codebase (~18+ files)
- `server/` - Backend API server (~8 files)
- `shared/` - Shared utilities (~4 files)
- `website/` - Public website (~20 files)
- Root build/lint scripts and configuration

## Flags

- Security Focus: no
- Performance Critical: no
- Strict Mode: no
- Framework: Node.js / Chrome Extension

## Review Phases

1. Code Quality & Architecture
2. Security & Performance
3. Testing & Documentation
4. Best Practices & Standards
5. Consolidated Report
