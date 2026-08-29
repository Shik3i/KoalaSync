(function(root) {
    const PAGE_API_SEEK_FIXES = [
        {
            name: 'netflix-page-api-seek',
            urls: ['netflix.com'],
            provider: 'netflix',
            actions: ['play', 'pause', 'seek']
        },
        {
            name: 'disney-page-api-seek',
            urls: ['disneyplus.com'],
            provider: 'disney',
            actions: ['seek']
        }
    ];

    function normalizeHost(input) {
        try {
            return new URL(input).hostname.toLowerCase();
        } catch (_e) {
            return String(input || '').toLowerCase();
        }
    }

    function matchesDomain(host, domain) {
        const normalizedDomain = normalizeHost(domain);
        return normalizedDomain && (host === normalizedDomain || host.endsWith(`.${normalizedDomain}`));
    }

    root.KOALA_PAGE_API_SEEK_FIXES = PAGE_API_SEEK_FIXES;
    root.KOALA_PAGE_API_SEEK_PROVIDERS = PAGE_API_SEEK_FIXES;
    root.koalaFindPageApiSeekProvider = (input) => {
        const host = normalizeHost(input);
        return PAGE_API_SEEK_FIXES.find(entry =>
            Array.isArray(entry.urls) && entry.urls.some(url => matchesDomain(host, url))
        ) || null;
    };
})(globalThis);
