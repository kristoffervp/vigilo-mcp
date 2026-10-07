import { browserChannel, ensurePrivateDataDir, loadPlaywright, portalOrigin, profilePath, savePrivateJson, sessionPath, tokenExpiry } from './browser.js';

process.umask(0o077);

async function login() {
  await ensurePrivateDataDir();
  const { chromium } = loadPlaywright();
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: browserChannel, headless: false, acceptDownloads: false,
    chromiumSandbox: true, viewport: { width: 1280, height: 960 },
  });
  let resolveLogin;
  const loggedIn = new Promise((resolve) => { resolveLogin = resolve; });
  const collect = async (response) => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== portalOrigin || !url.pathname.startsWith('/api/')) return;
    if (response.status() < 200 || response.status() >= 300) return;
    const headers = await response.request().allHeaders();
    const match = /^Bearer\s+(.+)$/i.exec(headers.authorization || '');
    if (!match) return;
    const page = response.request().frame().page();
    const browserStorage = await page.evaluate(() => Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, i) => {
        const key = sessionStorage.key(i);
        return key?.startsWith('oidc.user:') ? [key, sessionStorage.getItem(key)] : null;
      }).filter(Boolean),
    ));
    resolveLogin({
      accessToken: match[1],
      expiresAt: tokenExpiry(match[1]),
      capturedAt: Date.now(),
      browserStorage,
    });
  };
  context.on('response', (response) => { collect(response).catch(() => {}); });
  try {
    const page = context.pages()[0] || await context.newPage();
    console.log('Fullfør Vigilo-innloggingen via ID-porten i Chrome. Velg tilhørighet og åpne Foreldreportal.');
    console.log('Vinduet lukkes automatisk når nettportalen er klar.');
    page.goto(`${portalOrigin}/login?redirect=%2F`, { timeout: 0 }).catch(() => {});
    let timeoutId;
    const timer = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Innloggingen tok mer enn ti minutter. Kjør npm run login på nytt.')), 600_000);
    });
    const session = await Promise.race([loggedIn, timer]);
    clearTimeout(timeoutId);
    session.authCookies = (await context.cookies()).filter((cookie) =>
      cookie.domain === 'auth.prod.vigilo-oas.no' || cookie.domain === '.auth.prod.vigilo-oas.no');
    await savePrivateJson(sessionPath, session);
    console.log('Vigilo-økten er lagret lokalt. Du kan lukke dette terminalvinduet.');
  } finally {
    await context.close();
  }
}

login().catch((error) => {
  console.error(error.message || 'Innloggingen feilet.');
  process.exitCode = 1;
});
