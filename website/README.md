# KoalaSync Website & Invitation Bridge

This directory contains the static KoalaSync website. It is both the public marketing/onboarding site and the browser-side invitation bridge for joining sync rooms.

## Where You Are

- `template.html`, `style.css`, `app.js`, `lang-init.js`, and `locales/*.json` are source files.
- `build.cjs` compiles the static site into `website/www/`.
- `website/www/` is generated output. Do not edit files there directly.
- `join.html` handles room-invite links and communicates with the extension through `bridge.js`.
- `llms.txt` gives crawlers and AI tools a compact project overview.
- `alternatives/` contains comparison pages for users evaluating KoalaSync against other watch-party approaches.

## Core Roles

### 1. Marketing & Onboarding

The site explains KoalaSync, links to browser stores, documents self-hosting, and provides localized user-facing copy in 15 languages:

`en`, `de`, `fr`, `es`, `it`, `nl`, `pl`, `pt`, `pt-BR`, `tr`, `ru`, `ja`, `ko`, `zh`, and `uk`.

### 2. Invitation Bridge (`join.html`)

When a user opens an invitation such as `https://sync.koalastuff.net/join.html#join:roomID:pass`, the page:

- detects whether the KoalaSync extension is installed via the extension's `bridge.js` content script,
- keeps room credentials inside the URL hash so they are not sent to the web server,
- asks the extension to join the target room automatically when possible.

## Architecture

The website is 100% static HTML, CSS, and JavaScript.

- **Static i18n compiler**: `build.cjs` combines `template.html` with dictionaries in `locales/`.
- **Build-time minification**: Source CSS/JS stays readable; generated output uses `.min.css` and `.min.js`.
- **Zero backend**: The compiled site can be hosted by any static file server.
- **Zero external assets**: Fonts, icons, scripts, and images must remain self-hosted.
- **Generated SEO/runtime files**: `version.json`, sitemap, robots, clean URLs, localized pages, and minified assets are copied or generated into `www/`.

## Local Development & Compilation

From the repository root:
```bash
node website/build.cjs
npx serve -l 5000 website/www
```

Then open:

- `http://localhost:5000/` for the default page.
- `http://localhost:5000/de/` for a localized page.
- `http://localhost:5000/join.html#join:test-room:test-pass` to test the invitation bridge path.

Focused verification:
```bash
node scripts/test-website-locales.mjs
node --check website/www/app.min.js
node --check website/www/lang-init.min.js
```

Full verification:
```bash
npm run verify
```

## Hosting with Caddy

Caddy is the recommended production server because it handles HTTPS and static file serving cleanly. For a complete website plus relay reverse-proxy setup, use the root [Caddyfile.example](../examples/Caddyfile.example).

Minimal static-site block:
```caddy
sync.koalastuff.net {
    root * /var/www/koalasync/website/www
    try_files {path} {path}.html {path}/
    file_server
    encode zstd gzip

    @static {
        file
        path *.ico *.css *.js *.png *.svg *.webp *.avif
    }
    header @static Cache-Control "public, max-age=31536000, must-revalidate"

    header {
        Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none';"
        Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options nosniff
        X-Frame-Options SAMEORIGIN
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

## Do Not Break

- Do not edit `website/www/` manually; rebuild it from sources.
- Do not add external CDNs, fonts, analytics, or third-party scripts.
- Keep invite credentials in the URL hash, not query parameters.
- Keep locale files synchronized with `website/build.cjs` and `scripts/test-website-locales.mjs`.
- Commit source changes and regenerated `www/` output together when website output changes.
