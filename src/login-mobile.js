import { readFile } from 'node:fs/promises';
import { browserChannel, ensurePrivateDataDir, loadPlaywright, mobileProfilePath, sessionPath } from './browser.js';
import { exchangeMobileCode, mobileConfig } from './mobile-auth.js';
import { captureMobileRedirect, mobileCallbackCode, newOauthAttempt } from './oauth.js';

process.umask(0o077);

async function loginMobile() {
  await ensurePrivateDataDir();
  const config = await mobileConfig();
  let { authorize, state, verifier } = newOauthAttempt(config);
  const debug = process.env.VIGILO_AUTH_DEBUG === '1';

  const { chromium } = loadPlaywright();
  const context = await chromium.launchPersistentContext(mobileProfilePath, {
    channel: browserChannel, headless: false, acceptDownloads: false,
    chromiumSandbox: true, viewport: { width: 1280, height: 960 },
  });
  let timer;
  try {
    const existingCookies = await context.cookies('https://auth.prod.vigilo-oas.no');
    let cookies = [];
    try {
      const previous = JSON.parse(await readFile(sessionPath, 'utf8'));
      if (Array.isArray(previous.authCookies)) {
        cookies = previous.authCookies.filter((cookie) =>
          (cookie.domain === 'auth.prod.vigilo-oas.no' || cookie.domain === '.auth.prod.vigilo-oas.no') &&
          (cookie.expires === -1 || cookie.expires * 1000 > Date.now()) &&
          !existingCookies.some((current) => current.name === cookie.name && current.path === cookie.path));
      }
    } catch {}
    if (cookies.length > 0) await context.addCookies(cookies);
    let resolveCallback;
    let rejectCallback;
    const waitForCallback = () => new Promise((resolve, reject) => {
      clearTimeout(timer);
      resolveCallback = resolve;
      rejectCallback = reject;
      timer = setTimeout(() => reject(new Error('Innloggingen tok mer enn ti minutter. Kjør npm run login på nytt.')), 600_000);
    });
    let callback = waitForCallback();
    const capture = (url) => {
      try {
        const code = mobileCallbackCode(url, config.redirectUri, state);
        if (code) resolveCallback(code);
      } catch (error) { rejectCallback(error); }
    };
    context.on('request', (request) => {
      capture(request.url());
      if (debug && request.isNavigationRequest()) {
        const url = new URL(request.url());
        console.log(`Innlogging: ${url.hostname}${url.origin === authorize.origin ? url.pathname : ''}`);
      }
    });
    context.on('response', (response) => {
      if (debug && response.status() >= 400) {
        console.log(`Innlogging: HTTP ${response.status()} fra ${new URL(response.url()).hostname}`);
      }
      if (response.status() < 300 || response.status() >= 400) return;
      response.headerValue('location').then((location) => {
        if (location) capture(new URL(location, response.url()).href);
      }).catch(() => {});
    });
    await context.route('https://auth.prod.vigilo-oas.no/**', async (route) => {
      try {
        const code = await captureMobileRedirect(route, config.redirectUri, state, context.request);
        if (code) resolveCallback(code);
      } catch {
        rejectCallback(new Error('Vigilo-innloggingen kunne ikke fullføres. Prøv igjen.'));
        await route.fulfill({ status: 502, contentType: 'text/plain; charset=utf-8',
          body: 'Vigilo-innloggingen kunne ikke fullføres. Prøv igjen.' }).catch(() => {});
      }
    });
    const page = context.pages()[0] || await context.newPage();
    console.log('Fullfør Vigilo-innloggingen via ID-porten i Chrome. Vinduet lukkes automatisk.');
    for (;;) {
      page.goto(authorize.href, { timeout: 0 }).catch(() => {});
      const code = await callback;
      clearTimeout(timer);
      console.log('Vigilo-returen er mottatt. Henter og lagrer fornybar økt.');
      try {
        await exchangeMobileCode(code, verifier);
        break;
      } catch (error) {
        if (!verifier || error.oauthError !== 'invalid_grant') throw error;
        console.log('Vigilo avviste PKCE. Prøver den eldre appflyten med samme innlogging.');
        ({ authorize, state, verifier } = newOauthAttempt(config, { usePkce: false }));
        callback = waitForCallback();
      }
    }
    console.log('Vigilo-økten med automatisk fornyelse er lagret lokalt.');
  } finally {
    clearTimeout(timer);
    await context.close();
  }
}

loginMobile().catch((error) => {
  console.error(error.message || 'Innloggingen feilet.');
  process.exitCode = 1;
});
