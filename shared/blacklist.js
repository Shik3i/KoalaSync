/**
 * blacklist.js
 * 
 * ⚠️ WARNING: This is the SINGLE SOURCE OF TRUTH.
 * If you edit this file, you MUST run: node scripts/build-extension.cjs
 * to propagate changes to the extension and relay server.
 * 
 * Domains to be filtered out from the tab selection dropdown to reduce "noise".
 * These are typically sites that won't contain shareable video content.
 */
export const BLACKLIST_DOMAINS = [
    // Search Engines & Portals
    'google.com',
    'bing.com',
    'duckduckgo.com',
    'yahoo.com',
    'msn.com',
    'baidu.com',
    'yandex.ru',
    'ecosia.org',
    'startpage.com',
    'search.brave.com',
    'qwant.com',
    'you.com',
    'perplexity.ai',
    'ask.com',
    'search.yahoo.com',
    'swisscows.ch',
    'mojeek.com',

    // Mail Providers
    'mail.google.com',
    'gmail.com',
    'outlook.live.com',
    'outlook.office.com',
    'mail.yahoo.com',
    'gmx.net',
    'gmx.de',
    'gmx.com',
    'web.de',
    'protonmail.com',
    'proton.me',
    't-online.de',
    'posteo.de',
    'mailbox.org',
    'mail.de',
    'zoho.com',
    'fastmail.com',
    'tutanota.com',
    'mail.ru',

    // Cloud Storage & Documents
    'docs.google.com',
    'sheets.google.com',
    'slides.google.com',

    // Messengers
    'web.whatsapp.com',
    'web.telegram.org',
    'discord.com',
    'element.io',
    'app.slack.com',

    // Productivity & Project Management
    'atlassian.net',
    'trello.com',
    'notion.so',
    'monday.com',
    'asana.com',
    'github.com',
    'gitlab.com',
    'bitbucket.org',
    'stackoverflow.com',

    // Social Media & Forums
    'linkedin.com',
    'twitter.com',
    'x.com',
    'facebook.com',
    'instagram.com',
    'reddit.com',
    'quora.com',
    'threads.net',
    'bsky.app',
    'mastodon.social',
    'vk.com',
    'weibo.com',
    '9gag.com',
    'imgur.com',

    // E-Commerce
    'ebay.com',
    'aliexpress.com',
    'etsy.com',

    // Media Information & Reviews
    'rottentomatoes.com',
    'imdb.com',
    'thetvdb.com',
    'themoviedb.org',
    'letterboxd.com',
    'metacritic.com',
    'myanimelist.net',

    // Development & Utilities
    'koalastuff.net',
    'auth.koalastuff.net',
    'blog.koalastuff.net',
    'clicker.koalastuff.net',
    'cookies.koalastuff.net',
    'multibox.koalastuff.net',
    'snippets.koalastuff.net',
    'status.koalastuff.net',
    'sync.koalastuff.net',
    'timer.koalastuff.net',
    'zoom.us',
    'teams.microsoft.com',
    'meet.google.com',
    'chrome.google.com',

    // Music Streaming
    'music.youtube.com',
    'open.spotify.com',
    'soundcloud.com',
    'deezer.com',
    'tidal.com',

    // Knowledge & Blogs
    'wikipedia.org',
    'medium.com',
    'dev.to',
    'news.ycombinator.com',

    // Design & Creative Tools
    'figma.com',
    'canva.com',
    'miro.com',

    // Online IDEs & Hosting
    'vscode.dev',
    'replit.com',
    'codesandbox.io',
    'vercel.com',
    'netlify.com',

    // Social & Image Sharing
    'pinterest.com',
    'tumblr.com',

    // Language Learning
    'duolingo.com',
    'hellotalk.com',

    // Google Utilities
    'calendar.google.com',
    'keep.google.com',

    // Finance & Payments
    'paypal.com',
    'stripe.com',

    // Games & Idle Sites
    'milkywayidle.com',
    'melvoridle.com',
    'orteil.dashnet.org',
    'clickerheroes.com',
    'kongregate.com',
    'armorgames.com',
    'crazygames.com',
    'poki.com',
    'newgrounds.com',
    'krunker.io',
    'slither.io',
    'agar.io',
    'diep.io',
    'geoguessr.com',
    'chess.com',
    'lichess.org',
    'skribbl.io'
];
