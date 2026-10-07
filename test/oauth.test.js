import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { browserChannel, loadPlaywright } from '../src/browser.js';
import { captureMobileRedirect, mobileCallbackCode, newOauthAttempt } from '../src/oauth.js';

test('mobile authorization uses PKCE S256 and exact callback matching', () => {
  const config = {
    clientId: 'test-client', authority: 'https://auth.prod.vigilo-oas.no',
    redirectUri: 'app://example.test/callback',
  };
  const { authorize, state, verifier } = newOauthAttempt(config);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('code_challenge'),
    createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(authorize.searchParams.get('scope'), 'openid vigiloprofile offline_access');
  assert.ok(authorize.searchParams.get('nonce'));
  assert.equal(authorize.searchParams.has('prompt'), false);
  assert.equal(mobileCallbackCode(`app://example.test/callback?code=one&state=${state}`,
    config.redirectUri, state), 'one');
  assert.equal(mobileCallbackCode(`app://example.test.evil/callback?code=one&state=${state}`,
    config.redirectUri, state), null);
  assert.equal(mobileCallbackCode(`app://example.test/callback-extra?code=one&state=${state}`,
    config.redirectUri, state), null);
  assert.throws(() => mobileCallbackCode('app://example.test/callback?code=one&state=wrong',
    config.redirectUri, state), /tilstand/);
});

test('legacy app authorization omits PKCE but keeps random state, nonce and offline access', () => {
  const config = { clientId: 'test-client', authority: 'https://auth.prod.vigilo-oas.no',
    redirectUri: 'app://example.test' };
  const first = newOauthAttempt(config, { usePkce: false });
  const second = newOauthAttempt(config, { usePkce: false });
  assert.equal(first.verifier, undefined);
  assert.equal(first.authorize.searchParams.has('code_challenge'), false);
  assert.equal(first.authorize.searchParams.has('code_challenge_method'), false);
  assert.equal(first.authorize.searchParams.get('scope'), 'openid vigiloprofile offline_access');
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.authorize.searchParams.get('nonce'), second.authorize.searchParams.get('nonce'));
});

test('app root callbacks accept the slash added by Vigilo without accepting other targets', () => {
  const redirectUri = 'app://example.test';
  assert.equal(mobileCallbackCode('app://example.test/?code=one&state=expected',
    redirectUri, 'expected'), 'one');
  assert.equal(mobileCallbackCode('app://example.test?code=one&state=expected',
    redirectUri, 'expected'), 'one');
  for (const target of ['app://example.test/other', 'app://example.test//',
    'app://example.test.evil/', 'app://user@example.test/', 'https://example.test/']) {
    assert.equal(mobileCallbackCode(`${target}?code=one&state=expected`, redirectUri, 'expected'), null);
  }
  assert.throws(() => mobileCallbackCode('app://example.test/?code=one&state=wrong',
    redirectUri, 'expected'), /tilstand/);
  assert.throws(() => mobileCallbackCode('app://example.test/?error=login_required&state=expected',
    redirectUri, 'expected'), /avbrøt/);
});

test('app redirect is captured before the browser tries to open an external protocol', async () => {
  let fulfillment;
  const route = {
    request: () => ({ isNavigationRequest: () => true, method: () => 'GET',
      url: () => 'https://auth.prod.vigilo-oas.no/connect/authorize/callback' }),
    fetch: async (options) => {
      assert.equal(options.maxRedirects, 0);
      return { status: () => 302,
        headers: () => ({ location: 'app://example.test/?code=one&state=expected' }) };
    },
    fulfill: async (options) => { fulfillment = options; },
  };
  assert.equal(await captureMobileRedirect(route, 'app://example.test', 'expected'), 'one');
  assert.equal(fulfillment.status, 200);
  assert.equal(fulfillment.response, undefined);
  assert.equal(JSON.stringify(fulfillment).includes('code=one'), false);

  route.fetch = async () => ({ status: () => 302,
    headers: () => ({ location: '/Account/Login?ReturnUrl=local' }) });
  const requester = { get: async () => ({ status: () => 200, headers: () => ({}) }) };
  assert.equal(await captureMobileRedirect(route, 'app://example.test', 'expected', requester), null);
  assert.equal(fulfillment.status, 303);
  assert.equal(fulfillment.headers.location, 'https://auth.prod.vigilo-oas.no/Account/Login?ReturnUrl=local');

  route.fetch = async () => ({ status: () => 302,
    headers: () => ({ location: 'app://example.test/?code=one&state=wrong' }) });
  await assert.rejects(captureMobileRedirect(route, 'app://example.test', 'expected'), /tilstand/);
});

test('callback redirect chains are followed only within the authentication origin', async () => {
  let fulfillment;
  const visited = [];
  const route = {
    request: () => ({ isNavigationRequest: () => true, method: () => 'GET',
      url: () => 'https://auth.prod.vigilo-oas.no/signin-idporten' }),
    fetch: async () => ({ status: () => 302, headers: () => ({ location: '/external/callback' }) }),
    fulfill: async (options) => { fulfillment = options; },
  };
  const requester = {
    get: async (url, options) => {
      assert.equal(options.maxRedirects, 0);
      visited.push(url);
      return { status: () => 302, headers: () => ({ location: visited.length === 1
        ? '/connect/authorize/callback'
        : 'app://example.test/?code=one&state=expected' }) };
    },
  };
  assert.equal(await captureMobileRedirect(route, 'app://example.test', 'expected', requester), 'one');
  assert.deepEqual(visited, ['https://auth.prod.vigilo-oas.no/external/callback',
    'https://auth.prod.vigilo-oas.no/connect/authorize/callback']);
  assert.equal(fulfillment.status, 200);

  route.fetch = async () => ({ status: () => 302,
    headers: () => ({ location: 'https://login.example.test/authorize' }) });
  visited.length = 0;
  assert.equal(await captureMobileRedirect(route, 'app://example.test', 'expected', requester), null);
  assert.equal(visited.length, 0);
  assert.equal(fulfillment.headers.location, 'https://login.example.test/authorize');

  route.fetch = async () => ({ status: () => 302, headers: () => ({ location: '/loop' }) });
  requester.get = async () => ({ status: () => 302, headers: () => ({ location: '/loop' }) });
  await assert.rejects(captureMobileRedirect(route, 'app://example.test', 'expected', requester), /omdirigeringer/);
});

test('non-navigation requests pass through without fetching or changing their response', async () => {
  let continued = false;
  const route = {
    request: () => ({ isNavigationRequest: () => false }),
    continue: async () => { continued = true; },
    fetch: async () => assert.fail('Non-navigation request was fetched'),
    fulfill: async () => assert.fail('Non-navigation response was replaced'),
  };
  assert.equal(await captureMobileRedirect(route, 'app://example.test', 'expected'), null);
  assert.equal(continued, true);
});

test('Chrome captures callback chains with auth cookies before opening an external protocol', async (testContext) => {
  const { chromium } = loadPlaywright();
  let browser;
  try {
    browser = await chromium.launch({ channel: browserChannel, headless: true, chromiumSandbox: true });
  } catch (error) {
    if (/not found|doesn't exist|not installed/i.test(error.message)) {
      testContext.skip('Browser is not installed');
      return;
    }
    throw error;
  }
  const server = createServer((request, response) => {
    if (request.url === '/external/callback') {
      response.writeHead(302, { Location: '/connect/authorize/callback',
        'Set-Cookie': 'test-session=ready; Path=/; HttpOnly' });
    } else if (request.url === '/connect/authorize/callback' && request.headers.cookie?.includes('test-session=ready')) {
      response.writeHead(302, { Location: 'app://example.test/?code=test-code&state=test-state' });
    } else {
      response.writeHead(400);
    }
    response.end();
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext();
    let captured;
    await context.route(`${origin}/**`, async (route) => {
      const code = await captureMobileRedirect(route, 'app://example.test', 'test-state', context.request);
      if (code) captured = code;
    });
    const page = await context.newPage();
    await page.goto(`${origin}/external/callback`, { timeout: 15_000 });
    assert.equal(captured, 'test-code');
    assert.equal(new URL(page.url()).origin, origin);
    assert.match(await page.locator('body').innerText(), /innloggingen er mottatt/);
  } finally {
    await browser.close();
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  }
});
