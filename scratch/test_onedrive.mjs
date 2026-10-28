const raw = "https://1drv.ms/u/s!Ap...";
const b64 = Buffer.from(raw).toString('base64').replace(/\//g, '_').replace(/\+/g, '-').replace(/=+$/, '');
const shareId = 'u!' + b64;
console.log('ShareId:', shareId);
console.log('Endpoint:', `https://api.onedrive.com/v1.0/shares/${shareId}/root/content`);
