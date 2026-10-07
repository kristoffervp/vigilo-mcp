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
  await assert.rejects(portal.getAfterSchoolStatus({ child_id: '../other' }), /child_id/);
  await assert.rejects(portal.getAfterSchoolStatus({ child_id: 'safe', date: '2026-02-30' }), /date/);
  await assert.rejects(portal.getSchedule({ child_id: '../other' }), /child_id/);
  await assert.rejects(portal.getSchedule({ child_id: 'safe', date: '2026-02-30' }), /date/);
  await assert.rejects(portal.getSchedule({ child_id: 'safe', school_unit_id: '../other' }), /school_unit_id/);
});

test('schedule combines lessons and events for the ISO week without extra private fields', async () => {
  const paths = [];
  const portal = new Portal({
    sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async (url) => {
      paths.push([url.pathname, url.searchParams.get('week'), url.searchParams.get('organizationalUnitId')]);
      if (url.pathname.endsWith('/children/my')) return new Response(JSON.stringify({ items: [
        { id: 'child', organizationalUnits: [{ id: 'school', type: 'school', name: 'School' }] },
      ] }));
      if (url.pathname.endsWith('/lessons')) return new Response(JSON.stringify([{
        dayOfWeek: 1, startTime: '08:30:00', endTime: '09:15:00',
        subject: { name: 'Mathematics', secret: 'PRIVATE' },
        group: { name: '3A', secret: 'PRIVATE' }, room: { name: '101' },
        employee: { alias: 'Teacher', firstName: 'PRIVATE' }, secret: 'PRIVATE',
      }]));
      return new Response(JSON.stringify([{ dayOfWeek: 2, startTime: '10:00:00',
        endTime: '11:00:00', description: 'Assembly', secret: 'PRIVATE' }]));
    },
  });
  const result = await portal.getSchedule({ child_id: 'child', date: '2027-01-01' });
  assert.deepEqual(paths, [
    ['/api/children/my', null, null],
    ['/api/students/child/lessons', '2026-53', 'school'],
    ['/api/scheduling-events/child/student', '2026-53', 'school'],
  ]);
  assert.equal(result.week, '2026-53');
  assert.equal(result.items[0].date, '2026-12-28');
  assert.equal(result.items[0].title, 'Mathematics');
  assert.equal(result.items[1].date, '2026-12-29');
  assert.equal(result.items[1].kind, 'event');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('schedule rejects a school unit not attached to the child', async () => {
  let calls = 0;
  const portal = new Portal({
    sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async () => { calls++; return new Response(JSON.stringify({ items: [
      { id: 'child', organizationalUnits: [{ id: 'school', type: 'school' }] },
    ] })); },
  });
  await assert.rejects(portal.getSchedule({ child_id: 'child', school_unit_id: 'other' }), /skoleenhet/);
  assert.equal(calls, 1);
});

test('AKS status uses the latest valid registration and never exposes unrelated fields', async () => {
  let requestedUrl;
  const portal = new Portal({
    sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ checkIns: [
        { type: 'checkOut', time: '2026-10-07T15:00:00+02:00', privateNote: 'SECRET' },
        { type: 'checkIn', time: '2026-10-07T08:00:00+02:00' },
        { type: 'other', time: '2026-10-07T16:00:00+02:00' },
      ], routines: [{ privateNote: 'SECRET' }] }));
    },
  });
  const result = await portal.getAfterSchoolStatus({ child_id: 'child', date: '2026-10-07' });
  assert.equal(requestedUrl.pathname, '/api/children/child/overview');
  assert.equal(requestedUrl.searchParams.get('date'), '2026-10-07');
  assert.deepEqual(result, { date: '2026-10-07', status: 'checked_out',
    lastRegistrationAt: '2026-10-07T15:00:00+02:00', registeredEvents: 2 });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('AKS status is unknown when no check-in or check-out is registered', async () => {
  const portal = new Portal({
    sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async () => new Response(JSON.stringify({ checkIns: [] })),
  });
  const result = await portal.getAfterSchoolStatus({ child_id: 'child', date: '2026-10-07' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.lastRegistrationAt, null);
  assert.equal(result.registeredEvents, 0);
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
