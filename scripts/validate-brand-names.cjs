const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, '../website/locales');
const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json') && f !== 'en.json');

const brandTranslations = [
  'dos siete', 'dos-siete', 'deux sept', 'deux-sept', 'zwei sieben', 'zwei-sieben',
  'due sette', 'due-sette', 'dwa siedem', 'dwa-siedem', 'twee zeven', 'twee-zeven',
  'iki yedi', 'iki-yedi', 'два семь', 'два-семь', '二七', '二 七', '이칠', '이 칠',
  'koala sync', 'koala-sync', 'watch 2 gether', 'watch-2-gether', 'watch 2gether',
  'watch-2gether', 'jelly fin', 'jelly-fin'
];

let failed = false;

for (const file of files) {
  const filePath = path.join(localesDir, file);
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  for (const [key, value] of Object.entries(content)) {
    if (typeof value !== 'string') continue;
    
    // Check brand translations (case-insensitive)
    const lowerValue = value.toLowerCase();
    for (const pattern of brandTranslations) {
      if (lowerValue.includes(pattern)) {
        console.error(`Error in ${file} [key: ${key}]: Found translated brand pattern "${pattern}" in value: "${value}"`);
        failed = true;
      }
    }

    // Check tag validation
    const tags = ['strong', 'em', 'span', 'b', 'i', 'p', 'a'];
    for (const tag of tags) {
      const openCount = (value.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) || []).length;
      const closeCount = (value.match(new RegExp(`</${tag}\\b[^>]*>`, 'g')) || []).length;
      if (openCount !== closeCount) {
        console.error(`Error in ${file} [key: ${key}]: Unbalanced tag <${tag}> (open: ${openCount}, close: ${closeCount}) in value: "${value}"`);
        failed = true;
      }
    }
  }
}

if (!failed) {
  console.log("All brand names and HTML tags are perfectly valid and intact across all languages!");
} else {
  process.exit(1);
}
