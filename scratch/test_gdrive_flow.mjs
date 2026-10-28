import { execSync } from 'child_process';
import fs from 'fs';

console.log('Testing curl Google Drive download logic...');
// Verify curl exists and can execute
try {
  const version = execSync('curl.exe --version').toString().split('\n')[0];
  console.log('Curl version:', version);
} catch (e) {
  console.error('Curl error:', e.message);
}
