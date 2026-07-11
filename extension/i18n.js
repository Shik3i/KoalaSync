// extension/i18n.js
export const SUPPORTED_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'pt-BR', 'tr', 'ru', 'ja', 'ko', 'zh', 'uk'];
export const DEFAULT_LANGUAGE = 'en';

let activeDictionary = {};
const dictionaryCache = {};
let currentLanguage = null;

/**
 * Resolves, loads, and merges the target language with the English baseline fallback.
 * @param {string} langCode - Target language (e.g. 'de')
 */
export async function loadLocale(langCode) {
    const resolvedLang = SUPPORTED_LANGUAGES.includes(langCode) ? langCode : DEFAULT_LANGUAGE;
    
    if (currentLanguage === resolvedLang && Object.keys(activeDictionary).length > 0) {
        return;
    }

    if (dictionaryCache[resolvedLang]) {
        activeDictionary = dictionaryCache[resolvedLang];
        currentLanguage = resolvedLang;
        return;
    }
    
    try {
        // Load Baseline English
        let enDict;
        if (dictionaryCache[DEFAULT_LANGUAGE]) {
            enDict = dictionaryCache[DEFAULT_LANGUAGE];
        } else {
            const enResponse = await fetch(chrome.runtime.getURL(`locales/${DEFAULT_LANGUAGE}.json`));
            enDict = await enResponse.json();
            dictionaryCache[DEFAULT_LANGUAGE] = enDict;
        }
        
        if (resolvedLang === DEFAULT_LANGUAGE) {
            activeDictionary = enDict;
            currentLanguage = resolvedLang;
            return;
        }
        
        // Load Target Locale
        const targetResponse = await fetch(chrome.runtime.getURL(`locales/${resolvedLang}.json`));
        const targetDict = await targetResponse.json();
        
        // Airtight Fallback Merge: target overrides en, missing elements fallback to en
        const mergedDict = Object.assign({}, enDict, targetDict);
        dictionaryCache[resolvedLang] = mergedDict;
        activeDictionary = mergedDict;
        currentLanguage = resolvedLang;
    } catch (err) {
        console.error('[i18n] Failed to load locale. Defaulting to English:', err);
        // Fallback directly to static English if fetching fails
        try {
            let enDict;
            if (dictionaryCache[DEFAULT_LANGUAGE]) {
                enDict = dictionaryCache[DEFAULT_LANGUAGE];
            } else {
                const enResponse = await fetch(chrome.runtime.getURL(`locales/${DEFAULT_LANGUAGE}.json`));
                enDict = await enResponse.json();
                dictionaryCache[DEFAULT_LANGUAGE] = enDict;
            }
            activeDictionary = enDict;
            currentLanguage = DEFAULT_LANGUAGE;
        } catch (_) {
            activeDictionary = {};
            currentLanguage = null;
        }
    }
}

/**
 * Returns the translated string for a given key. Supports optional value interpolation.
 * @param {string} key - Dictionary key
 * @param {object} [placeholders] - Key-value map for replacements (e.g., { name: 'Alice' })
 * @returns {string} Translated string or the key itself
 */
export function getMessage(key, placeholders = null) {
    let msg = activeDictionary[key] !== undefined ? String(activeDictionary[key]) : key;
    if (placeholders && typeof placeholders === 'object') {
        for (const [k, v] of Object.entries(placeholders)) {
            msg = msg.replace(new RegExp(`{${k}}`, 'g'), v);
        }
    }
    return msg;
}

/**
 * Performs dynamic DOM replacements for elements carrying data-i18n attributes.
 */
export function translateDOM() {
    // 1. Text Content
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translated = getMessage(key);
        
        // Special case: Preserve logo image elements inside headers (like h1 logo)
        const img = el.querySelector('img');
        if (img) {
            el.innerHTML = '';
            el.appendChild(img);
            el.appendChild(document.createTextNode(' ' + translated));
        } else {
            el.textContent = translated;
        }
    });

    // 2. Tooltips (titles)
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        el.setAttribute('title', getMessage(key));
    });

    // 3. Placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.setAttribute('placeholder', getMessage(key));
    });

    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria-label');
        el.setAttribute('aria-label', getMessage(key));
    });
}

/**
 * Detects and maps the user's system language to the best supported locale.
 * @returns {string} Supported language code
 */
export function getSystemLanguage() {
    const uiLang = (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) 
        ? chrome.i18n.getUILanguage() 
        : '';
    const fullLang = (navigator.language || uiLang || '').toLowerCase();
    if (fullLang.startsWith('pt-br')) {
        return 'pt-BR';
    }
    const baseLang = fullLang.split('-')[0];
    return SUPPORTED_LANGUAGES.includes(baseLang) ? baseLang : DEFAULT_LANGUAGE;
}
