import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { PublicError, clean } from './browser.js';

// Files sent to school staff come only from VIGILO_ATTACHMENTS_DIR, so an AI client that is tricked by a message cannot
// mail other local files (for example ~/.ssh). The parent puts the files there; the tool takes names inside it.
export const maxFiles = 5;
export const maxFileBytes = 5_242_880;  // the portal's MAX_FILE_SIZE (5 MB)
export const maxTotalBytes = 10_000_000;
const maxName = 100;
// A subset of the portal's ALLOWED_TYPES, checked from the first bytes of the file, not only the name.
const types = [
  { mimeType: 'application/pdf', label: 'PDF', extensions: ['.pdf'], magic: Buffer.from('%PDF-') },
  { mimeType: 'image/png', label: 'PNG', extensions: ['.png'], magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mimeType: 'image/jpeg', label: 'JPEG', extensions: ['.jpg', '.jpeg'], magic: Buffer.from([0xff, 0xd8, 0xff]) },
];

const refuse = (name, why) => { throw new PublicError(`Vedlegget ${name} kan ikke sendes: ${why}`); };

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function readOne(realDir, requested, seen, budget) {
  if (typeof requested !== 'string' || !requested || requested.length > maxName) {
    throw new PublicError(`attachments må være filnavn i vedleggsmappen, høyst ${maxName} tegn.`);
  }
  // Control and hidden characters (a newline could fake a line in the dialog) are refused, not removed.
  if (clean(requested) !== requested || /\p{Cc}/u.test(requested)) throw new PublicError('Et filnavn har usynlige tegn eller linjeskift. Gi filen et vanlig navn.');
  const name = requested;
  // Files sit directly in the folder, so the name shown is the whole path and no folder can hide what is sent.
  if (/[\\/]/.test(name) || name === '.' || name === '..') refuse(name, 'filen må ligge rett i vedleggsmappen, uten undermapper.');
  let real;
  try { real = await realpath(join(realDir, name)); } catch { refuse(name, 'fant ikke filen i vedleggsmappen.'); }
  // The real path, after symlinks, must still be directly inside the real folder.
  if (dirname(real) !== realDir) refuse(name, 'bare filer i vedleggsmappen er lov.');
  if (seen.has(real)) throw new PublicError('Samme fil er valgt to ganger.');
  seen.add(real);
  let handle;
  // O_NONBLOCK so a pipe in the folder is refused below instead of waiting for a writer forever.
  try { handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { refuse(name, 'kunne ikke åpne filen.'); }
  try {
    // Size and type are read from the opened file, so what is checked is what is sent.
    const info = await handle.stat();
    if (!info.isFile()) refuse(name, 'det er ikke en vanlig fil.');
    // A hard link can point at a file outside the folder without looking like it.
    if (info.nlink > 1) refuse(name, 'filen har flere navn (hard link). Legg en vanlig kopi i mappen.');
    // The opened file must still be the one the checked path names, so a swap after realpath is caught.
    let now;
    try { now = await stat(await realpath(join(realDir, name))); } catch { refuse(name, 'filen ble endret mens den ble lest.'); }
    if (!sameFile(info, now)) refuse(name, 'filen ble endret mens den ble lest.');
    if (info.size === 0) refuse(name, 'filen er tom.');
    if (info.size > maxFileBytes) refuse(name, 'filen er større enn 5 MB.');
    if (info.size > budget) throw new PublicError('Vedleggene er til sammen større enn 10 MB.');
    // One byte more than expected, to see that the file did not grow after stat.
    const data = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== info.size) refuse(name, 'filen ble endret mens den ble lest.');
    const bytes = data.subarray(0, size);
    const type = types.find((t) => bytes.subarray(0, t.magic.length).equals(t.magic));
    if (!type) refuse(name, 'bare PDF, PNG og JPEG kan sendes.');
    if (!type.extensions.includes(extname(name).toLowerCase())) refuse(name, `innholdet er ${type.label}, men navnet slutter ikke på ${type.extensions.join(' eller ')}.`);
    return { name, mimeType: type.mimeType, label: type.label, size, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
  } finally { await handle.close(); }
}

// Reads every file at prepare time, one at a time, so the bytes shown in the preview are the bytes send_prepared sends.
export async function readAttachments(dir, requested) {
  if (requested === undefined || requested === null) return [];
  if (!dir) throw new PublicError('Vedlegg er slått av. Forelderen kan sette VIGILO_ATTACHMENTS_DIR til en mappe med filene som kan sendes.');
  if (!Array.isArray(requested)) throw new PublicError('attachments må være en liste med filnavn.');
  if (!requested.length) return [];
  if (requested.length > maxFiles) throw new PublicError(`Høyst ${maxFiles} vedlegg.`);
  let realDir;
  try { realDir = await realpath(dir); } catch { throw new PublicError('Fant ikke vedleggsmappen (VIGILO_ATTACHMENTS_DIR).'); }
  const files = [];
  const seen = new Set();
  let budget = maxTotalBytes;
  for (const item of requested) {
    const file = await readOne(realDir, item, seen, budget);
    budget -= file.size;
    files.push(file);
  }
  return files;
}

const kilobytes = (size) => (size < 1_000_000 ? `${Math.ceil(size / 1000)} kB` : `${(size / 1_000_000).toFixed(1)} MB`);
export const attachmentLines = (files) => files.map((f) => `${f.name} (${f.label}, ${kilobytes(f.size)}, sha256 ${f.sha256.slice(0, 12)})`);
export const attachmentBody = (files) => files.map((f) => ({ name: f.name, mimeType: f.mimeType, dataBase64: f.bytes.toString('base64') }));
