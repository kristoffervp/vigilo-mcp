import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenExpiry } from '../src/browser.js';
import { Portal } from '../src/portal.js';

test('token expiry is read without exposing token contents', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url');
  assert.equal(tokenExpiry(`header.${payload}.signature`), 2_000_000_000_000);
  assert.equal(tokenExpiry('invalid'), null);
});

test('invalid identifiers and dates are rejected before any network call', async () => {
  const portal = new Portal();
  await assert.rejects(portal.listMessageThreads({ child_id: '../other' }), /child_id/);
  await assert.rejects(portal.getMessageThread({ child_id: 'safe', thread_id: '../other' }), /thread_id/);
  await assert.rejects(portal.listNews({ child_id: 'safe', from_date: 'yesterday' }), /from_date/);
  await assert.rejects(portal.listNews({ child_id: 'safe', from_date: '2026-02-30' }), /from_date/);
  await assert.rejects(portal.listNews({ child_id: 'safe', from_date: '2020-01-01', to_date: '2022-01-01' }), /366/);
});

test('message and news responses allow only selected fields and cap item counts', async () => {
  const secret = 'HIDDEN-PERSONAL-DATA';
  const portal = new Portal({
    sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async (url) => {
      if (url.pathname.endsWith('/news-feed')) {
        return new Response(JSON.stringify([{ id: 'post', title: 'Info', text: 'Hello',
          secret, author: { firstName: 'A', residentialAddress: secret } }]));
      }
      return new Response(JSON.stringify({ items: Array.from({ length: 51 }, (_, index) => ({
        messageThreadId: String(index), title: index === 0 ? { secret } : 'Info', nationalIdentityNumber: secret,
        lastMessage: { id: 'message', body: 'Hello', secret,
          sender: { firstName: 'A', residentialAddress: secret } },
      })) }));
    },
  });
  const threads = await portal.listMessageThreads({ child_id: 'child' });
  assert.equal(threads.items.length, 50);
  assert.equal(threads.total, 51);
  assert.equal(threads.truncated, true);
  assert.equal(threads.items[0].lastMessage.text, 'Hello');
  assert.equal(JSON.stringify(threads).includes(secret), false);
  const news = await portal.listNews({ child_id: 'child' });
  assert.equal(news.items[0].text, 'Hello');
  assert.equal(JSON.stringify(news).includes(secret), false);
});

test('large JSON replies are rejected before parsing', async () => {
  const portal = new Portal({
    sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async () => new Response('{}', { headers: { 'content-length': '3000000' } }),
  });
  await assert.rejects(portal.listChildren(), /for stort/);
  const streamed = new Portal({
    sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async () => new Response('x'.repeat(2_000_001)),
  });
  await assert.rejects(streamed.listChildren(), /for stort/);
});

test('attachments are saved privately and only their path is returned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vigilo-mcp-download-'));
  try {
    const portal = new Portal({
      downloadDir: directory,
      sessionProvider: async () => ({ accessToken: 'test' }),
      fetcher: async () => new Response(Buffer.from('%PDF-test'),
        { headers: { 'content-type': 'application/pdf' } }),
    });
    const result = await portal.getMessageAttachment({ thread_id: 'thread', attachment_id: 'attachment' });
    assert.equal(result.mimeType, 'application/pdf');
    assert.equal(result.size, 9);
    assert.equal(result.path, join(directory, 'thread_attachment.pdf'));
    assert.equal((await readFile(result.path)).toString(), '%PDF-test');
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
