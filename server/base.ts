// CODINGER_BASE: the path a proxy serves Codinger under, when it passes that path on unchanged
// (e.g. /desk/ada, for several desks on one site). Unset, Codinger is at the root, as before.

export function parseBase(raw: string | undefined): string {
  const base = (raw ?? '').trim().replace(/\/+$/, '')
  if (base && !/^(\/[\w.~-]+)+$/.test(base)) throw new Error(`CODINGER_BASE should look like /desk/ada, not "${raw}"`)
  return base
}

// A request's path and query with the base taken off. One without it stays as it is: Claude
// calls /mcp/<token> on 127.0.0.1 straight, and the hub passes a machine's page through at the root.
export const underBase = (base: string, url: string): string =>
  base && (url === base || url.startsWith(base + '/') || url.startsWith(base + '?')) ? url.slice(base.length).replace(/^(?!\/)/, '/') : url

// The page, for a browser that sees this machine's files under base: /m/<name> through the hub
// (own false), or CODINGER_BASE (own true), where this server is also the page's own server
// (window.__root, web/src/store.ts) and the page's links to it go under the base too.
export function pageUnder(html: string, base: string, own: boolean): string {
  if (!base) return html
  const script = `window.__base=${JSON.stringify(base + '/')}${own ? `;window.__root=${JSON.stringify(base)}` : ''}`
  html = html.replaceAll('"/assets/', `"${base}/assets/`).replace('<head>', `<head><script>${script}</script>`)
  return own ? html.replaceAll('href="/agent/', `href="${base}/agent/`).replaceAll('href="/manifest.webmanifest"', `href="${base}/manifest.webmanifest"`) : html
}
