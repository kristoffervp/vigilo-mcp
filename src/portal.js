import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDir, portalOrigin } from './browser.js';
import { currentSession } from './session.js';
import { refreshMobileSessionNow } from './mobile-auth.js';

const apiOrigin = `${portalOrigin}/api`;
const maxJsonBytes = 2_000_000;
const maxAttachmentBytes = 10_000_000;
const maxItems = 50;
const maxTextChars = 20_000;
const dayMs = 86_400_000;

function pick(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(keys.flatMap((key) => {
    const item = value[key];
    if (typeof item === 'string') return [[key, item.slice(0, 1_024)]];
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      return [[key, item]];
    }
    return [];
  }));
}

function person(value) {
  return pick(value, ['id', 'firstName', 'lastName', 'alias', 'communicatorType']);
}

function unit(value) {
  return pick(value, ['id', 'name', 'type']);
}

function attachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => pick(item, ['id', 'name', 'mimeType', 'size']));
}

function message(value) {
  const result = pick(value, ['id', 'createdAt', 'isDeleted']);
  const text = typeof value?.text === 'string' ? value.text : value?.body;
  if (typeof text === 'string') {
    result.text = text.slice(0, maxTextChars);
    if (text.length > maxTextChars) result.textTruncated = true;
  }
  if (value?.sender) result.sender = person(value.sender);
  if (Array.isArray(value?.attachments)) result.attachments = attachments(value.attachments);
  return result;
}

function threadSummary(value) {
  const result = pick(value, [
    'messageThreadId', 'title', 'createdAt', 'numberOfReplies', 'isRead',
    'hasAttachments', 'numberOfUnreadMessages', 'isDeleted',
  ]);
  if (value?.sender) result.sender = person(value.sender);
  if (value?.lastMessage) result.lastMessage = message(value.lastMessage);
  if (value?.child) result.child = person(value.child);
  return result;
}

function threadDetail(value) {
  const result = pick(value, [
    'messageThreadId', 'title', 'createdAt', 'numberOfUnreadMessages',
    'isReplyDisabled', 'isGroupMessageThread', 'isDeleted',
  ]);
  const all = Array.isArray(value?.messages) ? value.messages : [];
  result.messages = all.slice(-maxItems).map(message);
  result.totalMessages = all.length;
  result.truncated = all.length > maxItems;
  return result;
}

function newsItem(value) {
  const result = pick(value, [
    'id', 'newsFeedItemId', 'postId', 'title', 'heading',
    'createdAt', 'publishedAt', 'updatedAt',
  ]);
  const text = value?.text ?? value?.body ?? value?.content ?? value?.description;
  if (typeof text === 'string') {
    result.text = text.slice(0, maxTextChars);
    if (text.length > maxTextChars) result.textTruncated = true;
  }
  if (value?.author) result.author = person(value.author);
  if (value?.sender) result.sender = person(value.sender);
  if (value?.organizationalUnit) result.organizationalUnit = unit(value.organizationalUnit);
  if (Array.isArray(value?.attachments)) result.attachments = attachments(value.attachments);
  return result;
}

function segment(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`Ugyldig ${name}.`);
  }
  return value;
}

function dateValue(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} må være på format YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} må være en gyldig dato.`);
  }
  return value;
}

function osloToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dateRange(fromDate, toDate) {
  const from = dateValue(fromDate, 'from_date') || new Date(Date.now() - 90 * dayMs).toISOString().slice(0, 10);
  const to = dateValue(toDate, 'to_date') || new Date(Date.now() + dayMs).toISOString().slice(0, 10);
  const span = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  if (span < 0) throw new Error('from_date må være før to_date.');
  if (span > 366 * dayMs) throw new Error('Datoperioden kan ikke være lengre enn 366 dager.');
  return { fromDate: from, toDate: to };
}

async function limitedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxJsonBytes) throw new Error('Vigilo-svaret er for stort. Bruk en kortere datoperiode.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > maxJsonBytes) throw new Error('Vigilo-svaret er for stort. Bruk en kortere datoperiode.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new Error('Vigilo sendte et uventet svar.'); }
}

export class Portal {
  #sessionProvider;
  #fetcher;
  #downloadDir;

  constructor({ sessionProvider = currentSession, fetcher = fetch,
    downloadDir = join(dataDir, 'downloads') } = {}) {
    this.#sessionProvider = sessionProvider;
    this.#fetcher = fetcher;
    this.#downloadDir = downloadDir;
  }

  async #request(path, query, { binary = false } = {}) {
    let session = await this.#sessionProvider();
    const url = new URL(`${apiOrigin}${path}`);
    if (url.origin !== portalOrigin || !url.pathname.startsWith('/api/')) throw new Error('Ugyldig Vigilo-adresse.');
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const send = async () => {
      try {
        return await this.#fetcher(url, {
          headers: { Authorization: `Bearer ${session.accessToken}`, Accept: binary ? '*/*' : 'application/json' },
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new Error('Kunne ikke kontakte Vigilo. Kontroller nettverket og prøv igjen.'); }
    };
    let response = await send();
    if (response.status === 401 && session.refreshToken) {
      session = await refreshMobileSessionNow(session);
      response = await send();
    }
    if (response.status === 401) throw new Error('Vigilo-økten er utløpt. Kjør npm run login på nytt.');
    if (!response.ok) throw new Error(`Vigilo svarte med HTTP ${response.status}.`);
    if (binary) return response;
    return limitedJson(response);
  }

  async listChildren() {
    const data = await this.#request('/children/my');
    if (!Array.isArray(data?.items)) throw new Error('Uventet svar for barn.');
    return data.items.slice(0, maxItems).map((child) => ({
      ...pick(child, ['id', 'firstName', 'lastName', 'type']),
      organizationalUnits: Array.isArray(child.organizationalUnits)
        ? child.organizationalUnits.slice(0, maxItems).map(unit) : [],
    }));
  }

  async listMessageThreads({ child_id, from_date, to_date, include_after_school = true } = {}) {
    const childId = segment(child_id, 'child_id');
    if (typeof include_after_school !== 'boolean') throw new Error('include_after_school må være true eller false.');
    const data = await this.#request('/message-threads', {
      childIds: childId,
      ...dateRange(from_date, to_date),
      includeAfterSchoolMessages: String(include_after_school),
    });
    if (!Array.isArray(data?.items)) throw new Error('Uventet svar for meldingstråder.');
    return { items: data.items.slice(0, maxItems).map(threadSummary),
      total: data.items.length, truncated: data.items.length > maxItems };
  }

  async getMessageThread({ child_id, thread_id } = {}) {
    const childId = segment(child_id, 'child_id');
    const threadId = segment(thread_id, 'thread_id');
    return threadDetail(await this.#request(`/message-threads/${threadId}`, { childPersonId: childId }));
  }

  async listNews({ child_id, from_date, to_date } = {}) {
    const childId = segment(child_id, 'child_id');
    const data = await this.#request('/news-feed', { childIds: childId, ...dateRange(from_date, to_date) });
    if (!Array.isArray(data)) throw new Error('Uventet svar for oppslag.');
    return { items: data.slice(0, maxItems).map(newsItem),
      total: data.length, truncated: data.length > maxItems };
  }

  async getAfterSchoolStatus({ child_id, date } = {}) {
    const childId = segment(child_id, 'child_id');
    const selectedDate = dateValue(date, 'date') || osloToday();
    const data = await this.#request(`/children/${childId}/overview`, { date: selectedDate });
    if (!Array.isArray(data?.checkIns)) throw new Error('Uventet svar for inn- og utsjekk.');
    const events = data.checkIns.filter((event) =>
      (event?.type === 'checkIn' || event?.type === 'checkOut') &&
      typeof event.time === 'string' && Number.isFinite(Date.parse(event.time)));
    events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const last = events.at(-1);
    return {
      date: selectedDate,
      status: last ? (last.type === 'checkIn' ? 'checked_in' : 'checked_out') : 'unknown',
      lastRegistrationAt: last?.time || null,
      registeredEvents: events.length,
    };
  }

  async getMessageAttachment({ thread_id, attachment_id } = {}) {
    const threadId = segment(thread_id, 'thread_id');
    const attachmentId = segment(attachment_id, 'attachment_id');
    const response = await this.#request(`/message-threads/${threadId}/attachments/${attachmentId}`, null, { binary: true });
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxAttachmentBytes) throw new Error('Vedlegget er større enn 10 MB.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.byteLength;
      if (size > maxAttachmentBytes) throw new Error('Vedlegget er større enn 10 MB.');
      chunks.push(chunk);
    }
    if (size === 0) throw new Error('Vedlegget var tomt.');
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase() || 'application/octet-stream';
    if (mimeType === 'text/html') throw new Error('Vigilo sendte en innloggingsside i stedet for vedlegget.');
    const extension = new Map([
      ['application/pdf', '.pdf'], ['image/jpeg', '.jpg'], ['image/png', '.png'],
      ['text/plain', '.txt'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    ]).get(mimeType) || '.bin';
    const directory = this.#downloadDir;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, `${threadId}_${attachmentId}${extension}`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, Buffer.concat(chunks, size), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    return { path, mimeType, size };
  }
}
