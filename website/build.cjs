/**
 * KoalaSync Static Site Generator (i18n compiler)
 * Build pipeline: esbuild + AVIF + hashing + SVG min.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const esbuild = require('esbuild');
const { optimize: svgoOptimize } = require('svgo');

// CSS minifier: simple regex-based (proven, 27% reduction, no deps)
function minifyCSS(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s*([{}:;,])\s*/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/;\}/g, '}')
        .trim();
}
const MIN_AVIF_KB = 0;

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        entry.isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
    }
}

function sha8(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8); }
function sha384(buf) { return 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64'); }

async function minifyJS(raw) {
    const result = await esbuild.transform(raw, {
        loader: 'js',
        minify: true,
        target: 'es2020'
    });
    return result.code;
}

function injectAvifPictures(html) {
    return html.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
        const srcMatch = attrs.match(/\bsrc="([^"]*)"/i);
        if (!srcMatch) return match;
        if (!/\.webp"$/i.test(srcMatch[0])) return match;
        const src = srcMatch[1];
        const avifSrc = src.replace(/\.webp$/i, '.avif');
        const srcsetMatch = attrs.match(/\bsrcset="([^"]*)"/i);
        if (srcsetMatch) {
            const avifSrcset = srcsetMatch[1].replace(/\.webp/gi, '.avif');
            return `<picture><source srcset="${avifSrcset}" type="image/avif"><img${attrs}></picture>`;
        }
        return `<picture><source srcset="${avifSrc}" type="image/avif"><img${attrs}></picture>`;
    });
}

function minifyInlineSvgs(html) {
    const svgRegex = /<svg\b[\s\S]*?<\/svg>/gi;
    return html.replace(svgRegex, (svg) => {
        try {
            const result = svgoOptimize(svg, { multipass: true, plugins: ['preset-default'] });
            return result.data;
        } catch { return svg; }
    });
}

async function compile() {
    console.log('Starting KoalaSync i18n compilation...');
    const websiteDir = __dirname;
    const wwwDir = path.join(websiteDir, 'www');
    fs.mkdirSync(wwwDir, { recursive: true });

    // ── 0. Auto-generate website logo sizes and sync favicons ──
    console.log('Generating responsive website logos...');
    const rawLogoSrc = path.join(websiteDir, '..', 'assets', 'icon', 'TwoPointZero_Logo_Icon_600.webp');
    const targetAssetsDir = path.join(websiteDir, 'assets');
    
    if (fs.existsSync(rawLogoSrc)) {
        fs.mkdirSync(targetAssetsDir, { recursive: true });
        
        // Generate NewLogoIcon_64.webp (64x64)
        await sharp(rawLogoSrc)
            .resize(64, 64)
            .toFile(path.join(targetAssetsDir, 'NewLogoIcon_64.webp'));
            
        // Generate NewLogoIcon_128.webp (128x128)
        await sharp(rawLogoSrc)
            .resize(128, 128)
            .toFile(path.join(targetAssetsDir, 'NewLogoIcon_128.webp'));
            
        // Generate NewLogoIcon.webp (256x256)
        await sharp(rawLogoSrc)
            .resize(256, 256)
            .toFile(path.join(targetAssetsDir, 'NewLogoIcon.webp'));
            
        console.log('  ✓ WebP logo variants successfully generated in website/assets/');
    } else {
        console.warn(`  ⚠️ Warning: Source logo ${rawLogoSrc} not found. Skipping auto-generation.`);
    }

    const pngMappings = [
        { src: 'TwoPointZero_Logo_Icon_16.png', dest: 'favicon-16x16.png' },
        { src: 'TwoPointZero_Logo_Icon_32.png', dest: 'favicon-32x32.png' },
        { src: 'TwoPointZero_Logo_Icon_256.png', dest: 'apple-touch-icon.png' },
        { src: 'TwoPointZero_Logo_Icon_256.png', dest: 'icon-192x192.png' }
    ];
    for (const mapping of pngMappings) {
        const srcPath = path.join(websiteDir, '..', 'assets', 'icon', mapping.src);
        const destPath = path.join(targetAssetsDir, mapping.dest);
        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
        } else {
            console.warn(`  ⚠️ Warning: Source PNG ${srcPath} not found.`);
        }
    }
    console.log('  ✓ Favicons/touch icons successfully synced to website/assets/');

    // Social link preview image (og:image / twitter:image), same artwork as the
    // GitHub repository OpenGraph card. PNG kept for maximum scraper support.
    const ogSrc = path.join(websiteDir, '..', 'assets', 'StoreAssets', 'RepositoryOpenGraph.png');
    if (fs.existsSync(ogSrc)) {
        await sharp(ogSrc)
            .png({ quality: 80, palette: true })
            .toFile(path.join(targetAssetsDir, 'og-image.png'));
        console.log('  ✓ og-image.png generated from RepositoryOpenGraph.png');
    } else {
        console.warn(`  ⚠️ Warning: ${ogSrc} not found. Skipping og-image generation.`);
    }

    // ── 1. Minify CSS/JS (must happen first so hashes go into HTML) ──
    console.log('Minifying CSS/JS...');
    const styleRaw = fs.readFileSync(path.join(websiteDir, 'style.css'), 'utf8');
    const styleMin = minifyCSS(styleRaw);
    const styleHash = sha8(styleMin);
    const styleName = `style.${styleHash}.min.css`;
    const styleSRI = sha384(styleMin);

    const appRaw = fs.readFileSync(path.join(websiteDir, 'app.js'), 'utf8');
    const appMin = await minifyJS(appRaw);
    const appHash = sha8(appMin);
    const appName = `app.${appHash}.min.js`;
    const appSRI = sha384(appMin);

    const langRaw = fs.readFileSync(path.join(websiteDir, 'lang-init.js'), 'utf8');
    const langMin = await minifyJS(langRaw);
    const langHash = sha8(langMin);
    const langName = `lang-init.${langHash}.min.js`;
    const langSRI = sha384(langMin);

    const stylePct = ((1 - styleMin.length / styleRaw.length) * 100).toFixed(0);
    const appPct   = ((1 - appMin.length / appRaw.length) * 100).toFixed(0);
    const langPct  = ((1 - langMin.length / langRaw.length) * 100).toFixed(0);
    console.log(`  CSS: ${styleName} (${(styleMin.length/1024).toFixed(1)} KB, -${stylePct}%)`);
    console.log(`  App: ${appName} (${(appMin.length/1024).toFixed(1)} KB, -${appPct}%)`);
    console.log(`  Lang: ${langName} (${(langMin.length/1024).toFixed(1)} KB, -${langPct}%)`);

    // ── 2. Clean stale minified output ──
    for (const f of fs.readdirSync(wwwDir)) {
        if (/\.min\.(css|js)$/.test(f) || /\.(css|js)$/.test(f)) {
            const p = path.join(wwwDir, f);
            if (fs.statSync(p).isFile()) fs.unlinkSync(p);
        }
    }

    // Write minified files
    fs.writeFileSync(path.join(wwwDir, styleName), styleMin);
    fs.writeFileSync(path.join(wwwDir, appName), appMin);
    fs.writeFileSync(path.join(wwwDir, langName), langMin);

    // ── 3. Compile HTML templates ──
    const templatePath = path.join(websiteDir, 'template.html');
    if (!fs.existsSync(templatePath)) {
        console.error('Error: template.html not found!');
        process.exit(1);
    }
    const templateContent = fs.readFileSync(templatePath, 'utf8');
    const localesDir = path.join(websiteDir, 'locales');
    const languages = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'pt-BR', 'tr', 'ru', 'ja', 'ko', 'zh', 'uk'];

    // Read version for build-time injection (SEO: crawlers see real version)
    const versionJson = JSON.parse(fs.readFileSync(path.join(websiteDir, 'version.json'), 'utf8'));
    const buildVersion = versionJson.version || '?';

    const englishHtml = {}; // track for join-page cross-ref

    function compilePage(locale, assetPath, lang) {
        let compiled = templateContent;
        compiled = compiled.replace(/\{\{ASSET_PATH\}\}/g, assetPath);
        compiled = compiled.replace(/\{\{VERSION\}\}/g, buildVersion);
        compiled = compiled.replace(/\{\{VERSION_DATE\}\}/g, versionJson.date || '');
        const langPrefix = lang === 'en' ? '' : `${lang}/`;
        compiled = compiled.replace(/\{\{LANG_PREFIX\}\}/g, langPrefix);
        languages.forEach(l => {
            compiled = compiled.replace(new RegExp(`\\{\\{SELECTED_${l.toUpperCase()}\\}\\}`, 'g'), l === lang ? 'selected' : '');
        });
        for (const [key, value] of Object.entries(locale)) {
            compiled = compiled.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
        }
        return compiled;
    }

    // Read alternative page templates
    const telepartyTemplatePath = path.join(websiteDir, 'alternatives/teleparty.html');
    const screenSharingTemplatePath = path.join(websiteDir, 'alternatives/screen-sharing.html');
    const watch2getherTemplatePath = path.join(websiteDir, 'alternatives/watch2gether.html');
    const scenerTemplatePath = path.join(websiteDir, 'alternatives/scener.html');
    const kosmiTemplatePath = path.join(websiteDir, 'alternatives/kosmi.html');
    const twosevenTemplatePath = path.join(websiteDir, 'alternatives/twoseven.html');
    const overviewTemplatePath = path.join(websiteDir, 'alternatives/index.html');
    const hasTelepartyTemplate = fs.existsSync(telepartyTemplatePath);
    const hasScreenSharingTemplate = fs.existsSync(screenSharingTemplatePath);
    const hasWatch2getherTemplate = fs.existsSync(watch2getherTemplatePath);
    const hasScenerTemplate = fs.existsSync(scenerTemplatePath);
    const hasKosmiTemplate = fs.existsSync(kosmiTemplatePath);
    const hasTwosevenTemplate = fs.existsSync(twosevenTemplatePath);
    const hasOverviewTemplate = fs.existsSync(overviewTemplatePath);
    const telepartyTemplate = hasTelepartyTemplate ? fs.readFileSync(telepartyTemplatePath, 'utf8') : '';
    const screenSharingTemplate = hasScreenSharingTemplate ? fs.readFileSync(screenSharingTemplatePath, 'utf8') : '';
    const watch2getherTemplate = hasWatch2getherTemplate ? fs.readFileSync(watch2getherTemplatePath, 'utf8') : '';
    const scenerTemplate = hasScenerTemplate ? fs.readFileSync(scenerTemplatePath, 'utf8') : '';
    const kosmiTemplate = hasKosmiTemplate ? fs.readFileSync(kosmiTemplatePath, 'utf8') : '';
    const twosevenTemplate = hasTwosevenTemplate ? fs.readFileSync(twosevenTemplatePath, 'utf8') : '';
    const overviewTemplate = hasOverviewTemplate ? fs.readFileSync(overviewTemplatePath, 'utf8') : '';

    // Preload English locale for fallback
    const englishLocalePath = path.join(localesDir, 'en.json');
    const englishLocale = JSON.parse(fs.readFileSync(englishLocalePath, 'utf8'));

    function compileAlternativePage(templateContent, locale, lang, assetPath, langPrefix) {
        let compiled = templateContent;
        compiled = compiled.replace(/\{\{LANG_CODE\}\}/g, lang);
        compiled = compiled.replace(/\{\{ASSET_PATH\}\}/g, assetPath);
        compiled = compiled.replace(/\{\{LANG_PREFIX\}\}/g, langPrefix);
        compiled = compiled.replace(/\{\{VERSION\}\}/g, buildVersion);

        // og:locale mapping for Facebook
        const ogLocales = {
            en: 'en_US', de: 'de_DE', fr: 'fr_FR', es: 'es_ES',
            'pt-BR': 'pt_BR', ru: 'ru_RU', it: 'it_IT', pl: 'pl_PL',
            tr: 'tr_TR', nl: 'nl_NL', ja: 'ja_JP', ko: 'ko_KR',
            zh: 'zh_CN', uk: 'uk_UA', pt: 'pt_PT'
        };
        compiled = compiled.replace(/\{\{OG_LOCALE\}\}/g, ogLocales[lang] || 'en_US');

        // Merge locale with English fallback for keys not present in current locale
        const mergedLocale = { ...englishLocale, ...locale };
        for (const [key, value] of Object.entries(mergedLocale)) {
            compiled = compiled.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
        }
        return compiled;
    }

    for (const lang of languages) {
        const localePath = path.join(localesDir, `${lang}.json`);
        if (!fs.existsSync(localePath)) { console.warn(`Warning: Locale ${lang} not found.`); continue; }
        const locale = JSON.parse(fs.readFileSync(localePath, 'utf8'));

        if (lang === 'en') {
            console.log('Compiling English (index.html)...');
            const html = compilePage(locale, '', lang);
            fs.writeFileSync(path.join(wwwDir, 'index.html'), html);
            englishHtml[''] = html;

            // Compile alternatives for English (assets resolved using '../' prefix)
            if (hasTelepartyTemplate) {
                const altDir = path.join(wwwDir, 'alternatives');
                fs.mkdirSync(altDir, { recursive: true });
                const tpCompiled = compileAlternativePage(telepartyTemplate, locale, lang, '../', '');
                fs.writeFileSync(path.join(altDir, 'teleparty.html'), tpCompiled);
            }
            if (hasScreenSharingTemplate) {
                const altDir = path.join(wwwDir, 'alternatives');
                fs.mkdirSync(altDir, { recursive: true });
                const ssCompiled = compileAlternativePage(screenSharingTemplate, locale, lang, '../', '');
                fs.writeFileSync(path.join(altDir, 'screen-sharing.html'), ssCompiled);
            }
            if (hasWatch2getherTemplate) {
                const altDir = path.join(wwwDir, 'alternatives');
                fs.mkdirSync(altDir, { recursive: true });
                const w2gCompiled = compileAlternativePage(watch2getherTemplate, locale, lang, '../', '');
                fs.writeFileSync(path.join(altDir, 'watch2gether.html'), w2gCompiled);
            }
            if (hasScenerTemplate) {
                const altDir = path.join(wwwDir, 'alternatives');
                fs.mkdirSync(altDir, { recursive: true });
                const scCompiled = compileAlternativePage(scenerTemplate, locale, lang, '../', '');
                fs.writeFileSync(path.join(altDir, 'scener.html'), scCompiled);
            }
            if (hasKosmiTemplate) {
                const altDir = path.join(wwwDir, 'alternatives');
                fs.mkdirSync(altDir, { recursive: true });
                const koCompiled = compileAlternativePage(kosmiTemplate, locale, lang, '../', '');
                fs.writeFileSync(path.join(altDir, 'kosmi.html'), koCompiled);
            }
            if (hasTwosevenTemplate) {
                const altDir = path.join(wwwDir, 'alternatives');
                fs.mkdirSync(altDir, { recursive: true });
                const tsCompiled = compileAlternativePage(twosevenTemplate, locale, lang, '../', '');
                fs.writeFileSync(path.join(altDir, 'twoseven.html'), tsCompiled);
            }
            if (hasOverviewTemplate) {
                const altDir = path.join(wwwDir, 'alternatives');
                fs.mkdirSync(altDir, { recursive: true });
                const ovCompiled = compileAlternativePage(overviewTemplate, locale, lang, '../', '');
                fs.writeFileSync(path.join(altDir, 'index.html'), ovCompiled);
            }
        } else {
            console.log(`Compiling ${lang.toUpperCase()} (${lang}/index.html)...`);
            const langDir = path.join(wwwDir, lang);
            fs.mkdirSync(langDir, { recursive: true });
            const html = compilePage(locale, '../', lang);
            fs.writeFileSync(path.join(langDir, 'index.html'), html);
            englishHtml[lang] = html;

            // Compile alternatives for other languages (assets resolved using '../../' prefix)
            if (hasTelepartyTemplate) {
                const langAltDir = path.join(langDir, 'alternatives');
                fs.mkdirSync(langAltDir, { recursive: true });
                const tpCompiled = compileAlternativePage(telepartyTemplate, locale, lang, '../../', lang + '/');
                fs.writeFileSync(path.join(langAltDir, 'teleparty.html'), tpCompiled);
            }
            if (hasScreenSharingTemplate) {
                const langAltDir = path.join(langDir, 'alternatives');
                fs.mkdirSync(langAltDir, { recursive: true });
                const ssCompiled = compileAlternativePage(screenSharingTemplate, locale, lang, '../../', lang + '/');
                fs.writeFileSync(path.join(langAltDir, 'screen-sharing.html'), ssCompiled);
            }
            if (hasWatch2getherTemplate) {
                const langAltDir = path.join(langDir, 'alternatives');
                fs.mkdirSync(langAltDir, { recursive: true });
                const w2gCompiled = compileAlternativePage(watch2getherTemplate, locale, lang, '../../', lang + '/');
                fs.writeFileSync(path.join(langAltDir, 'watch2gether.html'), w2gCompiled);
            }
            if (hasScenerTemplate) {
                const langAltDir = path.join(langDir, 'alternatives');
                fs.mkdirSync(langAltDir, { recursive: true });
                const scCompiled = compileAlternativePage(scenerTemplate, locale, lang, '../../', lang + '/');
                fs.writeFileSync(path.join(langAltDir, 'scener.html'), scCompiled);
            }
            if (hasKosmiTemplate) {
                const langAltDir = path.join(langDir, 'alternatives');
                fs.mkdirSync(langAltDir, { recursive: true });
                const koCompiled = compileAlternativePage(kosmiTemplate, locale, lang, '../../', lang + '/');
                fs.writeFileSync(path.join(langAltDir, 'kosmi.html'), koCompiled);
            }
            if (hasTwosevenTemplate) {
                const langAltDir = path.join(langDir, 'alternatives');
                fs.mkdirSync(langAltDir, { recursive: true });
                const tsCompiled = compileAlternativePage(twosevenTemplate, locale, lang, '../../', lang + '/');
                fs.writeFileSync(path.join(langAltDir, 'twoseven.html'), tsCompiled);
            }
            if (hasOverviewTemplate) {
                const langAltDir = path.join(langDir, 'alternatives');
                fs.mkdirSync(langAltDir, { recursive: true });
                const ovCompiled = compileAlternativePage(overviewTemplate, locale, lang, '../../', lang + '/');
                fs.writeFileSync(path.join(langAltDir, 'index.html'), ovCompiled);
            }
        }
    }

    // ── 4. Copy static HTML files ──
    console.log('Copying static pages...');
    fs.mkdirSync(path.join(wwwDir, 'de'), { recursive: true });
    const staticMappings = [
        { src: 'join.html', dest: 'join.html' },
        { src: 'imprint.html', dest: 'imprint.html' },
        { src: 'privacy.html', dest: 'privacy.html' },
        { src: 'impressum-de.html', dest: 'de/impressum.html' },
        { src: 'datenschutz-de.html', dest: 'de/datenschutz.html' },
        { src: 'impressum.html', dest: 'impressum.html' },
        { src: 'datenschutz.html', dest: 'datenschutz.html' }
    ];
    for (const mapping of staticMappings) {
        const src = path.join(websiteDir, mapping.src);
        const dest = path.join(wwwDir, mapping.dest);
        if (fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            console.log(`  Copied: ${mapping.src} → ${mapping.dest}`);
        }
    }

    // ── 5. Copy generic static files and verification files ──
    const genericFiles = ['robots.txt', 'site.webmanifest', 'version.json', 'llms.txt'];
    for (const file of genericFiles) {
        const src = path.join(websiteDir, file);
        const dest = path.join(wwwDir, file);
        if (fs.existsSync(src)) { fs.copyFileSync(src, dest); }
    }

    // ── 5.5 Generate dynamic sitemap ──
    generateSitemap(wwwDir, websiteDir);

    // Auto-copy Google verification files and IndexNow/txt key files from website source to www root
    const websiteFiles = fs.readdirSync(websiteDir);
    for (const file of websiteFiles) {
        const filePath = path.join(websiteDir, file);
        if (fs.statSync(filePath).isFile()) {
            // Match google[hex/alphanumeric].html or any hex/uuid txt file (e.g. 4650678bb36b488d8f64343a67f1b931.txt)
            const isGoogleVerification = /^google[a-zA-Z0-9_-]+\.html$/i.test(file);
            const isIndexNowVerification = (/^[a-zA-Z0-9_-]{8,}\.txt$/i.test(file) || /^[a-f0-9-]{32,36}$/i.test(file)) && file !== 'robots.txt';
            
            if (isGoogleVerification || isIndexNowVerification) {
                const dest = path.join(wwwDir, file);
                fs.copyFileSync(filePath, dest);
                console.log(`  Copied verification file: ${file} → ${file}`);
            }
        }
    }

    // ── 6. Copy assets ──
    console.log('Copying assets...');
    const srcAssets = path.join(websiteDir, 'assets');
    const destAssets = path.join(wwwDir, 'assets');
    if (fs.existsSync(srcAssets)) {
        copyDirSync(srcAssets, destAssets);
        console.log('  Assets copied.');
    }

    // Copy apple-touch-icon to www root (browsers/iOS request these at /)
    const appleTouchSrc = path.join(destAssets, 'apple-touch-icon.png');
    if (fs.existsSync(appleTouchSrc)) {
        fs.copyFileSync(appleTouchSrc, path.join(wwwDir, 'apple-touch-icon.png'));
        fs.copyFileSync(appleTouchSrc, path.join(wwwDir, 'apple-touch-icon-precomposed.png'));
        console.log('  ✓ Apple touch icons copied to www root.');
    }

    // ── 7. Convert all WebP to AVIF (quality 65) ──
    console.log('Converting WebP → AVIF...');
    let avifCount = 0;
    const webpFiles = fs.readdirSync(destAssets).filter(f => f.endsWith('.webp'));
    for (const f of webpFiles) {
        const src = path.join(destAssets, f);
        const stat = fs.statSync(src);
        if (stat.size < MIN_AVIF_KB * 1024) continue;
        const dest = path.join(destAssets, f.replace(/\.webp$/, '.avif'));
        if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= stat.mtimeMs) continue;
        await sharp(src).avif({ quality: 65, speed: 4 }).toFile(dest);
        avifCount++;
    }
    console.log(`  ${avifCount} AVIF files generated.`);

    // ── 8. Post-process ALL HTML files ──
    console.log('Post-processing HTML...');
    function walkHtml(dir, fn) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) { walkHtml(p, fn); }
            else if (entry.name.endsWith('.html')) { fn(p); }
        }
    }

    walkHtml(wwwDir, (filePath) => {
        let html = fs.readFileSync(filePath, 'utf8');

        // 8a. Replace hashed asset refs and inject SRI (Subresource Integrity)
        html = html.replace(/(<link\b[^>]*?\bhref=")((?:\.\.\/)*)style\.min\.css"/g, (m, before, prefix) => {
            return `${before}${prefix}${styleName}" integrity="${styleSRI}" crossorigin="anonymous"`;
        });
        html = html.replace(/(<script\b[^>]*?\bsrc=")((?:\.\.\/)*)app\.min\.js"/g, (m, before, prefix) => {
            return `${before}${prefix}${appName}" integrity="${appSRI}" crossorigin="anonymous"`;
        });
        html = html.replace(/(<script\b[^>]*?\bsrc=")((?:\.\.\/)*)lang-init\.min\.js"/g, (m, before, prefix) => {
            return `${before}${prefix}${langName}" integrity="${langSRI}" crossorigin="anonymous"`;
        });

        // 8b. Inject AVIF <picture> wrappers
        html = injectAvifPictures(html);

        // 8c. Minify inline SVGs
        html = minifyInlineSvgs(html);

        fs.writeFileSync(filePath, html);
    });

    console.log('KoalaSync build finished successfully! Output: website/www/');
}

function generateSitemap(wwwDir, websiteDir) {
    const languages = [
      { code: 'en', prefix: '', hreflang: 'en' },
      { code: 'de', prefix: 'de/', hreflang: 'de' },
      { code: 'fr', prefix: 'fr/', hreflang: 'fr' },
      { code: 'es', prefix: 'es/', hreflang: 'es' },
      { code: 'pt-BR', prefix: 'pt-BR/', hreflang: 'pt-br' },
      { code: 'ru', prefix: 'ru/', hreflang: 'ru' },
      { code: 'it', prefix: 'it/', hreflang: 'it' },
      { code: 'pl', prefix: 'pl/', hreflang: 'pl' },
      { code: 'tr', prefix: 'tr/', hreflang: 'tr' },
      { code: 'nl', prefix: 'nl/', hreflang: 'nl' },
      { code: 'ja', prefix: 'ja/', hreflang: 'ja' },
      { code: 'ko', prefix: 'ko/', hreflang: 'ko' },
      { code: 'zh', prefix: 'zh/', hreflang: 'zh' },
      { code: 'uk', prefix: 'uk/', hreflang: 'uk' },
      { code: 'pt', prefix: 'pt/', hreflang: 'pt' }
    ];

    const today = new Date().toISOString().split('T')[0];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">`;

    // Static legal pages
    xml += `
  <url>
    <loc>https://sync.koalastuff.net/imprint</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://sync.koalastuff.net/privacy</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://sync.koalastuff.net/de/impressum</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://sync.koalastuff.net/de/datenschutz</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>`;

    function addPage(relativePath, changefreq, priority) {
      for (const lang of languages) {
        const loc = `https://sync.koalastuff.net/${lang.prefix}${relativePath}`;
        xml += `
  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>`;
        for (const alt of languages) {
          const altHref = `https://sync.koalastuff.net/${alt.prefix}${relativePath}`;
          xml += `
    <xhtml:link rel="alternate" hreflang="${alt.hreflang}" href="${altHref}"/>`;
        }
        const defaultHref = `https://sync.koalastuff.net/${relativePath}`;
        xml += `
    <xhtml:link rel="alternate" hreflang="x-default" href="${defaultHref}"/>
  </url>`;
      }
    }

    addPage('', 'weekly', '1.0');
    addPage('alternatives', 'weekly', '0.7');

    const subpages = [
      'alternatives/teleparty',
      'alternatives/screen-sharing',
      'alternatives/watch2gether',
      'alternatives/scener',
      'alternatives/kosmi',
      'alternatives/twoseven'
    ];
    for (const sub of subpages) {
      addPage(sub, 'weekly', '0.7');
    }

    xml += `\n</urlset>\n`;

    fs.writeFileSync(path.join(websiteDir, 'sitemap.xml'), xml.trim() + '\n', 'utf8');
    fs.writeFileSync(path.join(wwwDir, 'sitemap.xml'), xml.trim() + '\n', 'utf8');
    console.log('  ✓ Dynamically generated sitemap.xml with current date');
}
compile().catch(err => { console.error('Build failed:', err); process.exit(1); });
