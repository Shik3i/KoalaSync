# KoalaSync Landing Page

This directory contains the static marketing website for KoalaSync. It is built using vanilla HTML, CSS, and JavaScript to ensure maximum performance, zero tracking, and easy hosting.

## Features
- **Privacy First**: No external fonts, scripts, or trackers.
- **Modern Tech Aesthetic**: Pure CSS animated gradients and glassmorphism.
- **Smart Join**: Integrated bridge for communication with the KoalaSync browser extension.

## Hosting with Caddy

Caddy is the recommended web server for KoalaSync due to its automatic HTTPS and simple configuration.

### Example Caddyfile

To host the website on `koalasync.shik3i.net`, you can use the following configuration:

```caddy
koalasync.shik3i.net {
    # Path to the website directory
    root * /var/www/koalasync/website
    
    # Enable static file serving
    file_server
    
    # Enable Gzip/Zstd compression
    encode zstd gzip
    
    # Security Headers
    header {
        # Prevent FLoC tracking
        Permissions-Policy interest-cohort=()
        # Security best practices
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy no-referrer-when-downgrade
    }
    
    # Custom 404 page
    handle_errors {
        rewrite * /{err.status_code}.html
        file_server
    }
}
```

### Deployment Steps
1. Copy the contents of this folder to `/var/www/koalasync/website` on your server.
2. Update the path in your `Caddyfile`.
3. Reload Caddy: `caddy reload`.
