import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

const cookieFile = path.join(os.tmpdir(), 'test_gdrive_cookies.txt');
console.log('Testing Google Drive cookie jar with curl...');

// Test fetching drive.google.com with cookies
try {
  const out = execSync(`curl.exe -s -L -c "${cookieFile}" -b "${cookieFile}" --max-time 10 "https://drive.google.com"`);
  console.log('Curl output bytes:', out.length);
  console.log('Success!');
} catch (e) {
  console.error('Error:', e.message);
}
