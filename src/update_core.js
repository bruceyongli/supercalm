// Pure helpers for the upstream update check (src/update_check.js) — kept dependency-free so the test
// suite can exercise version comparison + payload parsing without booting the server.

// Numeric semver compare (string compare breaks at 0.1.9 vs 0.1.10): 1 if a>b, -1 if a<b, 0 if equal.
export function cmpVersion(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Normalize a GitHub "latest release" body (or a raw package.json fallback) into {version, url, name}.
export function parseLatest(kind, body, repo) {
  try {
    if (kind === 'release' && body?.tag_name) {
      return {
        version: String(body.tag_name).replace(/^v/, ''),
        url: body.html_url || `https://github.com/${repo}/releases`,
        name: String(body.name || '').slice(0, 120),
      };
    }
    if (kind === 'package' && body?.version) {
      return { version: String(body.version), url: `https://github.com/${repo}/releases`, name: '' };
    }
  } catch { /* malformed -> no update info */ }
  return null;
}
