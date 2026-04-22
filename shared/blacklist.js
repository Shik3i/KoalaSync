/**
 * blacklist.js
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

    // Mail Providers
    'mail.google.com',
    'outlook.live.com',
    'outlook.office.com',
    'gmx.net',
    'web.de',

    // Cloud Storage & Documents
    'docs.google.com',
    'sheets.google.com',
    'slides.google.com',
    'drive.google.com',
    'dropbox.com',
    'onedrive.live.com',
    'icloud.com',

    // Messengers
    'web.whatsapp.com',
    'web.telegram.org',
    'discord.com',
    'element.io',
    'app.slack.com',

    // Productivity & Project Management
    'atlassian.net',
    'jira',
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

    // E-Commerce
    'amazon.',
    'ebay.com',
    'aliexpress.com',
    'etsy.com',

    // Development & Utilities
    'timer.shik3i.net',
    'localhost',
    'zoom.us',
    'teams.microsoft.com',
    'meet.google.com',
    'chrome.google.com'
];
