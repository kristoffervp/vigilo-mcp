import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentLines, readAttachments } from '../src/attachments.js';

const pdf = Buffer.from('%PDF-1.4\n% test\n');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

async function folders() {
  const root = await mkdtemp(join(tmpdir(), 'vigilo-mcp-files-'));
  const dir = join(root, 'send');
  const outside = join(root, 'private');
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'note.jpeg'), jpeg);
  await mkdir(outside);
  await writeFile(join(dir, 'scan.pdf'), pdf);
  await writeFile(join(dir, 'photo.PNG'), png);
  await writeFile(join(dir, 'sub', 'note.jpeg'), jpeg);
  await writeFile(join(outside, 'id_rsa.pdf'), pdf);
  return { root, dir, outside };
}

test('files are read only from the attachments folder, and the preview names type, size and hash', async () => {
  const { root, dir } = await folders();
  try {
    const files = await readAttachments(dir, ['scan.pdf', 'photo.PNG', 'note.jpeg']);
    assert.deepEqual(files.map((f) => [f.name, f.mimeType, f.size]), [['scan.pdf', 'application/pdf', pdf.length],
      ['photo.PNG', 'image/png', png.length], ['note.jpeg', 'image/jpeg', jpeg.length]]);
    assert.ok(files[0].bytes.equals(pdf));
    assert.match(attachmentLines(files)[0], /^scan\.pdf \(PDF, 1 kB, sha256 [0-9a-f]{12}\)$/);
    assert.deepEqual(await readAttachments(dir, undefined), []);
    assert.deepEqual(await readAttachments(dir, []), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('without VIGILO_ATTACHMENTS_DIR attachments are refused', async () => {
  await assert.rejects(readAttachments(undefined, ['scan.pdf']), /slått av/);
  await assert.rejects(readAttachments('', ['scan.pdf']), /slått av/);
  await assert.rejects(readAttachments('/does/not/exist', ['scan.pdf']), /Fant ikke vedleggsmappen/);
});

test('paths that leave the folder are refused, also through symlinks', async () => {
  const { root, dir, outside } = await folders();
  try {
    await symlink(join(outside, 'id_rsa.pdf'), join(dir, 'link.pdf'));
    await symlink(outside, join(dir, 'escape'));
    await symlink(join(dir, 'scan.pdf'), join(dir, 'inside.pdf'));
    for (const name of ['../private/id_rsa.pdf', join(outside, 'id_rsa.pdf'), 'sub/../../private/id_rsa.pdf', 'escape/id_rsa.pdf', '..\\private\\id_rsa.pdf',
      'sub/note.jpeg', '..', '.']) {
      await assert.rejects(readAttachments(dir, [name]), /rett i vedleggsmappen/, name);
    }
    await assert.rejects(readAttachments(dir, ['link.pdf']), /bare filer i vedleggsmappen/);
    // A symlink that stays inside is the same file, and the same file twice is refused.
    assert.equal((await readAttachments(dir, ['inside.pdf']))[0].size, pdf.length);
    await assert.rejects(readAttachments(dir, ['scan.pdf', 'inside.pdf']), /to ganger/);
    await assert.rejects(readAttachments(dir, ['missing.pdf']), /fant ikke filen/);
    await assert.rejects(readAttachments(dir, ['a\0b.pdf']), /usynlige tegn/);
    await assert.rejects(readAttachments(dir, 'scan.pdf'), /liste/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only regular, non-empty PDF, PNG and JPEG files up to 5 MB, five at most and 10 MB together', async () => {
  const { root, dir } = await folders();
  try {
    await writeFile(join(dir, 'empty.pdf'), '');
    await writeFile(join(dir, 'text.pdf'), 'not a pdf');
    await writeFile(join(dir, 'image.pdf'), png);
    await writeFile(join(dir, 'script.sh'), pdf);
    await writeFile(join(dir, 'big.pdf'), Buffer.concat([pdf, Buffer.alloc(5_242_880)]));
    for (const n of [1, 2, 3]) await writeFile(join(dir, `part${n}.pdf`), Buffer.concat([pdf, Buffer.alloc(4_000_000)]));
    await assert.rejects(readAttachments(dir, ['sub']), /vanlig fil/);
    // A named pipe would block a plain open until something writes to it.
    try { execFileSync('mkfifo', [join(dir, 'pipe.pdf')]); } catch { /* no mkfifo here */ }
    await assert.rejects(readAttachments(dir, ['pipe.pdf']), /vanlig fil|fant ikke filen/);
    await assert.rejects(readAttachments(dir, ['empty.pdf']), /tom/);
    await assert.rejects(readAttachments(dir, ['text.pdf']), /bare PDF, PNG og JPEG/);
    await assert.rejects(readAttachments(dir, ['image.pdf']), /innholdet er PNG/);
    await assert.rejects(readAttachments(dir, ['script.sh']), /slutter ikke på \.pdf/);
    await assert.rejects(readAttachments(dir, ['big.pdf']), /større enn 5 MB/);
    await assert.rejects(readAttachments(dir, ['part1.pdf', 'part2.pdf', 'part3.pdf']), /til sammen større enn 10 MB/);
    await assert.rejects(readAttachments(dir, Array(6).fill('scan.pdf')), /Høyst 5/);
    await assert.rejects(readAttachments(dir, [`${'n'.repeat(101)}.pdf`]), /høyst 100 tegn/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review 5, 6, 7 and 9: no big buffers, no control characters, no subfolders, no hard links', async () => {
  const { root, dir } = await folders();
  try {
    await writeFile(join(dir, 'a.pdf\nwarning: none.pdf'), pdf);
    await assert.rejects(readAttachments(dir, ['a.pdf\nwarning: none.pdf']), /linjeskift/);
    await assert.rejects(readAttachments(dir, ['sub/note.jpeg']), /rett i vedleggsmappen/);
    await link(join(dir, 'scan.pdf'), join(dir, 'twin.pdf'));
    await assert.rejects(readAttachments(dir, ['twin.pdf']), /hard link/);
    await writeFile(join(dir, 'small.pdf'), pdf);
    const sizes = [];
    const alloc = Buffer.alloc;
    Buffer.alloc = (size, ...rest) => { sizes.push(size); return alloc.call(Buffer, size, ...rest); };
    try { await readAttachments(dir, ['small.pdf']); } finally { Buffer.alloc = alloc; }
    assert.ok(Math.max(...sizes) <= pdf.length + 1, `allocated ${Math.max(...sizes)} bytes`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
