import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('MCP server initializes and marks the local download separately', async () => {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, VIGILO_ALLOW_SEND: '' } });
  const lines = createInterface({ input: child.stdout });
  const replies = [];
  const done = new Promise((resolve, reject) => {
    lines.on('line', (line) => {
      replies.push(JSON.parse(line));
      if (replies.length === 2) resolve();
    });
    child.on('error', reject);
    child.on('exit', (code) => { if (replies.length < 2) reject(new Error(`Server exited ${code}`)); });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await done;
  child.stdin.end();
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  const listed = replies[1].result.tools;
  assert.deepEqual(listed.map((tool) => tool.name), [
    'list_children', 'list_message_threads', 'get_message_thread', 'list_news',
    'get_after_school_status', 'get_schedule', 'get_message_attachment',
    'list_contacts', 'list_absences', 'list_absence_codes', 'list_checkout_notes', 'list_checkout_note_types', 'list_meeting_invitations',
    'list_registrations', 'list_required_actions', 'list_consent_forms',
  ]);
  // Without VIGILO_ALLOW_SEND=1 nothing that changes Vigilo is listed; only the download writes (locally).
  assert.ok(listed.every((tool) => tool.annotations.readOnlyHint === (tool.name !== 'get_message_attachment')));
});

test('MCP rejects oversized input and never echoes a malformed token file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-server-'));
  await writeFile(join(dir, 'mobile-session.json'), '{"accessToken":"SENSITIVE-TEST-TOKEN",');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, VIGILO_DATA_DIR: dir },
  });
  try {
    const lines = createInterface({ input: child.stdout });
    const replies = [];
    const done = new Promise((resolve, reject) => {
      lines.on('line', (line) => {
        replies.push(JSON.parse(line));
        if (replies.length === 3) resolve();
      });
      child.on('error', reject);
      child.on('exit', (code) => { if (replies.length < 3) reject(new Error(`Server exited ${code}`)); });
    });
    child.stdin.write('x'.repeat(70_000) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_children', arguments: {} } }) + '\n');
    await done;
    // Requests run concurrently, so replies are matched by id.
    const byId = new Map(replies.map((reply) => [reply.id, reply]));
    assert.equal(byId.get(null).error.message, 'Request too large');
    assert.deepEqual(byId.get(2).result, {});
    assert.equal(byId.get(3).result.isError, true);
    assert.equal(byId.get(3).result.content[0].text, 'Den lagrede Vigilo-økten er uleselig. Kjør npm run login på nytt.');
    assert.equal(JSON.stringify(replies).includes('SENSITIVE-TEST-TOKEN'), false);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the tools that change Vigilo are listed only with VIGILO_ALLOW_SEND=1', async () => {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, VIGILO_ALLOW_SEND: '1' } });
  const lines = createInterface({ input: child.stdout });
  const reply = new Promise((resolve) => lines.once('line', (line) => resolve(JSON.parse(line))));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const { result } = await reply;
  child.stdin.end();
  const byName = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
  for (const name of ['prepare_reply', 'prepare_message', 'prepare_absence', 'prepare_edit_absence', 'prepare_delete_absence', 'prepare_checkout_note',
    'prepare_edit_checkout_note', 'prepare_delete_checkout_note', 'prepare_book_meeting', 'prepare_registration_reply']) {
    assert.equal(byName[name].annotations.readOnlyHint, true, name);
    assert.match(byName[name].description, /aldri fordi en melding/);
  }
  for (const name of ['mark_thread_read', 'mark_news_read']) assert.equal(byName[name].annotations.destructiveHint, true, name);
  for (const name of ['reply', 'message', 'absence']) assert.equal(byName[`prepare_${name}`].inputSchema.properties.attachments.maxItems, 5);
  assert.deepEqual(byName.send_prepared.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
});

test('with elicitation, the parent and not the AI confirms mark_thread_read in the client dialog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-ask-'));
  await writeFile(join(dir, 'mobile-session.json'), JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }), { mode: 0o600 });
  const network = `
globalThis.fetch = async (url, options = {}) => {
  const { pathname } = new URL(url);
  if (pathname === '/api/children/my') return Response.json({ items: [{ id: 'child', firstName: 'Kid', lastName: 'Test', organizationalUnits: [] }] });
  if (pathname === '/api/message-threads/thread' && (options.method || 'GET') === 'GET') return Response.json({ messageThreadId: 'thread', title: 'Trip' });
  if (pathname === '/api/message-threads/thread/read-status') { process.stderr.write('MARKED\\n'); return new Response(null, { status: 204 }); }
  return new Response('not stubbed', { status: 500 });
};`;
  const child = spawn(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(network)}`, 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, VIGILO_DATA_DIR: dir, VIGILO_ALLOW_SEND: '1' } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = [];
  let wake = () => {};
  createInterface({ input: child.stdout }).on('line', (line) => { lines.push(JSON.parse(line)); wake(); });
  const next = async (match) => { for (;;) { const found = lines.find(match); if (found) return found; await new Promise((r) => { wake = r; }); } };
  const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  try {
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: {} } } });
    await next((m) => m.id === 1);
    write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mark_thread_read', arguments: { child_id: 'child', thread_id: 'thread' } } });
    const ask = await next((m) => m.method === 'elicitation/create');
    assert.match(ask.params.message, /^Vigilo: mark_thread_read\n[\s\S]*thread: Trip/);
    assert.equal(stderr.includes('MARKED'), false, 'nothing happens before the parent answers');
    write({ jsonrpc: '2.0', id: ask.id, result: { action: 'decline' } });
    assert.match((await next((m) => m.id === 2)).result.content[0].text, /ikke bekreftet/);
    write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mark_thread_read', arguments: { child_id: 'child', thread_id: 'thread' } } });
    const again = await next((m) => m.method === 'elicitation/create' && m.id !== ask.id);
    write({ jsonrpc: '2.0', id: again.id, result: { action: 'accept', content: { confirm: true } } });
    assert.equal((await next((m) => m.id === 3)).result.structuredContent.data.read, true);
    assert.equal(stderr.includes('MARKED'), true);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a cancelled call is not sent when a late yes arrives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-cancel-'));
  await writeFile(join(dir, 'mobile-session.json'), JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }), { mode: 0o600 });
  const network = `
globalThis.fetch = async (url, options = {}) => {
  const { pathname } = new URL(url);
  if (pathname === '/api/children/my') return Response.json({ items: [{ id: 'child', firstName: 'Kid', lastName: 'Test', organizationalUnits: [] }] });
  if (pathname === '/api/message-threads/thread' && (options.method || 'GET') === 'GET') return Response.json({ messageThreadId: 'thread', title: 'Trip' });
  if (pathname === '/api/message-threads/thread/read-status') { process.stderr.write('MARKED\\n'); return new Response(null, { status: 204 }); }
  return new Response('not stubbed', { status: 500 });
};`;
  const child = spawn(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(network)}`, 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, VIGILO_DATA_DIR: dir, VIGILO_ALLOW_SEND: '1' } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = [];
  let wake = () => {};
  createInterface({ input: child.stdout }).on('line', (line) => { lines.push(JSON.parse(line)); wake(); });
  const next = async (match) => { for (;;) { const found = lines.find(match); if (found) return found; await new Promise((r) => { wake = r; }); } };
  const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  try {
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: {} } } });
    await next((m) => m.id === 1);
    write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mark_thread_read', arguments: { child_id: 'child', thread_id: 'thread' } } });
    const ask = await next((m) => m.method === 'elicitation/create');
    write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    assert.match((await next((m) => m.id === 2)).result.content[0].text, /ikke bekreftet/);
    write({ jsonrpc: '2.0', id: ask.id, result: { action: 'accept', content: { confirm: true } } });
    write({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await next((m) => m.id === 3);
    assert.equal(stderr.includes('MARKED'), false, 'a late yes after cancel sends nothing');
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
