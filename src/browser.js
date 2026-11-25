import { createRequire } from 'node:module';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const dataDir = resolve(process.env.VIGILO_DATA_DIR || join(projectRoot, '.data'));
export const profilePath = join(dataDir, 'browser-profile');
export const sessionPath = join(dataDir, 'session.json');
// shortcut: only used to delete the profile versions before 0.2.1 left behind, remove in 0.5.
export const mobileProfilePath = join(dataDir, 'mobile-browser-profile');
export const mobileConfigPath = join(dataDir, 'mobile-client.json');
export const mobileSessionPath = join(dataDir, 'mobile-session.json');
export const browserChannel = process.env.VIGILO_BROWSER_CHANNEL || 'chrome';
export const portalOrigin = 'https://web-parent.prod.vigilo-oas.no';

// Messages this code writes for the client. Any other error (parser, file system, Playwright) can quote
// tokens or local paths, so the server shows only a generic message for those.
export class PublicError extends Error {}

// Format and control characters (direction overrides, zero-width and Unicode tag characters) can hide text
// from the parent while an AI client still reads it, so they are removed from everything returned.
const invisibleCharacters = /(?![\n\t])[\p{Cf}\p{Cc}]/gu;

export function clean(text) {
  return String(text ?? '').toWellFormed().replace(invisibleCharacters, '');
}

export function loadPlaywright() {
  try { return require('playwright'); }
  catch { throw new PublicError('Playwright mangler. Kjør npm install i prosjektmappen.'); }
}

export async function readLimited(response, maxBytes, message) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new PublicError(message);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new PublicError(message);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function ensurePrivateDataDir() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
}

// Writes a new private file under a random name and renames it into place, so a file or symlink at the path
// is replaced instead of written through, and no partial copy is left if a step fails.
export async function writePrivateFile(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function savePrivateJson(path, value) {
  await ensurePrivateDataDir();
  await writePrivateFile(path, JSON.stringify(value));
}

const authDomains = new Set(['auth.prod.vigilo-oas.no', '.auth.prod.vigilo-oas.no']);
export const authCookies = (cookies) => cookies.filter((cookie) => authDomains.has(cookie.domain));

// The portal's own API calls carry the bearer token. Returns the session from a successful call, or null.
export async function bearerSession(response) {
  let url;
  try { url = new URL(response.url()); } catch { return null; }
  if (url.origin !== portalOrigin || !url.pathname.startsWith('/api/') || response.status() < 200 || response.status() >= 300) return null;
  const headers = await response.request().allHeaders();
  const match = /^Bearer\s+(.+)$/i.exec(headers.authorization || '');
  if (!match || (tokenExpiry(match[1]) || 0) <= Date.now() + 60_000) return null;
  const browserStorage = await response.request().frame().page().evaluate(() => Object.fromEntries(
    Array.from({ length: sessionStorage.length }, (_, i) => {
      const key = sessionStorage.key(i);
      return key?.startsWith('oidc.user:') ? [key, sessionStorage.getItem(key)] : null;
    }).filter(Boolean),
  ));
  return { accessToken: match[1], expiresAt: tokenExpiry(match[1]), capturedAt: Date.now(), browserStorage };
}

export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}
