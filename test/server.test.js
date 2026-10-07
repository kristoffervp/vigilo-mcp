import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('MCP server initializes and marks the local download separately', async () => {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url).pathname });
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
  assert.deepEqual(replies[1].result.tools.map((tool) => tool.name), [
    'list_children', 'list_message_threads', 'get_message_thread', 'list_news',
    'get_after_school_status', 'get_message_attachment',
  ]);
  assert.ok(replies[1].result.tools.slice(0, 5).every((tool) => tool.annotations.readOnlyHint));
  assert.equal(replies[1].result.tools[5].annotations.readOnlyHint, false);
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
    assert.equal(replies[0].error.message, 'Request too large');
    assert.deepEqual(replies[1].result, {});
    assert.equal(replies[2].result.isError, true);
    assert.equal(replies[2].result.content[0].text, 'Vigilo-kallet kunne ikke fullføres.');
    assert.equal(JSON.stringify(replies).includes('SENSITIVE-TEST-TOKEN'), false);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
