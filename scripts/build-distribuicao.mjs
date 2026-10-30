import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { advancedObfuscate } from './obfuscator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'distribuicao');
const SRC_EXT = path.join(ROOT, 'extension');
const DESKTOP = path.join(process.env.USERPROFILE || 'C:/Users/miche', 'Desktop');

console.log('==> [Build] Iniciando empacotamento das distribuições Chrome e Firefox...');

// 1. Diretórios de saída
const DIRS = {
  chrome: path.join(DIST, 'chrome'),
  chromeMin: path.join(DIST, 'chrome-minificada'),
  firefox: path.join(DIST, 'firefox'),
  firefoxMin: path.join(DIST, 'firefox-minificada'),
};

for (const dir of Object.values(DIRS)) {
  fs.mkdirSync(dir, { recursive: true });
}

// 2. Lê manifest base do Chrome
const chromeManifestRaw = fs.readFileSync(path.join(SRC_EXT, 'manifest.json'), 'utf8');
const chromeManifest = JSON.parse(chromeManifestRaw);

// 3. Monta manifest específico para Firefox MV3
const firefoxManifest = {
  ...chromeManifest,
  background: {
    scripts: ['background.js']
  },
  browser_specific_settings: {
    gecko: {
      id: 'remote-desktop-hub@michelslvnqs.workers.dev',
      strict_min_version: '109.0'
    }
  }
};

// 4. Helper para cópia recursiva
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// 5. Preparar distribuicao/chrome (Sem ofuscação)
console.log('-> Preparando distribuicao/chrome (Limpa)...');
for (const item of ['background.js', 'content.js', 'popup.html', 'popup.js', 'icons']) {
  copyRecursive(path.join(SRC_EXT, item), path.join(DIRS.chrome, item));
}
fs.writeFileSync(path.join(DIRS.chrome, 'manifest.json'), JSON.stringify(chromeManifest, null, 2) + '\n', 'utf8');

// 6. Preparar distribuicao/firefox (Sem ofuscação - ideal para envio à Mozilla AMO)
console.log('-> Preparando distribuicao/firefox (Limpa para AMO)...');
for (const item of ['background.js', 'content.js', 'popup.html', 'popup.js', 'icons']) {
  copyRecursive(path.join(SRC_EXT, item), path.join(DIRS.firefox, item));
}
fs.writeFileSync(path.join(DIRS.firefox, 'manifest.json'), JSON.stringify(firefoxManifest, null, 2) + '\n', 'utf8');

// 7. Ofuscação Avançada Multi-estágio (Inspirado no padrão tp2026)
console.log('-> Executando Pipeline de Ofuscação Avançada (tp2026 standard)...');
const jsFiles = ['background.js', 'content.js', 'popup.js'];
const minifiedContents = {};

for (const js of jsFiles) {
  const code = fs.readFileSync(path.join(SRC_EXT, js), 'utf8');
  console.log(`   ==> Processando ${js}...`);
  minifiedContents[js] = await advancedObfuscate(code, js);
}

// 8. Montar distribuicao/chrome-minificada (Com ofuscação)
console.log('-> Montando distribuicao/chrome-minificada (Ofuscada)...');
for (const js of jsFiles) {
  fs.writeFileSync(path.join(DIRS.chromeMin, js), minifiedContents[js], 'utf8');
}
fs.copyFileSync(path.join(SRC_EXT, 'popup.html'), path.join(DIRS.chromeMin, 'popup.html'));
fs.writeFileSync(path.join(DIRS.chromeMin, 'manifest.json'), JSON.stringify(chromeManifest, null, 2) + '\n', 'utf8');
copyRecursive(path.join(SRC_EXT, 'icons'), path.join(DIRS.chromeMin, 'icons'));

// 9. Montar distribuicao/firefox-minificada (Com ofuscação)
console.log('-> Montando distribuicao/firefox-minificada (Ofuscada)...');
for (const js of jsFiles) {
  fs.writeFileSync(path.join(DIRS.firefoxMin, js), minifiedContents[js], 'utf8');
}
fs.copyFileSync(path.join(SRC_EXT, 'popup.html'), path.join(DIRS.firefoxMin, 'popup.html'));
fs.writeFileSync(path.join(DIRS.firefoxMin, 'manifest.json'), JSON.stringify(firefoxManifest, null, 2) + '\n', 'utf8');
copyRecursive(path.join(SRC_EXT, 'icons'), path.join(DIRS.firefoxMin, 'icons'));

// 10. Empacotar arquivos ZIP
console.log('-> Gerando pacotes ZIP com make-zip.py...');
const makeZipPy = path.join(ROOT, 'scripts', 'make-zip.py');

function createZip(sourceDir, zipTarget) {
  if (fs.existsSync(zipTarget)) fs.unlinkSync(zipTarget);
  execSync(`python "${makeZipPy}" "${sourceDir}" "${zipTarget}"`, {
    stdio: 'inherit'
  });
}

// Arquivos de saída
const packages = [
  {
    name: 'remote-desktop-chrome.zip',
    source: DIRS.chrome
  },
  {
    name: 'remote-desktop-chrome-minificada.zip',
    source: DIRS.chromeMin
  },
  {
    name: 'remote-desktop-firefox.zip',
    source: DIRS.firefox
  },
  {
    name: 'remote-desktop-firefox-minificada.zip',
    source: DIRS.firefoxMin
  }
];

for (const pkg of packages) {
  const distZip = path.join(DIST, pkg.name);
  const desktopZip = path.join(DESKTOP, pkg.name);

  createZip(pkg.source, distZip);
  fs.copyFileSync(distZip, desktopZip);
  console.log(`   [Desktop] Copiado para: ${desktopZip}`);
}

console.log('\n==> [Sucesso] Todas as distribuições foram geradas e os ZIPs estão na Área de Trabalho!');
