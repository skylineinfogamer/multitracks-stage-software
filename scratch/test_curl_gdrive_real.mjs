import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

// Test what curl does with Google Drive links
const testUrl = "https://drive.google.com/uc?export=download&id=dummy";
const cookieFile = path.join(os.tmpdir(), "wpp_curl_test.txt");
try {
  const cmd = `curl.exe -4 -s -L -c "${cookieFile}" -b "${cookieFile}" --max-time 10 "${testUrl}"`;
  const out = execSync(cmd);
  console.log("Length:", out.length);
  console.log("First 100 bytes:", out.slice(0, 100).toString());
} catch (e) {
  console.log("Exit error:", e.message);
}
