(function() {
    var html = document.documentElement;
    var path = window.location.pathname;

    var safeGetLocalStorage = function(key) {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    };

    var getSystemTheme = function() {
        try {
            return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        } catch (_) {
            return 'dark';
        }
    };

    // Apply the effective theme before first paint. A saved preference wins;
    // otherwise first-time visitors follow their browser/system setting.
    var savedTheme = safeGetLocalStorage('koala_theme');
    var effectiveTheme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : getSystemTheme();
    if (effectiveTheme === 'light') {
        html.classList.add('theme-light');
    } else {
        html.classList.remove('theme-light');
    }

    // Mapping of browser language codes to KoalaSync locale directories
    var langMap = {
        'de': 'de',
        'fr': 'fr',
        'es': 'es',
        'pt-br': 'pt-BR',
        'pt': 'pt',
        'ru': 'ru',
        'it': 'it',
        'pl': 'pl',
        'tr': 'tr',
        'nl': 'nl',
        'ja': 'ja',
        'ko': 'ko',
        'zh': 'zh',
        'uk': 'uk'
    };

    var getBrowserLang = function() {
        var fullLang = (navigator.language || '').toLowerCase();
        if (fullLang.indexOf('zh') === 0) return 'zh';
        if (fullLang.indexOf('uk') === 0) return 'uk';
        if (fullLang.indexOf('pt-br') === 0) return 'pt-br';
        if (fullLang.indexOf('pt') === 0) return 'pt';
        return fullLang.split('-')[0];
    };

    // Check if we are on the root index page (either "/" or "/index.html" at the root)
    var isRootIndex = path === '/' || path === '/index.html' || path === '';

    if (isRootIndex) {
        var savedLang = safeGetLocalStorage('koala_lang');
        var browserLang = getBrowserLang();
        var preferredLang = savedLang || langMap[browserLang] || 'en';

        if (preferredLang !== 'en') {
            window.location.replace(preferredLang + '/');
            return;
        }
    }

    var htmlClasses = html.className.split(' ');
    var activeLang = null;
    var hasStaticLang = false;
    for (var i = 0; i < htmlClasses.length; i++) {
        if (htmlClasses[i].indexOf('lang-') === 0) {
            hasStaticLang = true;
            var langPart = htmlClasses[i].substring(5);
            activeLang = langPart === 'pt-br' ? 'pt-BR' : langPart;
            break;
        }
    }

    if (hasStaticLang) {
        // Do not persist a static page language merely because the visitor landed
        // there. The explicit dropdown handler in app.js owns language preference.
    } else {
        var savedLang = safeGetLocalStorage('koala_lang');
        var browserLang = getBrowserLang();
        activeLang = savedLang || langMap[browserLang] || 'en';

        // Dynamic utility pages currently only support English and German markup.
        // Fallback to English for any other language to avoid bilingual text duplication.
        if (activeLang !== 'de') {
            activeLang = 'en';
        }

        html.classList.add('lang-' + activeLang);
        html.lang = activeLang;
    }

    // Update titles dynamically based on page
    var isIndex = path === '/' || path.endsWith('index.html') || path.split('/').pop() === '';
    var isJoin = path.includes('join');

    if (isIndex) {
        var titles = {
            en: 'KoalaSync | Watch Party for Netflix, YouTube & Any Video',
            de: 'KoalaSync | Watch Party für Netflix, YouTube & jedes Video'
        };
        document.title = titles[activeLang] || titles.en;
    } else if (isJoin) {
        var titles = {
            en: 'Join Room | KoalaSync',
            de: 'Raum beitreten | KoalaSync'
        };
        document.title = titles[activeLang] || titles.en;
    }
})();
