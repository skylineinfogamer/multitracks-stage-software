#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const WEBSITE_SRC = path.join(ROOT_DIR, 'website');
const OUTPUT_SITE_DIR = path.join(ROOT_DIR, 'dist-site');
const APP_DEST_DIR = path.join(OUTPUT_SITE_DIR, 'app');

console.log('\n========================================================');
console.log('🌐 Gerador do Pacote Unificado de Hospedagem Web');
console.log('   Landing Page + Portal do Cliente & Nuvem (/app)');
console.log('========================================================\n');

// 1. Compila o frontend React com caminhos relativos
console.log('📦 [1/4] Compilando o gerenciador de clientes / nuvem (Vite)...');
execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });

// 2. Limpa e recria dist-site
console.log('\n📁 [2/4] Estruturando os diretórios de publicação (dist-site)...');
if (fs.existsSync(OUTPUT_SITE_DIR)) {
  fs.rmSync(OUTPUT_SITE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(OUTPUT_SITE_DIR, { recursive: true });
fs.mkdirSync(APP_DEST_DIR, { recursive: true });

// 3. Copia o site institucional da pasta website para a raiz de dist-site
console.log('🎨 [3/4] Copiando arquivos do site institucional (Landing Page)...');
function copyDirRecursive(src, dest, ignoreList = []) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    if (ignoreList.includes(item)) continue;
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath, ignoreList);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDirRecursive(WEBSITE_SRC, OUTPUT_SITE_DIR, ['worshiptools.zip']);

// Copia o logo do app para o site se necessário
if (fs.existsSync(path.join(ROOT_DIR, 'public', 'worship-tools-logo.jpg'))) {
  fs.copyFileSync(
    path.join(ROOT_DIR, 'public', 'worship-tools-logo.jpg'),
    path.join(OUTPUT_SITE_DIR, 'worship-tools-logo.jpg')
  );
}

// 4. Copia o frontend compilado do React (dist) para a subpasta /app
console.log('🚀 [4/4] Copiando aplicação do cliente e nuvem para /app...');
copyDirRecursive(DIST_DIR, APP_DEST_DIR, ['worshiptools', 'worshiptools.zip']);

// 5. Gera um arquivo ZIP pronto para upload em cPanel / Hostinger / Apache
const zipPath = path.join(ROOT_DIR, 'worship-tools-site.zip');
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// Cria zip usando PowerShell para compatibilidade nativa no Windows sem depender de pacotes extras
console.log('\n🗜️  Compactando pacote pronto para o site: worship-tools-site.zip...');
try {
  execSync(
    `powershell -Command "Compress-Archive -Path '${OUTPUT_SITE_DIR}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' }
  );
  console.log(`✅ Arquivo ZIP gerado com sucesso: ${zipPath}`);
} catch (e) {
  console.warn('⚠️  Compress-Archive falhou, gerado apenas a pasta dist-site.');
}

console.log('\n========================================================');
console.log('🎉 PUBLICAÇÃO WEB PREPARADA COM SUCESSO!');
console.log('========================================================');
console.log('Estrutura pronta em: ' + OUTPUT_SITE_DIR);
console.log('   ├── index.html         -> Seu site / Landing Page principal');
console.log('   ├── image_1683b5.jpg   -> Preview do software');
console.log('   └── app/               -> Gerenciador de Clientes e Nuvem (React)');
console.log('       ├── index.html');
console.log('       └── assets/');
console.log('\nPara hospedar no seu servidor (cPanel, Hostinger, etc.):');
console.log('Basta enviar e extrair o arquivo: "worship-tools-site.zip" na pasta public_html do seu domínio!');
console.log('========================================================\n');
