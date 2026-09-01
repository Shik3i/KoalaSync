const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const extDir = path.join(rootDir, 'extension');
const distDir = path.join(rootDir, 'dist');
const baseManifestPath = path.join(extDir, 'manifest.base.json');
const localesDir = path.join(extDir, '_locales');
const requiredAppName = 'Watch Party - KoalaSync';
const maxAppNameLength = 75;
const maxAppDescLength = 132;

function countUnicodeCharacters(value) {
  return Array.from(value).length;
}

function validateExtensionMetadata() {
  const localeDirectories = fs.readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const locale of localeDirectories) {
    const messagesPath = path.join(localesDir, locale, 'messages.json');
    let messages;

    try {
      messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    } catch (error) {
      throw new Error(`CRITICAL: Invalid locale JSON at _locales/${locale}/messages.json: ${error.message}`);
    }

    if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
      throw new Error(`CRITICAL: _locales/${locale}/messages.json must contain a JSON object`);
    }

    for (const key of ['appName', 'appDesc']) {
      if (!messages[key] || typeof messages[key].message !== 'string' || messages[key].message.trim().length === 0) {
        throw new Error(`CRITICAL: _locales/${locale}/messages.json is missing a valid ${key}.message`);
      }
    }

    const appNameLength = countUnicodeCharacters(messages.appName.message);
    const appDescLength = countUnicodeCharacters(messages.appDesc.message);

    if (appNameLength > maxAppNameLength) {
      throw new Error(`CRITICAL: _locales/${locale}/messages.json appName.message is ${appNameLength} characters; maximum is ${maxAppNameLength}`);
    }
    if (messages.appName.message !== requiredAppName) {
      throw new Error(`CRITICAL: _locales/${locale}/messages.json appName.message must exactly equal "${requiredAppName}"`);
    }
    if (appDescLength > maxAppDescLength) {
      throw new Error(`CRITICAL: _locales/${locale}/messages.json appDesc.message is ${appDescLength} characters; maximum is ${maxAppDescLength}`);
    }
  }

  console.log(`✓ Validated localized extension metadata for ${localeDirectories.length} locales`);
}

validateExtensionMetadata();

// Ensure dist directory exists
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

// Sync shared constants from root /shared to /extension/shared
console.log('Syncing protocol constants...');
const masterSharedDir = path.join(rootDir, 'shared');
const extSharedDir = path.join(extDir, 'shared');

if (!fs.existsSync(extSharedDir)) {
  fs.mkdirSync(extSharedDir, { recursive: true });
}

const sharedFiles = ['constants.js', 'blacklist.js', 'names.js', 'invite-links.js', 'README.md'];
for (const file of sharedFiles) {
  const src = path.join(masterSharedDir, file);
  const dest = path.join(extSharedDir, file);
  if (!fs.existsSync(src)) {
    throw new Error(`CRITICAL: Source shared file missing: ${src}. Aborting build to prevent broken artifacts.`);
  }
  fs.copyFileSync(src, dest);
}
console.log('✓ shared runtime files synced to extension/shared/');

// Read the base manifest
const baseManifest = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));

function replaceRequiredBlock(content, pattern, replacement, description) {
  if (!pattern.test(content)) {
    throw new Error(`CRITICAL: ${description} markers not found. Aborting build to prevent stale artifacts.`);
  }
  return content.replace(pattern, replacement);
}

// Helper to copy runtime files, ignoring source manifests and test-only modules
// Also injects shared constants into content.js
function copyExtensionFiles(targetDir, browserName) {
  fs.mkdirSync(targetDir, { recursive: true });
  
  // Read master constants for injection
  const masterConstantsPath = path.join(rootDir, 'shared', 'constants.js');
  const constantsContent = fs.readFileSync(masterConstantsPath, 'utf8');
  
  // Robust Extraction using flexible regex
  const eventsMatch = constantsContent.match(/export const EVENTS\s*=\s*({[\s\S]+?});/);
  const heartbeatMatch = constantsContent.match(/export const HEARTBEAT_INTERVAL\s*=\s*(\d+);/);
  const maxMediaTimeMatch = constantsContent.match(/export const MAX_MEDIA_TIME\s*=\s*(\d+);/);
  const episodeSyncStabilityMatch = constantsContent.match(/export const EPISODE_SYNC_V2_STABILITY_MS\s*=\s*(\d+);/);

  if (!eventsMatch) {
    throw new Error('CRITICAL: Could not find EVENTS object in shared/constants.js');
  }
  if (!heartbeatMatch) {
    throw new Error('CRITICAL: Could not find HEARTBEAT_INTERVAL in shared/constants.js');
  }
  if (!maxMediaTimeMatch) {
    throw new Error('CRITICAL: Could not find MAX_MEDIA_TIME in shared/constants.js');
  }
  if (!episodeSyncStabilityMatch) {
    throw new Error('CRITICAL: Could not find EPISODE_SYNC_V2_STABILITY_MS in shared/constants.js');
  }

  const eventsObject = eventsMatch[1];
  const heartbeatVal = heartbeatMatch[1];
  const maxMediaTimeVal = maxMediaTimeMatch[1];
  const episodeSyncStabilityVal = episodeSyncStabilityMatch[1];
  
  const items = fs.readdirSync(extDir);
  for (const item of items) {
    if (item === 'manifest.json' || item === 'manifest.base.json' || /\.test\.[cm]?js$/u.test(item)) continue;
    
    const srcPath = path.join(extDir, item);
    const destPath = path.join(targetDir, item);
    
    if (fs.lstatSync(srcPath).isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true });
    } else {
      if (item === 'content.js') {
        // Perform injection
        let content = fs.readFileSync(srcPath, 'utf8');
        
        // 1. Inject Events
        const eStart = '// --- SHARED_EVENTS_INJECT_START ---';
        const eEnd = '// --- SHARED_EVENTS_INJECT_END ---';
        const ePattern = new RegExp(`${eStart}[\\s\\S]+?${eEnd}`);
        const eRep = `${eStart}\n    // This block is automatically updated by /scripts/build-extension.cjs\n    const EVENTS = ${eventsObject};\n    const MAX_MEDIA_TIME = ${maxMediaTimeVal};\n    const EPISODE_SYNC_V2_STABILITY_MS = ${episodeSyncStabilityVal};\n    ${eEnd}`;
        
        content = replaceRequiredBlock(content, ePattern, eRep, 'Event injection');

        // 2. Inject Heartbeat
        const hStart = '// --- SHARED_HEARTBEAT_INJECT_START ---';
        const hEnd = '// --- SHARED_HEARTBEAT_INJECT_END ---';
        const hPattern = new RegExp(`${hStart}[\\s\\S]+?${hEnd}`);
        const hRep = `${hStart}\n    const HEARTBEAT_INTERVAL_VAL = ${heartbeatVal};\n    ${hEnd}`;
        
        content = replaceRequiredBlock(content, hPattern, hRep, 'Heartbeat injection');

        // 3. Inject Episode Utils
        const euStart = '// --- SHARED_EPISODE_UTILS_INJECT_START ---';
        const euEnd = '// --- SHARED_EPISODE_UTILS_INJECT_END ---';
        const euPattern = new RegExp(euStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]+?' + euEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const euPath = path.join(rootDir, 'extension', 'episode-utils.js');
        if (!fs.existsSync(euPath)) {
          throw new Error(`CRITICAL: Episode utils source missing: ${euPath}. Aborting build.`);
        }
        const euContent = fs.readFileSync(euPath, 'utf8');
        const stripped = euContent
          .replace(/^\/\*\*[\s\S]*?\*\/\s*/m, '')
          .replace(/export function /g, 'function ')
          .trim();
        const euRep = `${euStart}\n    // This block is automatically updated by /scripts/build-extension.cjs\n${stripped.split('\n').map(l => '    ' + l).join('\n')}\n    ${euEnd}`;
        content = replaceRequiredBlock(content, euPattern, euRep, 'Episode utils injection');

        fs.writeFileSync(destPath, content);
        console.log('✓ Injected shared constants into content.js');
      } else if (item === 'background.js') {
        let content = fs.readFileSync(srcPath, 'utf8');
        
        // 3. Inject Uninstall URL Constants
        const uStart = '// --- UNINSTALL_URL_INJECT_START ---';
        const uEnd = '// --- UNINSTALL_URL_INJECT_END ---';
        const uPattern = new RegExp(`${uStart}[\\s\\S]+?${uEnd}`);
        const placeholderUrl = "https://bye.koalastuff.net/c/camp_99ztjRVbK1BNN2RU";
        
        let uRep = `${uStart}\n        // This block is automatically updated by /scripts/build-extension.cjs\n`;
        uRep += `        const UNINSTALL_URL = "${placeholderUrl}";\n`;
        uRep += `        const BROWSER_TYPE = "${browserName}";\n`;
        uRep += `        ${uEnd}`;
        
        content = replaceRequiredBlock(content, uPattern, uRep, 'Uninstall URL injection');

        fs.writeFileSync(destPath, content);
        console.log(`✓ Injected uninstall URL constants for ${browserName} into background.js`);
      } else if (item === 'canonical-media-state.js' || item === 'offline-media-intent.js') {
        let content = fs.readFileSync(srcPath, 'utf8');
        const sourceImport = "from '../shared/constants.js'";
        if (!content.includes(sourceImport)) {
          throw new Error(`CRITICAL: Source shared constants import missing in ${item}. Aborting build.`);
        }
        content = content.replace(sourceImport, "from './shared/constants.js'");
        fs.writeFileSync(destPath, content);
      } else if (item === 'popup.html') {
        let content = fs.readFileSync(srcPath, 'utf8');
        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
        if (!content.includes('__BUILD_TIMESTAMP__')) {
          throw new Error('CRITICAL: Build timestamp placeholder not found in popup.html. Aborting build.');
        }
        content = content.replace(/__BUILD_TIMESTAMP__/g, timestamp);
        fs.writeFileSync(destPath, content);
        console.log(`✓ Injected build timestamp into popup.html: ${timestamp}`);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

// Helper to zip a directory
async function zipDirectory(sourceDir, outPath) {
  const { ZipArchive } = await import('archiver');
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const stream = fs.createWriteStream(outPath);

    archive.on('error', reject);
    stream.on('close', () => resolve());
    stream.on('error', reject);
    archive.pipe(stream);
    archive.directory(sourceDir, false);
    void archive.finalize().catch(reject);
  });
}

async function buildBrowser(browserName, manifestModifier) {
  console.log(`Building for ${browserName}...`);
  const browserDistDir = path.join(distDir, browserName);
  
  // 1. Copy files
  copyExtensionFiles(browserDistDir, browserName);
  
  // 2. Modify and write manifest
  const browserManifest = manifestModifier(JSON.parse(JSON.stringify(baseManifest)));
  fs.writeFileSync(
    path.join(browserDistDir, 'manifest.json'),
    JSON.stringify(browserManifest, null, 2)
  );

  // 3. Zip it
  const zipPath = path.join(distDir, `koalasync-${browserName}.zip`);
  await zipDirectory(browserDistDir, zipPath);
  console.log(`Successfully built and zipped ${browserName} -> ${zipPath}`);
}

async function run() {
  try {
    // Build Chrome
    await buildBrowser('chrome', (manifest) => {
      manifest.background = {
        service_worker: "background.js",
        type: "module"
      };
      return manifest;
    });

    // Build Firefox
    await buildBrowser('firefox', (manifest) => {
      manifest.background = {
        scripts: ["background.js"],
        type: "module"
      };
      manifest.browser_specific_settings = {
        gecko: {
          id: "koalasync@koalastuff.net",
          data_collection_permissions: {
            required: ["none"]
          }
        }
      };
      return manifest;
    });

    console.log('Build complete!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

run();
