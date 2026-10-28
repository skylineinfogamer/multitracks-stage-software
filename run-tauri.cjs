const { execSync } = require('child_process');
const cli = require('@tauri-apps/cli/main');

const args = process.argv.slice(2);
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
