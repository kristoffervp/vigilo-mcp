import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, open, readFile } from 'node:fs/promises';
import { ensurePrivateDataDir, mobileConfigPath, mobileSessionPath, savePrivateJson, tokenExpiry } from './browser.js';

let refreshing;

export async function mobileConfig() {
  let config;
  try { config = JSON.parse(await readFile(mobileConfigPath, 'utf8')); }
  catch { throw new Error('Vigilos appoppsett mangler.'); }
  if (!config.clientId || !config.clientSecret || !config.redirectUri ||
      new URL(config.authority).origin !== 'https://auth.prod.vigilo-oas.no') {
    throw new Error('Vigilos lokale appoppsett er ufullstendig.');
  }
  return config;
}

export async function readMobileSession() {
  const session = JSON.parse(await readFile(mobileSessionPath, 'utf8'));
  if (!session.accessToken || !session.refreshToken) throw new Error('Vigilo-økten er ufullstendig.');
  return session;
}

async function tokenRequest(config, fields) {
  let response;
  try {
    response = await fetch(new URL('/connect/token', config.authority), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(fields),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new Error('Kunne ikke kontakte Vigilos innloggingstjeneste.'); }
  const maxTokenResponseBytes = 100_000;
  if (Number(response.headers.get('content-length')) > maxTokenResponseBytes) {
    throw new Error('Vigilo sendte et for stort tokensvar.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > maxTokenResponseBytes) throw new Error('Vigilo sendte et for stort tokensvar.');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch {
    if (response.ok) throw new Error('Vigilo sendte et uventet tokensvar.');
  }
  if (!response.ok) {
    const knownErrors = new Set(['invalid_request', 'invalid_client', 'invalid_grant',
      'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);
    const oauthError = knownErrors.has(result?.error) ? result.error : undefined;
    const error = new Error(`Vigilos innloggingstjeneste svarte HTTP ${response.status}${oauthError ? ` (${oauthError})` : ''}.`);
    error.status = response.status;
    error.oauthError = oauthError;
    throw error;
  }
  if (!result?.access_token) throw new Error('Vigilo sendte ikke et tilgangstoken.');
  return result;
}

function sessionFromResponse(result, previous) {
  if (!result.refresh_token && !previous?.refreshToken) {
    throw new Error('Vigilo sendte ikke et fornyelsestoken.');
  }
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token || previous.refreshToken,
    expiresAt: tokenExpiry(result.access_token) ||
      Date.now() + Math.max(60, Number(result.expires_in) || 600) * 1000,
    capturedAt: Date.now(),
  };
}

export async function exchangeMobileCode(code, verifier) {
  if (verifier !== undefined && (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))) {
    throw new Error('Ugyldig PKCE-verifikator.');
  }
  const config = await mobileConfig();
  const result = await tokenRequest(config, {
    grant_type: 'authorization_code', code, redirect_uri: config.redirectUri,
    ...(verifier ? { code_verifier: verifier } : {}),
  });
  const session = sessionFromResponse(result);
  await savePrivateJson(mobileSessionPath, session);
  return session;
}

async function withSessionLock(action) {
  const lockPath = `${mobileSessionPath}.lock`;
  await ensurePrivateDataDir();
  const file = await open(lockPath, 'a', 0o600);
  await file.close();
  await chmod(lockPath, 0o600);
  const holder = spawn('/usr/bin/lockf', [
    '-t', '30', lockPath, '/bin/sh', '-c', 'printf "READY\\n"; IFS= read -r _',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        holder.kill();
        reject(new Error('Vigilo-økten er opptatt. Prøv igjen om litt.'));
      }, 35_000);
      const finish = (callback, value) => {
        clearTimeout(timer);
        callback(value);
      };
      holder.stdout.once('data', (chunk) => {
        if (chunk.toString() === 'READY\n') finish(resolve);
        else finish(reject, new Error('Kunne ikke låse Vigilo-økten.'));
      });
      holder.once('error', (error) => finish(reject, error));
      holder.once('exit', () => finish(reject, new Error('Vigilo-økten er opptatt. Prøv igjen om litt.')));
    });
    return await action(() => {
      if (holder.exitCode !== null) throw new Error('Vigilo-låsen ble brutt. Prøv igjen.');
    });
  } finally {
    if (holder.exitCode === null) {
      const ended = once(holder, 'exit');
      holder.stdin.end('\n');
      await ended;
    }
  }
}

async function refreshMobileSession(previous) {
  return withSessionLock(async (assertLocked) => {
    const saved = await readMobileSession();
    if (saved.refreshToken !== previous.refreshToken && saved.expiresAt > Date.now() + 60_000) return saved;
    const config = await mobileConfig();
    let result;
    try {
      result = await tokenRequest(config, {
        grant_type: 'refresh_token', refresh_token: saved.refreshToken,
      });
    } catch (error) {
      if (error.status === 400 || error.status === 401) {
        throw new Error('Vigilo-innloggingen må fornyes. Kjør npm run login på nytt.');
      }
      throw error;
    }
    const current = sessionFromResponse(result, saved);
    assertLocked();
    await savePrivateJson(mobileSessionPath, current);
    return current;
  });
}

export async function currentMobileSession() {
  const saved = await readMobileSession();
  if (saved.expiresAt > Date.now() + 60_000) return saved;
  return refreshMobileSessionNow(saved);
}

export async function refreshMobileSessionNow(savedSession) {
  const saved = savedSession || await readMobileSession();
  if (!refreshing) refreshing = refreshMobileSession(saved).finally(() => { refreshing = undefined; });
  return refreshing;
}
