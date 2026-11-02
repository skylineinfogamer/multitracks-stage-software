const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cli = require('@tauri-apps/cli/main');

// Carrega automaticamente variáveis do .env para garantir chaves de assinatura do auto-updater
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
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

// Garante sinônimos aceitos pelo Tauri CLI v2
if (process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_PRIVATE_KEY) {
  process.env.TAURI_PRIVATE_KEY = process.env.TAURI_SIGNING_PRIVATE_KEY;
}
if (process.env.TAURI_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = process.env.TAURI_PRIVATE_KEY;
}
if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD && !process.env.TAURI_KEY_PASSWORD) {
  process.env.TAURI_KEY_PASSWORD = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
}
if (process.env.TAURI_KEY_PASSWORD && !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = process.env.TAURI_KEY_PASSWORD;
}

const args = process.argv.slice(2);
if (args.includes('-f') || args.includes('--private-key-path')) {
  delete process.env.TAURI_SIGNING_PRIVATE_KEY;
  delete process.env.TAURI_PRIVATE_KEY;
}
if (args[0] === 'dev') {
  try {
    execSync('taskkill /F /IM tauri-app.exe', { stdio: 'ignore' });
  } catch {
    // No previous instance running
  }
  if (!args.includes('--no-dev-server')) args.push('--no-dev-server');
  if (!args.includes('--no-watch')) args.push('--no-watch');
}

cli.run(args, 'npm run tauri').catch((err) => {
  cli.logError(err.message);
  process.exit(1);
});
