import { createWriteStream } from 'fs';
import { mkdirSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const distDir = resolve('dist');
const outputDir = resolve('deploy');
const version = JSON.parse(readFileSync('package.json', 'utf-8')).version;
const zipName = `deploy-pronto-v${version}.zip`;
const outputPath = join(outputDir, zipName);

async function createDeployZip() {
  console.log('📦 Criando deploy-pronto.zip...');
  
  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });
  
  // Verify dist directory exists
  try {
    statSync(distDir);
  } catch {
    console.error('❌ Pasta dist/ não encontrada. Execute "npm run build" primeiro.');
    process.exit(1);
  }
  
  const { ZipArchive } = await import('archiver');
  
  // Create zip
  const output = createWriteStream(outputPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  
  output.on('close', () => {
    const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
    console.log(`✅ Deploy pronto: ${outputPath} (${sizeMB} MB)`);
    console.log(`📤 Faça upload deste arquivo no Cube Hosting`);
  });
  
  archive.on('error', (err) => {
    console.error('❌ Erro ao criar zip:', err);
    process.exit(1);
  });
  
  archive.pipe(output);
  
  // Add all files from dist directory
  function addFiles(dir, prefix = '') {
    const items = readdirSync(dir);
    for (const item of items) {
      const fullPath = join(dir, item);
      const archivePath = join(prefix, item);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        addFiles(fullPath, archivePath);
      } else {
        archive.file(fullPath, { name: archivePath });
      }
    }
  }
  
  addFiles(distDir);
  
  // Also include a version.txt for reference
  archive.append(`Worship Tools Web - v${version}\nBuild: ${new Date().toISOString()}\nBase: Tauri App Frontend`, { name: 'version.txt' });
  
  archive.finalize();
}

createDeployZip();