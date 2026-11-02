#!/usr/bin/env node
/**
 * Script utilitário para gerar o arquivo `latest.json` do Tauri v2 Auto-Updater
 * apontando estritamente para o GitHub Releases.
 *
 * Repositório Oficial: skylineinfogamer/multitracks-stage-software
 *
 * Ele lê automaticamente:
 * 1. A versão atual configurada em `src-tauri/tauri.conf.json` (ou via argumento `--version`).
 * 2. O arquivo .sig e o instalador gerados pelo Tauri CLI em `src-tauri/target/release/bundle/nsis/`.
 * 3. Monta e grava `latest.json` pronto para publicação no GitHub Releases.
 *
 * Uso:
 *   node generate-update-json.mjs
 *   node generate-update-json.mjs --version 1.0.1
 *   node generate-update-json.mjs --version 1.0.1 --out-dir releases-test/v1.0.1
 *   node generate-update-json.mjs --notes "Melhorias no mixer e no motor de áudio"
 */

import fs from 'fs';
import path from 'path';

const REPO_OWNER = 'skylineinfogamer';
const REPO_NAME = 'multitracks-stage-software';

// Novo endpoint do Cube Hosting para auto-updater
const CUBE_HOSTING_ENDPOINT = 'https://worshiptools-28vv4k.cubehost.dev';

const ROOT_DIR = process.cwd();
const TAURI_CONF_PATH = path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
const NSIS_DIR = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

// 1. Carrega tauri.conf.json
if (!fs.existsSync(TAURI_CONF_PATH)) {
  console.error('❌ Arquivo src-tauri/tauri.conf.json não encontrado!');
  process.exit(1);
}

const tauriConf = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, 'utf8'));
let version = tauriConf.version || '1.0.0';
const productName = tauriConf.productName || 'Worship Tools';

// Argumentos CLI
const args = process.argv.slice(2);
let customNotes = `Worship Tools v${version}

## 🚀 Novidades Principais
- ☁️ **Nuvem Dedicada por Usuário** — 500 GB de armazenamento isolado no Backblaze B2 para cada assinante Pro Cloud, com pasta exclusiva e zero mistura de arquivos.
- 🎵 **Setlist Sincronizada com Painel do Músico** — Crie e edite repertórios no painel web e sincronize instantaneamente no app desktop (um clique via Wi-Fi).
- 💾 **Cache Local Inteligente de Multitracks** — Downloads repetidos agora usam o cache do PC (0 KB de tráfego B2, economia real de custos).

## ⚡ Performance & Estabilidade
- Interface mais fluida: renderização otimizada, menos re-renders, zero engasgos em setlists longas.
- Motor de áudio ASIO/WASAPI refinado — latência consistente, sem cracks nem drops.
- Auto-Updater robusto: verificação de integridade digital, download resumível, fallback automático.
- Correção de vazamento de memória em sessões prolongadas (>4h).

## 🔧 Correções & Polimento
- Admin Web: proteção de rota \`/admin/\` com validação JWT + role=admin (fim de bypass por URL direta).
- CORS: wildcard \`*\` removido em produção — origem explícita apenas.
- Mobile: header responsivo corrigido (logo + botão sem sobreposição).
- Copy do Landing: "Backblaze B2" → "Nuvem ultra rápida em servidores dedicados".

## 🛡️ Segurança
- Rotação recomendada de todas as credenciais (Supabase Service Role, B2 App Key, senhas admin).
- Rate limiting reforçado em endpoints sensíveis.`;
let targetDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version' && args[i + 1]) {
    version = args[i + 1];
    i++;
  } else if (args[i] === '--notes' && args[i + 1]) {
    customNotes = args[i + 1];
    i++;
  } else if (args[i] === '--out-dir' && args[i + 1]) {
    targetDir = path.resolve(ROOT_DIR, args[i + 1]);
    i++;
  }
}

console.log('========================================================');
console.log(`📦 Gerador de manifesto latest.json (Cube Hosting)`);
console.log(`📌 Produto: ${productName} | Versão: v${version}`);
console.log(`🔗 Endpoint: ${CUBE_HOSTING_ENDPOINT}`);
console.log('========================================================');

// 2. Localiza instalador e assinatura .sig
let searchDirs = [NSIS_DIR];
if (targetDir && fs.existsSync(targetDir)) {
  searchDirs.unshift(targetDir);
}

let exeFile = null;
let sigFile = null;
let foundDir = NSIS_DIR;

for (const d of searchDirs) {
  if (fs.existsSync(d)) {
    const files = fs.readdirSync(d);
    sigFile = files.find((f) => f.endsWith('.sig') && f.includes(version)) || files.find((f) => f.endsWith('.sig'));
    exeFile = files.find((f) => f.endsWith('.exe') && !f.endsWith('.sig') && f.includes(version)) || files.find((f) => f.endsWith('.exe') && !f.endsWith('.sig'));
    if (sigFile && exeFile) {
      foundDir = d;
      break;
    }
  }
}

if (!sigFile) {
  console.error(`❌ Nenhum arquivo de assinatura (.sig) encontrado!`);
  console.error(`👉 Certifique-se de executar 'npm run tauri build' com a variável TAURI_SIGNING_PRIVATE_KEY configurada.`);
  process.exit(1);
}

const sigPath = path.join(foundDir, sigFile);
const signature = fs.readFileSync(sigPath, 'utf8').trim();

const rawExeName = exeFile || `${productName}_${version}_x64-setup.exe`;
// No Cube Hosting, substitui espaços por pontos para compatibilidade total de download
const sanitizedAssetName = rawExeName.replace(/\s+/g, '.');
const downloadUrl = `${CUBE_HOSTING_ENDPOINT}/updates/${sanitizedAssetName}`;

console.log(`🔍 Instalador detectado: ${rawExeName}`);
console.log(`🏷️  Nome do asset: ${sanitizedAssetName}`);
console.log(`🔑 Assinatura digital lida de: ${sigFile} (${signature.length} caracteres)`);
console.log(`🌐 URL pública no Cube Hosting: ${downloadUrl}`);

// 3. Monta estrutura padrão do Tauri v2 updater
const updateManifest = {
  version,
  notes: customNotes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: downloadUrl,
    },
  },
};

// 4. Salva latest.json na raiz e nas pastas de destino
const outputPaths = [path.join(ROOT_DIR, 'latest.json')];

if (fs.existsSync(NSIS_DIR)) {
  outputPaths.push(path.join(NSIS_DIR, 'latest.json'));
}

if (targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  outputPaths.push(path.join(targetDir, 'latest.json'));
}

for (const p of outputPaths) {
  fs.writeFileSync(p, JSON.stringify(updateManifest, null, 2), 'utf8');
  console.log(`✅ Arquivo salvo: ${p}`);
}

console.log('========================================================');
console.log('📋 Conteúdo do latest.json:');
console.log(JSON.stringify(updateManifest, null, 2));
console.log('========================================================\n');
