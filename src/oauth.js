import { createHash, randomBytes } from 'node:crypto';

export function newOauthAttempt(config, { usePkce = true } = {}) {
  const state = randomBytes(24).toString('base64url');
  const verifier = usePkce ? randomBytes(32).toString('base64url') : undefined;
  const authorize = new URL('/connect/authorize', config.authority);
  for (const [key, value] of Object.entries({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid vigiloprofile offline_access',
    display: 'touch',
    state,
    nonce: randomBytes(24).toString('base64url'),
    ...(verifier ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' } : {}),
  })) authorize.searchParams.set(key, value);
  return { authorize, state, verifier };
}

export function mobileCallbackCode(requestUrl, redirectUri, expectedState) {
  let actual;
  try { actual = new URL(requestUrl); } catch { return null; }
  const expected = new URL(redirectUri);
  if (actual.protocol !== expected.protocol || actual.host !== expected.host ||
      (actual.pathname || '/') !== (expected.pathname || '/') || actual.username !== expected.username ||
      actual.password !== expected.password || actual.hash) return null;
  if (actual.searchParams.get('state') !== expectedState) {
    throw new Error('Innloggingen hadde feil tilstand. Prøv igjen.');
  }
  if (actual.searchParams.has('error')) throw new Error('Vigilo avbrøt innloggingen. Prøv igjen.');
  const code = actual.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('Vigilo sendte ingen gyldig innloggingskode.');
  return code;
}

export async function captureMobileRedirect(route, redirectUri, expectedState, requester) {
  if (!route.request().isNavigationRequest()) {
    await route.continue();
    return null;
  }
  let url = new URL(route.request().url());
  const origin = url.origin;
  let method = route.request().method();
  let response = await route.fetch({ maxRedirects: 0, timeout: 30_000 });
  let followed = false;
  for (let redirects = 0; redirects < 10; redirects++) {
    const status = response.status();
    const headers = response.headers();
    if (![301, 302, 303, 307, 308].includes(status) || !headers.location) {
      if (followed) {
        await route.fulfill({ status: 303, headers: { location: url.href }, body: '' });
      } else {
        await route.fulfill({ response });
      }
      return null;
    }
    const target = new URL(headers.location, url);
    const code = mobileCallbackCode(target.href, redirectUri, expectedState);
    if (code) {
      await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8',
        body: 'Vigilo-innloggingen er mottatt. Dette vinduet lukkes automatisk.' });
      return code;
    }
    if (target.origin !== origin || target.username || target.password ||
        (method !== 'GET' && (status === 307 || status === 308))) {
      await route.fulfill({ response, headers: { ...headers, location: target.href } });
      return null;
    }
    url = target;
    method = 'GET';
    response = await requester.get(url.href, { maxRedirects: 0, timeout: 30_000 });
    followed = true;
  }
  throw new Error('Vigilo sendte for mange omdirigeringer under innloggingen.');
}
