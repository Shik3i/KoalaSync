/**
 * KoalaSync Locale Translation Script
 * 
 * This script is stored in `scripts/translate-locales-tool.cjs`
 * so future LLM agents can easily reuse and adapt it to translate new keys.
 * 
 * Usage:
 *   node scripts/translate-locales-tool.cjs
 */

const fs = require('fs');
const path = require('path');
const http = require('https');

const localesDir = path.join(__dirname, '../website/locales');
const enFile = path.join(localesDir, 'en.json');
const enLocale = JSON.parse(fs.readFileSync(enFile, 'utf8'));

// Keys starting with these prefixes need to be translated.
// Update this list when translating new pages or features.
const prefixes = ['ALT_W2G_', 'ALT_SCENER_', 'ALT_KOSMI_', 'ALT_TWOSEVEN_'];

const keysToTranslate = Object.keys(enLocale).filter(key => {
  return prefixes.some(prefix => key.startsWith(prefix));
});

console.log(`Found ${keysToTranslate.length} keys to translate.`);

function translate(text, targetLang) {
  return new Promise((resolve, reject) => {
    // We use Google's free translation endpoint which is highly robust for standard text segment translations
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const translation = parsed[0].map(item => item[0]).join('');
          resolve(translation);
        } catch (_e) {
          reject(new Error(`Failed to parse response for target ${targetLang}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const fileToLangMap = {
  'es.json': 'es',
  'fr.json': 'fr',
  'it.json': 'it',
  'ja.json': 'ja',
  'ko.json': 'ko',
  'nl.json': 'nl',
  'pl.json': 'pl',
  'pt-BR.json': 'pt',
  'pt.json': 'pt',
  'ru.json': 'ru',
  'tr.json': 'tr',
  'uk.json': 'uk',
  'zh.json': 'zh-CN'
};

async function run() {
  const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json') && f !== 'en.json' && f !== 'de.json');

  for (const file of files) {
    const targetLang = fileToLangMap[file];
    if (!targetLang) {
      console.log(`Skipping unknown file mapping: ${file}`);
      continue;
    }

    const filePath = path.join(localesDir, file);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    console.log(`\nTranslating ${file} (${targetLang})...`);
    let translatedCount = 0;

    for (const key of keysToTranslate) {
      const englishValue = enLocale[key];
      // Translate if missing or currently identical to English value (which means it's a fallback)
      if (!content[key] || content[key] === englishValue) {
        try {
          const translatedValue = await translate(englishValue, targetLang);
          content[key] = translatedValue;
          translatedCount++;
          console.log(`  [${translatedCount}/${keysToTranslate.length}] Translated key: ${key}`);
          await sleep(200); // 200ms delay to prevent rate limits
        } catch (err) {
          console.error(`  Error translating key ${key} to ${targetLang}:`, err.message);
          // Wait longer on error
          await sleep(2000);
        }
      }
    }

    // Save back keeping exact same structure and format
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n', 'utf8');
    console.log(`Saved ${file} (${translatedCount} keys updated).`);
  }

  console.log('\nAll translations completed successfully!');
}

run().catch(err => {
  console.error('Translation script failed:', err);
});
