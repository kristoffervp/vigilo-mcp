import { createRequire } from 'node:module';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const dataDir = resolve(process.env.VIGILO_DATA_DIR || join(projectRoot, '.data'));
export const profilePath = join(dataDir, 'browser-profile');
export const sessionPath = join(dataDir, 'session.json');
export const mobileProfilePath = join(dataDir, 'mobile-browser-profile');
export const mobileConfigPath = join(dataDir, 'mobile-client.json');
export const mobileSessionPath = join(dataDir, 'mobile-session.json');
export const browserChannel = process.env.VIGILO_BROWSER_CHANNEL || 'chrome';
export const portalOrigin = 'https://web-parent.prod.vigilo-oas.no';

export function loadPlaywright() {
  try { return require('playwright'); }
  catch { throw new Error('Playwright mangler. Kjør npm install i prosjektmappen.'); }
}

export async function ensurePrivateDataDir() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
}

export async function savePrivateJson(path, value) {
  await ensurePrivateDataDir();
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}
