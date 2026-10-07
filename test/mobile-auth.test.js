import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

test('mobile session rotates a refresh token without contacting Vigilo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-auth-'));
  process.env.VIGILO_DATA_DIR = dir;
  const { currentMobileSession, refreshMobileSessionNow } = await import('../src/mobile-auth.js');
  const { mobileConfigPath, mobileSessionPath, savePrivateJson } = await import('../src/browser.js');
  await savePrivateJson(mobileConfigPath, {
    clientId: 'test-client', clientSecret: 'test-secret',
    authority: 'https://auth.prod.vigilo-oas.no', redirectUri: 'app://example.test',
  });
  await savePrivateJson(mobileSessionPath, {
    accessToken: 'old-token', refreshToken: 'old-refresh', expiresAt: 0,
  });
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url.href, 'https://auth.prod.vigilo-oas.no/connect/token');
    assert.equal(options.headers.Authorization,
      `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
    assert.equal(new URLSearchParams(options.body).get('grant_type'), 'refresh_token');
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'old-refresh');
    return new Response(JSON.stringify({
      access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 600,
    }), { status: 200 });
  };
  try {
    const sessions = await Promise.all(Array.from({ length: 8 }, () => currentMobileSession()));
    const current = sessions[0];
    assert.ok(sessions.every((session) => session.accessToken === 'new-token'));
    assert.equal(current.accessToken, 'new-token');
    assert.equal(current.refreshToken, 'new-refresh');
    assert.deepEqual(await currentMobileSession(), current);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(mobileSessionPath, 'utf8')).refreshToken, 'new-refresh');
    assert.equal((await stat(mobileSessionPath)).mode & 0o777, 0o600);

    let apiCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (url.href === 'https://auth.prod.vigilo-oas.no/connect/token') {
        assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'new-refresh');
        return new Response(JSON.stringify({
          access_token: 'third-token', refresh_token: 'third-refresh', expires_in: 600,
        }), { status: 200 });
      }
      apiCalls++;
      assert.equal(url.pathname, '/api/children/my');
      return apiCalls === 1
        ? new Response('', { status: 401 })
        : new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const { Portal } = await import('../src/portal.js');
    assert.deepEqual(await new Portal().listChildren(), []);
    assert.equal(apiCalls, 2);
    assert.equal(JSON.parse(await readFile(mobileSessionPath, 'utf8')).refreshToken, 'third-refresh');

    globalThis.fetch = async (_url, options) => {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code_verifier'), 'a'.repeat(43));
      return new Response(JSON.stringify({
        access_token: 'code-token', refresh_token: 'code-refresh', expires_in: 600,
      }), { status: 200 });
    };
    const { exchangeMobileCode } = await import('../src/mobile-auth.js');
    await assert.rejects(exchangeMobileCode('test-code', 'short'), /PKCE/);
    const fromCode = await exchangeMobileCode('test-code', 'a'.repeat(43));
    assert.equal(fromCode.refreshToken, 'code-refresh');

    globalThis.fetch = async (_url, options) => {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.has('code_verifier'), false);
      return new Response(JSON.stringify({
        access_token: 'code-token', refresh_token: 'code-refresh', expires_in: 600,
      }));
    };
    assert.equal((await exchangeMobileCode('legacy-code')).refreshToken, 'code-refresh');

    let resumedCalls = 0;
    Date.now = () => previousNow() + 31 * 86_400_000;
    globalThis.fetch = async (_url, options) => {
      resumedCalls++;
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'code-refresh');
      return new Response(JSON.stringify({ access_token: 'resumed-token', expires_in: 600 }));
    };
    const resumed = await currentMobileSession();
    assert.equal(resumed.accessToken, 'resumed-token');
    assert.equal(resumed.refreshToken, 'code-refresh');
    assert.ok(resumed.expiresAt > Date.now());
    assert.deepEqual(await currentMobileSession(), resumed);
    assert.equal(resumedCalls, 1);
    assert.equal(JSON.parse(await readFile(mobileSessionPath, 'utf8')).refreshToken, 'code-refresh');

    for (const statusCode of [400, 401]) {
      globalThis.fetch = async () => new Response('', { status: statusCode });
      await assert.rejects(refreshMobileSessionNow(resumed), /npm run login/);
      assert.equal(JSON.parse(await readFile(mobileSessionPath, 'utf8')).refreshToken, 'code-refresh');
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'PRIVATE-RESPONSE-CONTENTS',
    }), { status: 400 });
    await assert.rejects(exchangeMobileCode('test-code', 'a'.repeat(43)), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.oauthError, 'invalid_grant');
      assert.match(error.message, /invalid_grant/);
      assert.equal(error.message.includes('PRIVATE-RESPONSE-CONTENTS'), false);
      return true;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'PRIVATE-RESPONSE-CONTENTS',
    }), { status: 400 });
    await assert.rejects(exchangeMobileCode('test-code', 'a'.repeat(43)), (error) => {
      assert.equal(error.oauthError, undefined);
      assert.equal(error.message.includes('PRIVATE-RESPONSE-CONTENTS'), false);
      return true;
    });

    Date.now = previousNow;
    await savePrivateJson(mobileSessionPath, {
      accessToken: 'shared-token', refreshToken: 'shared-refresh', expiresAt: 0,
    });
    const script = `
      const { refreshMobileSessionNow } = await import(${JSON.stringify(new URL('../src/mobile-auth.js', import.meta.url).href)});
      let calls = 0;
      globalThis.fetch = async (_url, options) => {
        if (new URLSearchParams(options.body).get('refresh_token') !== 'shared-refresh') {
          throw new Error('Unexpected refresh token');
        }
        calls++;
        return new Response(JSON.stringify({
          access_token: 'shared-new-token', refresh_token: 'shared-new-refresh', expires_in: 600,
        }));
      };
      const session = await refreshMobileSessionNow({ refreshToken: 'shared-refresh' });
      console.log(JSON.stringify({ calls, refreshToken: session.refreshToken }));
    `;
    const runNode = promisify(execFile);
    const processes = await Promise.all(Array.from({ length: 2 }, () =>
      runNode(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env } })));
    const results = processes.map(({ stdout }) => JSON.parse(stdout));
    assert.equal(results.reduce((total, result) => total + result.calls, 0), 1);
    assert.ok(results.every((result) => result.refreshToken === 'shared-new-refresh'));
    assert.equal(JSON.parse(await readFile(mobileSessionPath, 'utf8')).refreshToken, 'shared-new-refresh');
  } finally {
    Date.now = previousNow;
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
    delete process.env.VIGILO_DATA_DIR;
  }
});
