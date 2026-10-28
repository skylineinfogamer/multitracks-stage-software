import fs from 'fs';
import path from 'path';

const REPO_OWNER = 'skylineinfogamer';
const REPO_NAME = 'multitracks-stage-software';

function findFile(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const f of files) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      const res = findFile(full, ext);
      if (res) return res;
    } else if (f.name.endsWith(ext)) {
      return full;
    }
  }
  return null;
}

async function main() {
  console.log('🚀 Gerando latest.json para o Tauri v2 Updater...');

  // 1. Ler versão do tauri.conf.json
  const confPath = path.resolve('src-tauri/tauri.conf.json');
  if (!fs.existsSync(confPath)) {
    console.error('❌ Arquivo tauri.conf.json não encontrado!');
    process.exit(1);
  }

  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  const version = conf.version || '1.0.0';
  console.log(`📦 Versão detectada: v${version}`);

  // 2. Procurar arquivo de assinatura .sig no bundle
  const bundleDir = path.resolve('src-tauri/target/release/bundle');
  const sigFile = findFile(bundleDir, '.sig');

  let signature = '';
  let zipName = '';

  if (sigFile && fs.existsSync(sigFile)) {
    signature = fs.readFileSync(sigFile, 'utf8').trim();
    zipName = path.basename(sigFile).replace(/\.sig$/, '');
    console.log(`🔑 Assinatura digital encontrada em: ${path.basename(sigFile)}`);
  } else {
    console.warn('⚠️ Nenhum arquivo .sig encontrado no diretório de build.');
    console.warn('   Dica: Certifique-se de ter executado `npm run tauri build` com a variável TAURI_SIGNING_PRIVATE_KEY configurada.');
    signature = 'COLE_AQUI_A_SIGNATURE_SE_GEROU_MANUALMENTE';
    zipName = `Worship.Tools_${version}_x64-setup.nsis.zip`;
  }

  // 3. Notas de release (pode ser passado como argumento: node scripts/generate-latest-json.mjs "Notas aqui")
  const notes = process.argv[2] || `Worship Tools v${version} - Atualizações e correções de estabilidade.`;

  // 4. Montar a estrutura oficial do latest.json do Tauri v2
  const latestJson = {
    version: version,
    notes: notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: signature,
        url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}/${zipName}`,
      },
    },
  };

  const outputPath = path.resolve('latest.json');
  fs.writeFileSync(outputPath, JSON.stringify(latestJson, null, 2), 'utf8');

  console.log(`\n✅ Arquivo [latest.json] gerado com sucesso em: ${outputPath}`);
  console.log('--------------------------------------------------');
  console.log(JSON.stringify(latestJson, null, 2));
  console.log('--------------------------------------------------');
  console.log('\n📌 Próximos passos para publicar a atualização no GitHub:');
  console.log(`1. Crie uma nova Release no GitHub com a tag "v${version}".`);
  console.log(`2. Anexe o instalador/arquivo zip: ${zipName}`);
  console.log(`3. Anexe o arquivo: latest.json`);
  console.log('4. Publique a release! O aplicativo detectará e atualizará automaticamente.');
}

main().catch(console.error);
