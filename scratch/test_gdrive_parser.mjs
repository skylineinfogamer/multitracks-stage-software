// Test function that inspects HTML and extracts the actual Google Drive download URL
export function extractGoogleDriveDownloadForm(html) {
  // Check if it is the HTML virus confirmation page
  if (!html.includes('download-form') && !html.includes('confirm=') && !html.includes('drive.usercontent.google.com')) {
    return null;
  }

  // 1. Check for form action
  const actionMatch = html.match(/<form[^>]+id=["']download-form["'][^>]+action=["']([^"']+)["']/i) ||
                      html.match(/<form[^>]+action=["']([^"']+)["'][^>]+id=["']download-form["']/i);
  const action = actionMatch ? actionMatch[1].replace(/&amp;/g, '&') : 'https://drive.usercontent.google.com/download';

  // 2. Extract all input fields
  const inputs = [...html.matchAll(/<input[^>]+type=["']hidden["'][^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["']/gi)];
  if (inputs.length === 0) {
    // Try attribute order value before name
    const altInputs = [...html.matchAll(/<input[^>]+type=["']hidden["'][^>]+value=["']([^"']*)["'][^>]+name=["']([^"']+)["']/gi)];
    if (altInputs.length > 0) {
      const params = new URLSearchParams();
      for (const m of altInputs) params.append(m[2], m[1]);
      return `${action}?${params.toString()}`;
    }
  } else {
    const params = new URLSearchParams();
    for (const m of inputs) params.append(m[1], m[2]);
    return `${action}?${params.toString()}`;
  }

  // 3. Fallback: match confirm and uuid or id
  const confirmMatch = html.match(/name=["']confirm["'][^>]+value=["']([^"']+)["']/i) || html.match(/confirm=([a-zA-Z0-9_-]+)/i);
  const uuidMatch = html.match(/name=["']uuid["'][^>]+value=["']([^"']+)["']/i) || html.match(/uuid=([a-zA-Z0-9_-]+)/i);
  const idMatch = html.match(/name=["']id["'][^>]+value=["']([^"']+)["']/i) || html.match(/id=([a-zA-Z0-9_-]+)/i);

  if (confirmMatch && idMatch) {
    const url = new URL(action.startsWith('http') ? action : `https://drive.usercontent.google.com${action}`);
    url.searchParams.set('id', idMatch[1]);
    url.searchParams.set('export', 'download');
    url.searchParams.set('confirm', confirmMatch[1]);
    if (uuidMatch) url.searchParams.set('uuid', uuidMatch[1]);
    return url.toString();
  }

  return null;
}
