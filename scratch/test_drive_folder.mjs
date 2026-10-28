import { execSync } from 'child_process';

const testFolder = '12345'; // dummy or any
try {
  const html = execSync(`curl.exe -s -L -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" "https://drive.google.com/drive/folders/0B12345"`).toString();
  console.log('HTML length:', html.length);
  const matches = [...html.matchAll(/\["([a-zA-Z0-9_-]{20,})","([^"]+\.(?:wav|mp3|m4a|zip|ogg))"/gi)];
  console.log('Matches:', matches.length);
} catch (e) {
  console.error(e.message);
}
