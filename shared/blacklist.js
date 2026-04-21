/**
 * blacklist.js
 * 
 * Domains to be filtered out from the tab selection dropdown to reduce "noise".
 * These are typically sites that won't contain shareable video content.
 */
export const BLACKLIST_DOMAINS = [
    // Mail Providers
    'mail.google.com',
    'outlook.live.com',
    'outlook.office.com',
    'gmx.net',
    'web.de',

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

    // Social Media
    'linkedin.com',
    'twitter.com',
    'x.com',
    'facebook.com',
    'instagram.com',

    // Development & Utilities
    'timer.shik3i.net',
    'localhost',
    'zoom.us',
    'teams.microsoft.com',
    'meet.google.com'
];
