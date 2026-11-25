import { authCookies, bearerSession, browserChannel, ensurePrivateDataDir, loadPlaywright, portalOrigin, profilePath, savePrivateJson, sessionPath } from './browser.js';

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
  context.on('response', (response) => { bearerSession(response).then((found) => found && resolveLogin(found), () => {}); });
  try {
    const page = context.pages()[0] || await context.newPage();
    console.log('Fullfør Vigilo-innloggingen via ID-porten i Chrome. Velg tilhørighet og åpne Foreldreportal.');
    console.log('Vinduet lukkes automatisk når nettportalen er klar.');
    page.goto(`${portalOrigin}/login?redirect=%2F`, { timeout: 0 }).catch(() => {});
    let timeoutId;
    const timer = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Innloggingen tok mer enn ti minutter. Kjør npm run login:browser på nytt.')), 600_000);
    });
    const session = await Promise.race([loggedIn, timer]);
    clearTimeout(timeoutId);
    session.authCookies = authCookies(await context.cookies());
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
