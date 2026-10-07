import { readFile } from 'node:fs/promises';
import { browserChannel, loadPlaywright, portalOrigin, profilePath, savePrivateJson, sessionPath, tokenExpiry } from './browser.js';
import { currentMobileSession, readMobileSession } from './mobile-auth.js';

let renewal;

async function loadSavedSession() {
  try { return JSON.parse(await readFile(sessionPath, 'utf8')); }
  catch { throw new Error('Ingen lokal Vigilo-økt. Kjør npm run login først.'); }
}

async function renewWithBrowser(previous) {
  if (!previous.browserStorage || Object.keys(previous.browserStorage).length === 0) {
    throw new Error('Vigilo-økten kan ikke fornyes automatisk. Kjør npm run login på nytt.');
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
    const collect = async (response) => {
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (url.origin !== portalOrigin || !url.pathname.startsWith('/api/') || response.status() < 200 || response.status() >= 300) return;
      const headers = await response.request().allHeaders();
      const match = /^Bearer\s+(.+)$/i.exec(headers.authorization || '');
      if (!match || (tokenExpiry(match[1]) || 0) <= Date.now() + 60_000) return;
      const page = response.request().frame().page();
      const browserStorage = await page.evaluate(() => Object.fromEntries(
        Array.from({ length: sessionStorage.length }, (_, i) => {
          const key = sessionStorage.key(i);
          return key?.startsWith('oidc.user:') ? [key, sessionStorage.getItem(key)] : null;
        }).filter(Boolean),
      ));
      resolveToken({ accessToken: match[1], expiresAt: tokenExpiry(match[1]), capturedAt: Date.now(), browserStorage });
    };
    context.on('response', (response) => { collect(response).catch(() => {}); });
    const page = context.pages()[0] || await context.newPage();
    page.goto(`${portalOrigin}/`, { timeout: 0 }).catch(() => {});
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Vigilo-økten må fornyes i Chrome. Kjør npm run login på nytt.')), 60_000);
    });
    const current = await Promise.race([found, timeout]);
    current.authCookies = (await context.cookies()).filter((cookie) =>
      cookie.domain === 'auth.prod.vigilo-oas.no' || cookie.domain === '.auth.prod.vigilo-oas.no');
    await savePrivateJson(sessionPath, current);
    return current;
  } finally {
    clearTimeout(timeoutId);
    await context.close();
  }
}

export async function currentSession() {
  try {
    await readMobileSession();
    return currentMobileSession();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const saved = await loadSavedSession();
  if (saved.accessToken && saved.expiresAt > Date.now() + 60_000) return saved;
  if (!renewal) renewal = renewWithBrowser(saved).finally(() => { renewal = undefined; });
  return renewal;
}
