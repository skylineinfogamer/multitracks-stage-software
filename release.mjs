#!/usr/bin/env node
/**
 * Worship Tools - Release Automation Script
 *
 * Automatiza o ciclo completo de release do aplicativo Tauri:
 * 1. Leitura da versão a partir de `src-tauri/tauri.conf.json`.
 * 2. Carregamento de variáveis de ambiente do `.env` (chaves e senhas).
 * 3. Compilação do frontend e build nativo assinado (`npm run tauri build`).
 * 4. Verificação e fallback de assinatura digital via `tauri signer sign`.
 * 5. Geração automatizada do manifesto `latest.json` para o GitHub Releases.
 * 6. Publicação/Upload de release e assets via GitHub CLI (`gh`).
 *
 * Uso:
 *   npm run release
 *   node release.mjs
 *   node release.mjs --notes "Correções de estabilidade e melhorias no mixer"
 *   node release.mjs --dry-run (executa build e assinatura sem criar a release no GitHub)
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

const ROOT_DIR = process.cwd();
const TAURI_CONF_PATH = path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
const ENV_PATH = path.join(ROOT_DIR, '.env');
const NSIS_DIR = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

console.log('\n========================================================');
console.log('🚀 Worship Tools - Pipeline de Release e Auto-Updater');
console.log('========================================================\n');

// ---------------------------------------------------------------------------
// 1. Carregamento de variáveis do .env (sem dependências externas)
// ---------------------------------------------------------------------------
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.warn('⚠️  Arquivo .env não encontrado na raiz. Usando variáveis do ambiente.');
    return;
  }

  const content = fs.readFileSync(ENV_PATH, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadEnv();

// Mapeia sinônimos de variáveis do Tauri
const privateKeyRaw =
  process.env.TAURI_SIGNING_PRIVATE_KEY ||
  process.env.TAURI_PRIVATE_KEY ||
  process.env.TAURI_KEY ||
  '';

const privateKeyPassword =
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ||
  process.env.TAURI_KEY_PASSWORD ||
  process.env.TAURI_PASSWORD ||
  '';

let keyFilePath = null;
let keyFileContent = '';

// Verifica se a variável aponta para um arquivo existente ou se é a chave em texto
if (privateKeyRaw && fs.existsSync(path.resolve(ROOT_DIR, privateKeyRaw))) {
  keyFilePath = path.resolve(ROOT_DIR, privateKeyRaw);
  keyFileContent = fs.readFileSync(keyFilePath, 'utf8').trim();
} else if (privateKeyRaw) {
  keyFileContent = privateKeyRaw.trim();
  if (fs.existsSync(path.join(ROOT_DIR, 'tauri-key.key'))) {
    keyFilePath = path.join(ROOT_DIR, 'tauri-key.key');
  }
} else if (fs.existsSync(path.join(ROOT_DIR, 'tauri-key.key'))) {
  keyFilePath = path.join(ROOT_DIR, 'tauri-key.key');
  keyFileContent = fs.readFileSync(keyFilePath, 'utf8').trim();
}

// Injeta as variáveis esperadas pelo Tauri CLI no ambiente de execução
if (keyFileContent) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = keyFileContent;
  process.env.TAURI_PRIVATE_KEY = keyFileContent;
}
if (keyFilePath) {
  process.env.TAURI_SIGNING_PRIVATE_KEY_PATH = keyFilePath;
}
if (privateKeyPassword) {
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = privateKeyPassword;
  process.env.TAURI_KEY_PASSWORD = privateKeyPassword;
}

// ---------------------------------------------------------------------------
// 2. Leitura da versão a partir de `src-tauri/tauri.conf.json`
// ---------------------------------------------------------------------------
if (!fs.existsSync(TAURI_CONF_PATH)) {
  console.error(`❌ Erro: Arquivo ${TAURI_CONF_PATH} não encontrado!`);
  process.exit(1);
}

const tauriConf = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, 'utf8'));
const version = tauriConf.version || '1.0.0';
const productName = tauriConf.productName || 'Worship Tools';
const tagName = `v${version}`;

// Argumentos CLI
const args = process.argv.slice(2);
let customNotes = `Worship Tools ${tagName}

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
let isDryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--notes' && args[i + 1]) {
    customNotes = args[i + 1];
    i++;
  } else if (args[i] === '--dry-run') {
    isDryRun = true;
  }
}

console.log(`📦 Aplicativo: ${productName}`);
console.log(`🏷️  Versão Alvo: ${version} (${tagName})`);
console.log(`🔑 Chave Privada detectada: ${keyFilePath ? path.basename(keyFilePath) : keyFileContent ? 'Sim (em texto)' : 'Não configurada'}`);
console.log(`🔒 Senha da Chave configurada: ${privateKeyPassword ? 'Sim (oculta)' : 'Não (vazia)'}`);
if (isDryRun) {
  console.log('🧪 Modo DRY-RUN ativado (não fará upload no GitHub).');
}
console.log('--------------------------------------------------------\n');

// ---------------------------------------------------------------------------
// 3. Execução do Build Tauri
// ---------------------------------------------------------------------------
console.log(`⚙️  [1/4] Compilando e gerando bundle NSIS nativo (npm run build:exe)...`);

try {
  // Executa o build NSIS com as variáveis do ambiente herdadas
  execSync('node run-tauri.cjs build --bundles nsis', {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  console.log('\n✅ Build Tauri NSIS concluído com sucesso!');
} catch {
  // Se o build falhar, verificamos se o executável foi gerado mesmo assim
  // (caso o erro tenha sido apenas a tentativa interativa de senha do minisign)
  const files = fs.existsSync(NSIS_DIR) ? fs.readdirSync(NSIS_DIR) : [];
  const exeExists = files.some((f) => f.endsWith('.exe') && !f.endsWith('.sig') && f.includes(version));

  if (!exeExists) {
    console.error('\n❌ Erro fatal: O build do aplicativo falhou!');
    process.exit(1);
  } else {
    console.warn('\n⚠️  O instalador foi compilado, mas a assinatura embutida solicitou intervenção. Assinando via CLI separadamente...');
  }
}

// ---------------------------------------------------------------------------
// 4. Assinatura Digital Automatizada (Garantia do arquivo .sig)
// ---------------------------------------------------------------------------
console.log(`\n🔏 [2/4] Verificando e assinando os instaladores gerados...`);

if (!fs.existsSync(NSIS_DIR)) {
  console.error(`❌ Pasta de saída não encontrada: ${NSIS_DIR}`);
  process.exit(1);
}

// Encontra o instalador mais recente gerado pelo Tauri (prioriza arquivos com espaço antes de sanitizados)
const allExes = fs.readdirSync(NSIS_DIR)
  .filter((f) => f.endsWith('.exe') && !f.endsWith('.sig'))
  .map((f) => ({
    name: f,
    path: path.join(NSIS_DIR, f),
    mtime: fs.statSync(path.join(NSIS_DIR, f)).mtimeMs,
  }))
  .sort((a, b) => {
    // Dá preferência aos gerados diretamente pelo Tauri (que contêm espaços no nome)
    const aHasSpace = a.name.includes(' ');
    const bHasSpace = b.name.includes(' ');
    if (aHasSpace && !bHasSpace) return -1;
    if (!aHasSpace && bHasSpace) return 1;
    return b.mtime - a.mtime;
  });

const matchedExe = allExes.find((f) => f.name.includes(version)) || allExes[0];

if (!matchedExe) {
  console.error(`❌ Nenhum arquivo .exe encontrado em ${NSIS_DIR}!`);
  process.exit(1);
}

const exeFile = matchedExe.name;
const fullExePath = matchedExe.path;
let fullSigPath = `${fullExePath}.sig`;

// Se o .sig não existe ou se temos a chave e senha configuradas, assina explicitamente
if (!fs.existsSync(fullSigPath) || (keyFilePath && privateKeyPassword)) {
  console.log(`✍️  Assinando arquivo: "${fullExePath}"...`);
  if (!keyFilePath && !keyFileContent) {
    console.error('❌ Não foi possível assinar: Nenhuma chave privada configurada em TAURI_PRIVATE_KEY ou tauri-key.key!');
    process.exit(1);
  }

  // Garante que todos os caminhos e argumentos fiquem rigidamente entre aspas duplas
  const quotedExePath = `"${fullExePath}"`;
  const quotedKeyPath = keyFilePath ? `"${keyFilePath}"` : '';
  const quotedPassword = privateKeyPassword ? `"${privateKeyPassword}"` : '';

  const signParts = [
    'npx tauri signer sign',
    `--app-version "${version}"`,
  ];

  // Prepara o ambiente do processo filho eliminando conflito entre -f (--private-key-path)
  // e a variável de ambiente TAURI_SIGNING_PRIVATE_KEY (--private-key)
  const signEnv = { ...process.env };

  if (quotedKeyPath) {
    delete signEnv.TAURI_SIGNING_PRIVATE_KEY;
    delete signEnv.TAURI_PRIVATE_KEY;
    delete signEnv.TAURI_KEY;
    signParts.push(`-f ${quotedKeyPath}`);
  } else if (keyFileContent) {
    delete signEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
    signParts.push(`-k "${keyFileContent}"`);
  }

  if (quotedPassword) {
    signParts.push(`-p ${quotedPassword}`);
  }

  signParts.push(quotedExePath);

  const signCmd = signParts.join(' ');
  const maskedCmd = quotedPassword ? signCmd.replace(/-p ".*?"/, '-p "***"') : signCmd;
  console.log(`> ${maskedCmd}`);

  try {
    execSync(signCmd, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: signEnv,
    });
  } catch (err) {
    console.error(`\n❌ Falha ao assinar digitalmente o instalador!`);
    console.error(`👉 Verifique se o caminho do arquivo e a senha em TAURI_KEY_PASSWORD no .env estão corretos.`);
    process.exit(1);
  }
}

// Cria cópia com pontos no nome (Worship.Tools_...) para compatibilidade com GitHub Releases
// Sempre sobrescreve para garantir que o binário mais recente com as novas imagens seja enviado
const sanitizedExeName = exeFile.replace(/\s+/g, '.');
const sanitizedExePath = path.join(NSIS_DIR, sanitizedExeName);
if (sanitizedExeName !== exeFile) {
  fs.copyFileSync(fullExePath, sanitizedExePath);
}

// Garante também a cópia do .sig correspondente sempre atualizada
const sanitizedSigPath = `${sanitizedExePath}.sig`;
if (fs.existsSync(fullSigPath)) {
  fs.copyFileSync(fullSigPath, sanitizedSigPath);
}

console.log(`✅ Instalador e assinatura validados:`);
console.log(`   📁 "${fullExePath}" -> "${sanitizedExePath}"`);
console.log(`   📄 "${fullSigPath}" -> "${sanitizedSigPath}"`);

// ---------------------------------------------------------------------------
// 5. Geração do latest.json
// ---------------------------------------------------------------------------
console.log(`\n📄 [3/4] Gerando manifesto latest.json...`);

const genUpdateScript = path.join(ROOT_DIR, 'generate-update-json.mjs');
if (fs.existsSync(genUpdateScript)) {
  execSync(`node "${genUpdateScript}" --version "${version}" --notes "${customNotes.replace(/"/g, '\\"')}"`, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
} else {
  console.error(`❌ Script ${genUpdateScript} não encontrado!`);
  process.exit(1);
}

const latestJsonPath = path.join(ROOT_DIR, 'latest.json');
if (!fs.existsSync(latestJsonPath)) {
  console.error(`❌ Falha: latest.json não foi gerado em ${latestJsonPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 6. Copiar artefatos de update para o site web (Cube Hosting)
// ---------------------------------------------------------------------------
console.log(`\n📦 [4/5] Copiando artefatos para o site web (Cube Hosting)...`);
const webUpdatesDir = path.join(ROOT_DIR, '..', 'SiteWorshipTools', 'updates');
try {
  if (!fs.existsSync(webUpdatesDir)) {
    fs.mkdirSync(webUpdatesDir, { recursive: true });
    console.log(`   📁 Criado: ${webUpdatesDir}`);
  }
  // Copia .exe, .sig e latest.json
  const webExePath = path.join(webUpdatesDir, path.basename(sanitizedExePath));
  const webSigPath = path.join(webUpdatesDir, path.basename(sanitizedSigPath));
  const webLatestPath = path.join(webUpdatesDir, 'latest.json');
  
  fs.copyFileSync(sanitizedExePath, webExePath);
  fs.copyFileSync(sanitizedSigPath, webSigPath);
  fs.copyFileSync(latestJsonPath, webLatestPath);
  
  console.log(`   ✅ Copiado: ${path.basename(sanitizedExePath)}`);
  console.log(`   ✅ Copiado: ${path.basename(sanitizedSigPath)}`);
  console.log(`   ✅ Copiado: latest.json`);
  console.log(`   📍 Destino: ${webUpdatesDir}`);
} catch (err) {
  console.error(`\n❌ Falha ao copiar para site web:`, err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 7. Publicação no GitHub Releases via GitHub CLI (gh) — OPCIONAL (backup/histórico)
// O app baixa atualizações do Cube Hosting: https://worshiptools-28vv4k.cubehost.dev/updates/latest.json
// ---------------------------------------------------------------------------
console.log(`\n🚀 [5/5] Publicando Release no GitHub (opcional - backup/histórico)...`);

if (isDryRun) {
  console.log('🧪 Modo DRY-RUN ativado. Operação concluída sem publicação no GitHub.');
  process.exit(0);
}

// Verifica se `gh` está instalado
let ghInstalled = false;
try {
  const ghVer = execSync('gh --version', { stdio: 'pipe' }).toString();
  ghInstalled = true;
  console.log(`🐙 GitHub CLI detectado: ${ghVer.split('\n')[0].trim()}`);
} catch {
  ghInstalled = false;
}

if (!ghInstalled) {
  console.warn('\n⚠️  O utilitário GitHub CLI (`gh`) não está instalado no sistema.');
  console.warn('👉 Para automatizar o upload, instale o `gh`:');
  console.warn('   Windows: winget install --id GitHub.cli');
  console.warn('   macOS:   brew install gh');
  console.warn('\n📋 Arquivos gerados prontos para upload manual no GitHub:');
  console.warn(`   1. ${sanitizedExePath}`);
  console.warn(`   2. ${fullSigPath}`);
  console.warn(`   3. ${latestJsonPath}`);
  console.warn(`\n🔗 Link: https://github.com/skylineinfogamer/multitracks-stage-software/releases/new?tag=${tagName}`);
  process.exit(0);
}

// Verifica se `gh` está autenticado
try {
  execSync('gh auth status', { stdio: 'pipe' });
  console.log('🔑 GitHub CLI autenticado com sucesso.');
} catch {
  console.warn('\n⚠️  O GitHub CLI não está autenticado nesta máquina!');
  console.warn('👉 Execute o comando abaixo no terminal para fazer login:');
  console.warn('   gh auth login');
  console.warn('\n📋 Os arquivos da versão ' + tagName + ' estão prontos localmente.');
  process.exit(0);
}

// Prepara arquivos (assets) para upload
const assetsToUpload = [
  sanitizedExePath,
  sanitizedSigPath,
  latestJsonPath,
];

console.log(`\n📤 Criando release "${tagName}" e fazendo upload dos assets...`);
console.log(`   Assets: ${assetsToUpload.map((a) => path.basename(a)).join(', ')}`);

try {
  // Tenta criar a release. Se a tag/release já existir, faz upload com --clobber
  const ghCmd = `gh release create ${tagName} ${assetsToUpload.map((a) => `"${a}"`).join(' ')} --title "${productName} ${tagName}" --notes "${customNotes.replace(/"/g, '\\"')}"`;
  execSync(ghCmd, { cwd: ROOT_DIR, stdio: 'inherit' });
  console.log(`\n🎉 Release ${tagName} criada e publicada com sucesso no GitHub!`);
} catch {
  console.log(`\n⚠️  A release ${tagName} já existe. Atualizando assets E notas...`);
  try {
    // 1. Atualiza assets
    const uploadCmd = `gh release upload ${tagName} ${assetsToUpload.map((a) => `"${a}"`).join(' ')} --clobber`;
    execSync(uploadCmd, { cwd: ROOT_DIR, stdio: 'inherit' });
    // 2. Atualiza notas/body da release
    const editCmd = `gh release edit ${tagName} --notes "${customNotes.replace(/"/g, '\\"')}"`;
    execSync(editCmd, { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log(`\n🎉 Release ${tagName} atualizada (assets + notas) com sucesso no GitHub!`);
  } catch (err) {
    console.error(`\n❌ Falha ao publicar/atualizar release via GitHub CLI:`, err.message);
    process.exit(1);
  }
}

console.log('\n========================================================');
console.log(`✅ PROCESSO DE RELEASE FINALIZADO COM SUCESSO!`);
console.log(`🔗 Verifique em: https://github.com/skylineinfogamer/multitracks-stage-software/releases/tag/${tagName}`);
console.log('========================================================\n');
