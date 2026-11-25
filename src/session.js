import { readFile } from 'node:fs/promises';
import { PublicError, authCookies, bearerSession, browserChannel, loadPlaywright, portalOrigin, profilePath, savePrivateJson, sessionPath } from './browser.js';
import { currentMobileSession, readMobileSession, withSessionLock } from './mobile-auth.js';

let renewal;

async function loadSavedSession() {
  try { return JSON.parse(await readFile(sessionPath, 'utf8')); }
  catch { throw new PublicError('Ingen lokal Vigilo-økt. Kjør npm run login:browser først.'); }
}

async function renewWithBrowser(previous) {
  if (!previous.browserStorage || Object.keys(previous.browserStorage).length === 0) {
    throw new PublicError('Vigilo-økten kan ikke fornyes automatisk. Kjør npm run login:browser på nytt.');
  }
  const { chromium } = loadPlaywright();
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: browserChannel, headless: true, acceptDownloads: false, chromiumSandbox: true,
  });
  let timeoutId;
  try {
    if (Array.isArray(previous.authCookies) && previous.authCookies.length > 0) {
      await context.addCookies(previous.authCookies);
    }
    await context.addInitScript(({ origin, values }) => {
      if (location.origin === origin) {
        for (const [key, value] of Object.entries(values)) {
          if (key.startsWith('oidc.user:')) sessionStorage.setItem(key, value);
        }
      }
    }, { origin: portalOrigin, values: previous.browserStorage });
    let resolveToken;
    const found = new Promise((resolve) => { resolveToken = resolve; });
    context.on('response', (response) => { bearerSession(response).then((found) => found && resolveToken(found), () => {}); });
    const page = context.pages()[0] || await context.newPage();
    page.goto(`${portalOrigin}/`, { timeout: 0 }).catch(() => {});
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new PublicError('Vigilo-økten må fornyes i Chrome. Kjør npm run login:browser på nytt.')), 60_000);
    });
    const current = await Promise.race([found, timeout]);
    current.authCookies = authCookies(await context.cookies());
    await savePrivateJson(sessionPath, current);
    return current;
  } finally {
    clearTimeout(timeoutId);
    await context.close();
  }
}

// Two processes (Claude Desktop and the dashboard on one computer) can need a renewal at once, and a second
// Chrome cannot open the same profile, so renewal runs under a lock and reuses what the first one saved.
function renewLocked() {
  return withSessionLock(`${sessionPath}.lock`, async () => {
    const saved = await loadSavedSession();
    if (saved.accessToken && saved.expiresAt > Date.now() + 60_000) return saved;
    return renewWithBrowser(saved);
  });
}

export async function currentSession() {
  let mobile;
  try { mobile = await readMobileSession(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (mobile) return currentMobileSession(mobile);
  const saved = await loadSavedSession();
  if (saved.accessToken && saved.expiresAt > Date.now() + 60_000) return saved;
  if (!renewal) renewal = renewLocked().finally(() => { renewal = undefined; });
  return renewal;
}
