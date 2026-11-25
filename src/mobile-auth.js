import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, open, readFile } from 'node:fs/promises';
import { PublicError, ensurePrivateDataDir, mobileConfigPath, mobileSessionPath, readLimited, savePrivateJson, tokenExpiry } from './browser.js';

let refreshing;

export async function mobileConfig() {
  let config;
  try { config = JSON.parse(await readFile(mobileConfigPath, 'utf8')); }
  catch { throw new PublicError('Vigilos appoppsett mangler.'); }
  if (!config.clientId || !config.clientSecret || !config.redirectUri ||
      new URL(config.authority).origin !== 'https://auth.prod.vigilo-oas.no') {
    throw new PublicError('Vigilos lokale appoppsett er ufullstendig.');
  }
  return config;
}

export async function readMobileSession() {
  const text = await readFile(mobileSessionPath, 'utf8');
  let session;
  // The parse error would quote the start of the file, which holds the tokens.
  try { session = JSON.parse(text); }
  catch { throw new PublicError('Den lagrede Vigilo-økten er uleselig. Kjør npm run login på nytt.'); }
  if (!session?.accessToken || !session?.refreshToken) throw new PublicError('Vigilo-økten er ufullstendig. Kjør npm run login på nytt.');
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
  } catch { throw new PublicError('Kunne ikke kontakte Vigilos innloggingstjeneste.'); }
  const body = await readLimited(response, 100_000, 'Vigilo sendte et for stort tokensvar.');
  let result;
  try { result = JSON.parse(body.toString('utf8')); }
  catch {
    if (response.ok) throw new PublicError('Vigilo sendte et uventet tokensvar.');
  }
  if (!response.ok) {
    const knownErrors = new Set(['invalid_request', 'invalid_client', 'invalid_grant',
      'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);
    const oauthError = knownErrors.has(result?.error) ? result.error : undefined;
    const error = new PublicError(`Vigilos innloggingstjeneste svarte HTTP ${response.status}${oauthError ? ` (${oauthError})` : ''}.`);
    error.status = response.status;
    error.oauthError = oauthError;
    throw error;
  }
  if (!result?.access_token) throw new PublicError('Vigilo sendte ikke et tilgangstoken.');
  return result;
}

function sessionFromResponse(result, previous) {
  if (!result.refresh_token && !previous?.refreshToken) {
    throw new PublicError('Vigilo sendte ikke et fornyelsestoken.');
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
    throw new PublicError('Ugyldig PKCE-verifikator.');
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

// The kernel holds the lock for a child process and releases it if this process dies, so no stale lock is left.
// shortcut: needs flock (Linux) or lockf (macOS), so renewal does not work on Windows; use a lock file if needed there.
export async function withSessionLock(lockPath, action) {
  await ensurePrivateDataDir();
  const file = await open(lockPath, 'a', 0o600);
  await file.close();
  await chmod(lockPath, 0o600);
  const [lockCommand, timeoutFlag] = process.platform === 'linux' ? ['/usr/bin/flock', '-w'] : ['/usr/bin/lockf', '-t'];
  const holder = spawn(lockCommand, [
    timeoutFlag, '30', lockPath, '/bin/sh', '-c', 'printf "READY\\n"; IFS= read -r _',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        holder.kill();
        reject(new PublicError('Vigilo-økten er opptatt. Prøv igjen om litt.'));
      }, 35_000);
      const finish = (callback, value) => {
        clearTimeout(timer);
        callback(value);
      };
      holder.stdout.once('data', (chunk) => {
        if (chunk.toString() === 'READY\n') finish(resolve);
        else finish(reject, new PublicError('Kunne ikke låse Vigilo-økten.'));
      });
      holder.once('error', (error) => finish(reject, error));
      holder.once('exit', () => finish(reject, new PublicError('Vigilo-økten er opptatt. Prøv igjen om litt.')));
    });
    return await action();
  } finally {
    if (holder.exitCode === null) {
      const ended = once(holder, 'exit');
      holder.stdin.end('\n');
      await ended;
    }
  }
}

async function refreshMobileSession(previous) {
  return withSessionLock(`${mobileSessionPath}.lock`, async () => {
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
        throw new PublicError('Vigilo-innloggingen må fornyes. Kjør npm run login på nytt.');
      }
      throw error;
    }
    // Saved even if the lock was lost meanwhile: Vigilo has already replaced the old refresh token.
    const current = sessionFromResponse(result, saved);
    await savePrivateJson(mobileSessionPath, current);
    return current;
  });
}

export async function currentMobileSession(savedSession) {
  const saved = savedSession || await readMobileSession();
  if (saved.expiresAt > Date.now() + 60_000) return saved;
  return refreshMobileSessionNow(saved);
}

export async function refreshMobileSessionNow(savedSession) {
  const saved = savedSession || await readMobileSession();
  if (!refreshing) refreshing = refreshMobileSession(saved).finally(() => { refreshing = undefined; });
  return refreshing;
}
