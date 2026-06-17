const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const rootDir = path.join(__dirname, '..');
const extDir = path.join(rootDir, 'extension');
const distDir = path.join(rootDir, 'dist');
const baseManifestPath = path.join(extDir, 'manifest.base.json');

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

const sharedFiles = ['constants.js', 'blacklist.js', 'names.js', 'README.md'];
for (const file of sharedFiles) {
  const src = path.join(masterSharedDir, file);
  const dest = path.join(extSharedDir, file);
  if (!fs.existsSync(src)) {
    throw new Error(`CRITICAL: Source shared file missing: ${src}. Aborting build to prevent broken artifacts.`);
  }
  fs.copyFileSync(src, dest);
}
console.log('✓ constants.js, blacklist.js, names.js, and README.md synced to extension/shared/');

// Read the base manifest
const baseManifest = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));

// Helper to copy files, ignoring manifest.json and manifest.base.json
// Also injects shared constants into content.js
function copyExtensionFiles(targetDir, browserName) {
  fs.mkdirSync(targetDir, { recursive: true });
  
  // Read master constants for injection
  const masterConstantsPath = path.join(rootDir, 'shared', 'constants.js');
  const constantsContent = fs.readFileSync(masterConstantsPath, 'utf8');
  
  // Robust Extraction using flexible regex
  const eventsMatch = constantsContent.match(/export const EVENTS\s*=\s*({[\s\S]+?});/);
  const heartbeatMatch = constantsContent.match(/export const HEARTBEAT_INTERVAL\s*=\s*(\d+);/);

  if (!eventsMatch) {
    throw new Error('CRITICAL: Could not find EVENTS object in shared/constants.js');
  }
  if (!heartbeatMatch) {
    throw new Error('CRITICAL: Could not find HEARTBEAT_INTERVAL in shared/constants.js');
  }

  const eventsObject = eventsMatch[1];
  const heartbeatVal = heartbeatMatch[1];
  
  const items = fs.readdirSync(extDir);
  for (const item of items) {
    if (item === 'manifest.json' || item === 'manifest.base.json') continue;
    
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
        const eRep = `${eStart}\n    // This block is automatically updated by /scripts/build-extension.js\n    const EVENTS = ${eventsObject};\n    ${eEnd}`;
        
        if (ePattern.test(content)) {
          content = content.replace(ePattern, eRep);
        } else {
          console.warn('⚠️ WARNING: Event markers not found in content.js');
        }

        // 2. Inject Heartbeat
        const hStart = '// --- SHARED_HEARTBEAT_INJECT_START ---';
        const hEnd = '// --- SHARED_HEARTBEAT_INJECT_END ---';
        const hPattern = new RegExp(`${hStart}[\\s\\S]+?${hEnd}`);
        const hRep = `${hStart}\n    const HEARTBEAT_INTERVAL_VAL = ${heartbeatVal};\n    ${hEnd}`;
        
        if (hPattern.test(content)) {
          content = content.replace(hPattern, hRep);
        } else {
          console.warn('⚠️ WARNING: Heartbeat markers not found in content.js');
        }

        // 3. Inject Episode Utils
        const euStart = '// --- SHARED_EPISODE_UTILS_INJECT_START ---';
        const euEnd = '// --- SHARED_EPISODE_UTILS_INJECT_END ---';
        const euPattern = new RegExp(euStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]+?' + euEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const euPath = path.join(rootDir, 'extension', 'episode-utils.js');
        if (fs.existsSync(euPath)) {
          const euContent = fs.readFileSync(euPath, 'utf8');
          const stripped = euContent
            .replace(/^\/\*\*[\s\S]*?\*\/\s*/m, '')
            .replace(/export function /g, 'function ')
            .trim();
          const euRep = `${euStart}\n    // This block is automatically updated by /scripts/build-extension.js\n${stripped.split('\n').map(l => '    ' + l).join('\n')}\n    ${euEnd}`;
          if (euPattern.test(content)) {
            content = content.replace(euPattern, euRep);
          } else {
            console.warn('⚠ WARNING: Episode utils markers not found in content.js');
          }
        }

        fs.writeFileSync(destPath, content);
        console.log('✓ Injected shared constants into content.js');
      } else if (item === 'background.js') {
        let content = fs.readFileSync(srcPath, 'utf8');
        
        // 3. Inject Uninstall URL Constants
        const uStart = '// --- UNINSTALL_URL_INJECT_START ---';
        const uEnd = '// --- UNINSTALL_URL_INJECT_END ---';
        const uPattern = new RegExp(`${uStart}[\\s\\S]+?${uEnd}`);
        const placeholderUrl = "https://bye.koalastuff.net/c/camp_99ztjRVbK1BNN2RU";
        
        let uRep = `${uStart}\n        // This block is automatically updated by /scripts/build-extension.js\n`;
        uRep += `        const UNINSTALL_URL = "${placeholderUrl}";\n`;
        uRep += `        const BROWSER_TYPE = "${browserName}";\n`;
        uRep += `        ${uEnd}`;
        
        if (uPattern.test(content)) {
          content = content.replace(uPattern, uRep);
        } else {
          console.warn('⚠️ WARNING: Uninstall URL markers not found in background.js');
        }

        fs.writeFileSync(destPath, content);
        console.log(`✓ Injected uninstall URL constants for ${browserName} into background.js`);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

// Helper to zip a directory
function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(outPath);

    archive
      .directory(sourceDir, false)
      .on('error', err => reject(err))
      .pipe(stream);

    stream.on('close', () => resolve());
    archive.finalize();
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
      // Firefox does not support the 'key' property for extension IDs, it uses browser_specific_settings.gecko.id
      delete manifest.key;
      
      manifest.background = {
        scripts: ["background.js"],
        type: "module"
      };
      manifest.content_security_policy = {
        extension_pages: "script-src 'self'; connect-src 'self' ws://127.0.0.1:3000 ws://localhost:3000 wss://127.0.0.1:3000 wss://localhost:3000 https://sync.koalastuff.net wss://sync.koalastuff.net"
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
