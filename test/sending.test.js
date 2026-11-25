import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from '../src/browser.js';
import { Portal } from '../src/portal.js';
import { Sender } from '../src/sending.js';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(new Date());
const plus = (days) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// The next Monday at least a week ahead, so check-out notes land on weekdays.
const monday = (() => { for (let d = 7; ; d++) if (new Date(`${plus(d)}T12:00:00Z`).getUTCDay() === 1) return plus(d); })();
const later = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const nor = (iso) => iso.split('-').reverse().join('.');

const children = { items: [{ id: 'child', firstName: 'Kid', lastName: 'Test', organizationalUnits: [
  { id: 'school', name: 'Test School', type: 'school', groups: [{ name: '3A' }], hasCommunicationLicense: true, isActive: true },
  { id: 'aks', name: 'Test AKS', type: 'afterSchool', hasCommunicationLicense: true, isActive: true },
  { id: 'nursery', name: 'Test Nursery', type: 'childcare' },
] }, { id: 'sibling', firstName: 'Sib', lastName: 'Test', organizationalUnits: [] }] };
const contacts = { relatedEmployees: [
  { id: 'teacher', firstName: 'Tea', lastName: 'Cher', relationType: 'contactTeacher', groupName: '3A' },
  { id: 'subject', firstName: 'Sub', lastName: 'Ject', relationType: 'subjectTeacher' },
], otherEmployees: [{ id: 'other', firstName: 'Oth', lastName: 'Er', jobTitle: 'Rektor' }], legalGuardians: [{ id: 'guardian', firstName: 'Gu', lastName: 'Ardian' }] };
const note1 = { id: 'n1', type: { name: 'Går hjem alene' }, timeOfDay: '15:00:00', fromDate: monday, toDate: later(monday, 1),
  isRecurring: false, noteText: 'Ringer hjem', childPersonIds: ['child'] };

// Tests never write to the real .data/ folder.
const testLog = join(tmpdir(), `vigilo-mcp-test-${process.pid}.jsonl`);
test.after(() => rm(testLog, { force: true }));

function fake(overrides = {}, { log = testLog, confirm, now } = {}) {
  const calls = [];
  const routes = {
    'GET /children/my': children,
    'GET /messages/contact-list/children/child': contacts,
    'GET /message-threads/thread': { messageThreadId: 'thread', title: 'Trip on Friday', isReplyDisabled: false,
      messages: [{ sender: { firstName: 'Tea', lastName: 'Cher' } }] },
    'GET /message-threads/closed': { messageThreadId: 'closed', title: 'Notice', isReplyDisabled: true },
    'GET /message-threads/group': { messageThreadId: 'group', title: 'Class 3A', isGroupMessageThread: true },
    'GET /absencecodes': { items: [{ organizationalUnitId: 'school', codes: [{ id: 'sick', name: 'Sykdom' }] },
      { organizationalUnitId: 'aks', codes: [] }] },
    'GET /absences': { absences: [
      { absenceId: 'a1', organizationalUnit: { id: 'aks', name: 'Test AKS', type: 'afterSchool' }, fromDate: plus(2), toDate: plus(3),
        isDeletable: true, absenceCode: { name: 'Fri' }, note: 'Besteforeldre' },
      { absenceId: 'a2', organizationalUnit: { id: 'school', name: 'Test School', type: 'school' }, fromDate: plus(1), toDate: plus(2), isDeletable: false },
      { absenceId: 'a3', organizationalUnit: { id: 'aks', type: 'afterSchool' }, fromDate: 'bad', toDate: 'not a date' },
    ] },
    'GET /check-in-note-types': { items: [{ id: 'alone', name: 'Går hjem alene' }, { id: 'pickup', name: 'Hentes av' }] },
    'GET /check-in-note-configuration/registration-deadlines': { earliestAllowedDate: `${plus(1)}T00:00:00` },
    'GET /check-in-notes': { items: [note1] },
    'GET /forms/meetings/invitations/child': { items: [{ id: 'm1', title: 'Utviklingssamtale', registrationDeadline: `${plus(5)}T12:00:00Z`,
      reply: { meetingOccurrenceId: 'o3' },
      meetingOccurrences: [{ meetingOccurrenceId: 'o1', startTime: `${plus(6)}T07:00:00Z`, endTime: `${plus(6)}T07:20:00Z`, isAvailable: true },
        { meetingOccurrenceId: 'o2', startTime: `${plus(6)}T08:20:00`, endTime: `${plus(6)}T08:40:00`, isAvailable: false },
        { meetingOccurrenceId: 'o3', startTime: `${plus(7)}T09:00:00`, endTime: `${plus(7)}T09:20:00`, isAvailable: false }] }] },
    'GET /current-user': { person: { id: 'parent' } },
    ...overrides,
  };
  const portal = { call: async (method, path, options = {}) => {
    calls.push({ method, path, ...options });
    const route = routes[`${method} ${path}`];
    if (route === undefined) return method === 'GET' ? null : { ok: true };
    return typeof route === 'function' ? route(options) : structuredClone(route);
  } };
  const writes = () => calls.filter((call) => call.method !== 'GET');
  const sender = new Sender({ portal, log, ...(confirm ? { confirm } : {}), ...(now ? { now } : {}) });
  const send = (prepared) => sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  return { sender, send, calls, writes };
}

test('a prepare tool sends nothing, and send_prepared sends exactly that request once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-send-'));
  try {
    const log = join(dir, 'sent.jsonl');
    const { sender, send, writes } = fake({}, { log });
    const prepared = await sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Ja,​ hun blir med.' });
    assert.equal(writes().length, 0);
    assert.deepEqual([prepared.thread, prepared.writtenInThreadBy, prepared.text], ['Trip on Friday', ['Tea Cher'], 'Ja, hun blir med.']);
    assert.match(prepared.confirmationCode, /^[0-9a-f]{8}$/);
    assert.equal((await send(prepared)).sent, true);
    assert.deepEqual(writes(), [{ method: 'POST', path: '/message-threads/thread/reply',
      body: { body: 'Ja, hun blir med.', attachments: [] }, query: undefined, headers: undefined }]);
    await assert.rejects(send(prepared), /Ukjent eller utløpt/);
    assert.equal(writes().length, 1);
    assert.equal((await stat(log)).mode & 0o777, 0o600);
    const logged = await readFile(log, 'utf8');
    assert.match(logged, /"action":"reply"/);
    assert.equal(/Bearer|accessToken|confirmationCode|"summary"/.test(logged), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('send_prepared needs the summary exactly as prepared, and a code expires after ten minutes', async () => {
  let now = Date.now();
  const { sender, send, writes } = fake({}, { now: () => now });
  const prepared = await sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Hun kommer   ikke\nHilsen' });
  assert.equal(prepared.summary, 'reply · Kid Test · Trip on Friday · «Hun kommer ikke Hilsen»');
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode }), /summary stemmer ikke/);
  await assert.rejects(sender.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: 'reply' }), /summary stemmer ikke/);
  now += 10 * 60_000 + 1;
  await assert.rejects(send(prepared), /utløpt/);
  assert.equal(writes().length, 0);
});

test('the same request prepared again replaces the older code', async () => {
  const { sender, send } = fake();
  const first = await sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Hei' });
  const second = await sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Hei' });
  await assert.rejects(send(first), /Ukjent eller utløpt/);
  assert.equal((await send(second)).sent, true);
});

test('the parent confirms in the dialog: a no sends nothing and uses up the code', async () => {
  const questions = [];
  const { sender, send, writes } = fake({}, { confirm: async (message) => { questions.push(message); return false; } });
  const prepared = await sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Hei' });
  await assert.rejects(send(prepared), /ikke bekreftet/);
  await assert.rejects(send(prepared), /Ukjent eller utløpt/);
  await assert.rejects(sender.markThreadRead({ child_id: 'child', thread_id: 'thread' }), /ikke bekreftet/);
  assert.equal(writes().length, 0);
  assert.match(questions[0], /^Vigilo: reply\n.*thread: Trip on Friday.*text: Hei/s);
  assert.match(questions[1], /^Vigilo: mark_thread_read\n/);
});

test('replies, messages and units are checked against the account', async () => {
  const { sender, send, writes } = fake();
  await assert.rejects(sender.prepareReply({ child_id: 'child', thread_id: 'closed', text: 'Hei' }), /slått av/);
  await assert.rejects(sender.prepareReply({ child_id: 'child', thread_id: 'group', text: 'Hei' }), /gruppetråd/);
  await assert.rejects(sender.prepareReply({ child_id: 'someone-else', thread_id: 'thread', text: 'Hei' }), /finnes ikke/);
  await assert.rejects(sender.prepareReply({ child_id: '../child', thread_id: 'thread', text: 'Hei' }), /child_id/);
  await assert.rejects(sender.prepareMessage({ child_id: 'child', unit_id: 'other-unit', recipient_ids: ['teacher'], title: 'T', text: 'B' }), /hører ikke/);
  await assert.rejects(sender.prepareMessage({ child_id: 'child', unit_id: 'school', recipient_ids: ['guardian'], title: 'T', text: 'B' }), /list_contacts/);
  const message = await sender.prepareMessage({ child_id: 'child', unit_id: 'school', recipient_ids: ['teacher', 'other'], title: 'Spørsmål', text: 'Hei' });
  assert.deepEqual(message.to, ['Tea Cher (kontaktlærer, 3A)', 'Oth Er (Rektor)']);
  await send(message);
  assert.deepEqual(writes()[0].body.recipients, [{ type: 'client', externalId: 'child', readOnly: false },
    { type: 'employee', externalId: 'teacher', readOnly: false }, { type: 'employee', externalId: 'other', readOnly: false }]);
});

test('absences go to the contact teachers at school and to AKS by child, with an exclusive end date', async () => {
  const { sender, send, writes } = fake();
  await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(-1) }), /tilbake i tid/);
  await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(1) }), /fraværskode/);
  await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'nursery', from_date: plus(1) }), /denne enheten/);
  await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'aks', from_date: plus(2), to_date: plus(1) }), /før from_date/);
  const school = await sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(1), absence_code_id: 'sick' });
  assert.deepEqual(school.to, ['Tea Cher (kontaktlærer, 3A)']);
  const aks = await sender.prepareAbsence({ child_id: 'child', unit_id: 'aks', from_date: plus(1), to_date: plus(2), note: 'Hos besteforeldre' });
  await send(school);
  await send(aks);
  const [toSchool, toAks] = writes();
  assert.equal(toSchool.path, '/student-absences');
  assert.deepEqual(toSchool.body, { absenceCodeId: 'sick', organizationalUnitId: 'school', attachments: [], note: '', fromDate: plus(1),
    toDate: plus(2), childId: 'child', title: 'Fravær for Kid Test, 3A', recipients: [{ type: 'Employee', externalId: 'teacher' }] });
  assert.equal(toAks.path, '/after-school-absences');
  assert.equal(toAks.body.childPersonId, 'child');
  assert.equal(toAks.body.toDate, plus(3));
  assert.equal('recipients' in toAks.body, false);
});

test('a sent absence is read back from Vigilo as verified', async () => {
  let stored = [];
  const { sender, send } = fake({ 'GET /absences': () => ({ absences: stored }) });
  const prepared = await sender.prepareAbsence({ child_id: 'child', unit_id: 'aks', from_date: plus(1), to_date: plus(2) });
  assert.equal((await send(prepared)).verified, false);
  const again = await sender.prepareAbsence({ child_id: 'child', unit_id: 'aks', from_date: plus(1), to_date: plus(2) });
  stored = [{ absenceId: 'x', organizationalUnit: { id: 'aks', type: 'afterSchool' }, fromDate: plus(1), toDate: plus(3) }];
  assert.equal((await send(again)).verified, true);
});

test('a school without a contact teacher, and an absence that is not deletable, are refused', async () => {
  const noTeacher = fake({ 'GET /messages/contact-list/children/child': { relatedEmployees: [] } });
  await assert.rejects(noTeacher.sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(1), absence_code_id: 'sick' }), /kontaktlærer/);
  const { sender, send, writes } = fake();
  await assert.rejects(sender.prepareDeleteAbsence({ child_id: 'child', absence_id: 'a2' }), /slettes/);
  const removal = await sender.prepareDeleteAbsence({ child_id: 'child', absence_id: 'a1' });
  assert.deepEqual([removal.dates, removal.code, removal.noteText], [nor(plus(2)), 'Fri', 'Besteforeldre']);
  await send(removal);
  assert.deepEqual(writes()[0], { method: 'DELETE', path: '/after-school-absences/a1', query: { organizationalUnitId: 'aks' },
    body: undefined, headers: undefined });
  // A malformed date from Vigilo is left out instead of failing.
  const listed = await sender.listAbsences({ child_id: 'child' });
  assert.deepEqual([listed.absences[2].fromDate, listed.absences[2].toDate], [undefined, undefined]);
});

test('check-out notes need a known type, a quarter hour in AKS hours, weekdays and the AKS deadline', async () => {
  const { sender, send, writes } = fake();
  const base = { child_id: 'child', unit_id: 'aks', type_id: 'alone', from_date: monday, time: '15:00' };
  await assert.rejects(sender.prepareCheckoutNote({ ...base, unit_id: 'school' }), /denne enheten/);
  await assert.rejects(sender.prepareCheckoutNote({ ...base, type_id: 'unknown' }), /list_checkout_note_types/);
  for (const time of ['15:10', '18:15', '06:45']) await assert.rejects(sender.prepareCheckoutNote({ ...base, time }), /kvarter/);
  await assert.rejects(sender.prepareCheckoutNote({ ...base, from_date: later(monday, 5) }), /hverdag/);
  await assert.rejects(sender.prepareCheckoutNote({ ...base, weekdays: ['monday'] }), /to_date/);
  await assert.rejects(sender.prepareCheckoutNote({ ...base, to_date: later(monday, 14) }), /weekdays/);
  const late = fake({ 'GET /check-in-note-configuration/registration-deadlines': { earliestAllowedDate: later(monday, 1) } });
  await assert.rejects(late.sender.prepareCheckoutNote(base), /Fristen er passert/);
  const weekly = await sender.prepareCheckoutNote({ ...base, type_id: 'pickup', to_date: later(monday, 25), weekdays: ['wednesday', 'monday'], note: 'Bestemor' });
  assert.equal(weekly.repeats, 'hver uke: mandag, onsdag (8 dager)');
  assert.deepEqual(weekly.conflicts, [`15:00 Går hjem alene: Ringer hjem (${nor(monday)})`]);
  assert.equal(weekly.noteText, 'Bestemor');
  assert.match(weekly.summary, /«Bestemor»$/);
  assert.equal(weekly.summary, `checkout_note · Kid Test · Hentes av · ${nor(monday)}–${nor(later(monday, 25))} · 15:00 · hver uke: mandag, onsdag (8 dager) · Test AKS · «Bestemor»`);
  assert.match(weekly.warning, /hentes eller gå hjem/);
  assert.equal((await send(weekly)).verified, false);
  assert.deepEqual(writes()[0], { method: 'POST', path: '/check-in-notes', headers: { 'x-organizational-unit-id': 'aks' }, query: undefined,
    body: { childPersonIds: ['child'], category: 'afterSchoolCheckOut', typeId: 'pickup', fromDate: monday, toDate: later(monday, 26),
      timeOfDay: '15:00:00', recurrencePattern: { recurrenceType: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'] },
      noteText: 'Bestemor' } });
  assert.equal((await sender.prepareCheckoutNote({ ...base, to_date: later(monday, 1) })).repeats, 'hver dag (2 dager)');
});

test('deleting a check-out note shows the whole note, and names every child it covers', async () => {
  const { sender } = fake();
  await assert.rejects(sender.prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'missing' }), /Fant ikke/);
  const removal = await sender.prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1' });
  assert.deepEqual([removal.children, removal.type, removal.time, removal.noteText], [['Kid Test'], 'Går hjem alene', '15:00', 'Ringer hjem']);
  assert.match(removal.deletes, /Hele hentemeldingen/);
  assert.match(removal.warning, /forlater AKS/);
  const shared = fake({ 'GET /check-in-notes': { items: [{ ...note1, childPersonIds: ['child', 'sibling'] }] } });
  assert.deepEqual((await shared.sender.prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1' })).children, ['Kid Test', 'Sib Test']);
  const foreign = fake({ 'GET /check-in-notes': { items: [{ ...note1, childPersonIds: ['child', 'stranger'] }] } });
  await assert.rejects(foreign.sender.prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1' }), /ikke er på kontoen/);
});

test('a meeting time must be free and in the invitation, and the preview shows the time it replaces', async () => {
  const { sender, send, writes } = fake();
  await assert.rejects(sender.prepareBookMeeting({ child_id: 'child', meeting_id: 'm1', occurrence_id: 'o2' }), /opptatt/);
  await assert.rejects(sender.prepareBookMeeting({ child_id: 'child', meeting_id: 'm1', occurrence_id: 'o9' }), /hører ikke/);
  const passed = fake({ 'GET /forms/meetings/invitations/child': { items: [{ id: 'm1', registrationDeadline: `${plus(-1)}T12:00:00Z`,
    meetingOccurrences: [{ meetingOccurrenceId: 'o1', isAvailable: true }] }] } });
  await assert.rejects(passed.sender.prepareBookMeeting({ child_id: 'child', meeting_id: 'm1', occurrence_id: 'o1' }), /Fristen/);
  const booking = await sender.prepareBookMeeting({ child_id: 'child', meeting_id: 'm1', occurrence_id: 'o1' });
  // 07:00Z is 08:00 or 09:00 in Norway, depending on daylight saving time.
  assert.match(booking.start, new RegExp(`^${plus(6)} 0[89]:00$`));
  assert.equal(booking.replaces, `${plus(7)} 09:00–${plus(7)} 09:20`);
  await send(booking);
  assert.deepEqual(writes()[0].body, { childPersonId: 'child', meetingOccurrenceId: 'o1', inviteePersonId: 'parent' });
});

test('marking a thread read checks the thread belongs to the child and is logged', async () => {
  const { sender, writes } = fake({ 'GET /message-threads/foreign': null });
  await assert.rejects(sender.markThreadRead({ child_id: 'child', thread_id: 'foreign' }), /Fant ikke/);
  assert.deepEqual(await sender.markThreadRead({ child_id: 'child', thread_id: 'thread' }), { child: 'Kid Test', thread: 'Trip on Friday', read: true });
  assert.deepEqual(writes(), [{ method: 'PUT', path: '/message-threads/thread/read-status', body: { isRead: true } }]);
  assert.match(await readFile(testLog, 'utf8'), /"action":"mark_thread_read"/);
});

test('an uncertain outcome says it may have been sent, and is logged as uncertain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-uncertain-'));
  try {
    const log = join(dir, 'sent.jsonl');
    const lost = new Error('Fikk ikke et sikkert svar fra Vigilo. Det kan være sendt.');
    lost.uncertain = true;
    const { sender, send } = fake({ 'POST /message-threads/thread/reply': () => { throw lost; } }, { log });
    await assert.rejects(send(await sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Hei' })), /kan være sendt/);
    assert.match(await readFile(log, 'utf8'), /"outcome":"uncertain"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a write sends JSON with the same checks as reads; lost answers are uncertain and a refusal names only a safe code', async () => {
  const calls = [];
  const replies = { PUT: () => new Response(null, { status: 204 }),
    POST: () => new Response(JSON.stringify({ errorCode: 'absence_dates_overlapped_by_absence', detail: 'SECRET' }), { status: 400 }),
    DELETE: () => new Response('', { status: 503 }), PATCH: () => { throw new TypeError('network'); } };
  const portal = new Portal({ sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async (url, options) => { calls.push({ url, options }); return replies[options.method](); } });
  assert.equal(await portal.call('PUT', '/message-threads/t/read-status', { body: { isRead: true } }), null);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.body, '{"isRead":true}');
  assert.equal(calls[0].options.redirect, 'manual');
  await assert.rejects(portal.call('POST', '/after-school-absences', { body: {} }),
    (error) => error.message === 'Vigilo svarte med HTTP 400, absence_dates_overlapped_by_absence.' && !error.uncertain);
  for (const method of ['DELETE', 'PATCH']) {
    await assert.rejects(portal.call(method, '/check-in-notes/x'), (error) => error.uncertain === true && /kan være sendt/.test(error.message)
      && !/prøv igjen\./i.test(error.message));
  }
  const garbled = new Portal({ sessionProvider: async () => ({ accessToken: 'test' }), fetcher: async () => new Response('<html>') });
  await assert.rejects(garbled.call('POST', '/message-threads', { body: {} }), (error) => error.uncertain === true);
});

test('hidden characters and variation-selector runs are removed', () => {
  assert.equal(clean('AㅤB⠀C\u{E0100}D͏'), 'ABCD');
  assert.equal(clean('❤️️️'), '❤️');
  assert.equal(clean('a b'), 'a\nb');
});

test('the summary keeps the facts and shortens names first; the dialog text ends with … when cut', async () => {
  const long = structuredClone(children);
  long.items[0].organizationalUnits[1].name = 'U'.repeat(200);
  const questions = [];
  const { sender, send } = fake({ 'GET /children/my': long }, { confirm: async (message) => { questions.push(message); return true; } });
  const prepared = await sender.prepareCheckoutNote({ child_id: 'child', unit_id: 'aks', type_id: 'pickup', from_date: monday,
    to_date: later(monday, 25), weekdays: ['monday'], time: '16:30', note: 'N'.repeat(250) });
  assert.ok(prepared.summary.length <= 300);
  assert.match(prepared.summary, /^checkout_note · Kid Test · Hentes av · .* · 16:30 · hver uke: mandag \(4 dager\) · U+…?$/);
  const message = await sender.prepareMessage({ child_id: 'child', unit_id: 'school', recipient_ids: ['teacher'], title: 'T', text: 'x'.repeat(5000) });
  await send(message);
  assert.equal(questions.at(-1).length, 4000);
  assert.equal(questions.at(-1).endsWith('…'), true);
});

test('dates from Vigilo that are not real days are left out instead of throwing', async () => {
  const { sender } = fake({ 'GET /absences': { absences: [{ absenceId: 'z', fromDate: '2026-02-30', toDate: '2026-13-01' }] } });
  const [item] = (await sender.listAbsences({ child_id: 'child' })).absences;
  assert.deepEqual([item.fromDate, item.toDate], [undefined, undefined]);
});

test('conflicts name the weekdays of a weekly note, and deleting a note warns about days before the AKS deadline', async () => {
  const weeklyNote = { ...note1, isRecurring: true, toDate: later(monday, 26), recurrencePattern: { daysOfWeek: ['monday', 'friday'] } };
  const { sender } = fake({ 'GET /check-in-notes': { items: [weeklyNote] },
    'GET /check-in-note-configuration/registration-deadlines': { earliestAllowedDate: later(monday, 1) } });
  const late = await sender.prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1' });
  assert.match(late.deadline, /før fristen hos AKS/);
  const early = fake({ 'GET /check-in-notes': { items: [weeklyNote] } });
  const prepared = await early.sender.prepareCheckoutNote({ child_id: 'child', unit_id: 'aks', type_id: 'pickup', from_date: monday, time: '15:00' });
  assert.match(prepared.conflicts[0], /hver uke: mandag, fredag\)$/);
  assert.equal('deadline' in await early.sender.prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1' }), false);
});

test('a meeting deadline that cannot be read is refused, and one without an offset is Norwegian time', async () => {
  const invite = (registrationDeadline) => ({ 'GET /forms/meetings/invitations/child': { items: [{ id: 'm1', registrationDeadline,
    meetingOccurrences: [{ meetingOccurrenceId: 'o1', isAvailable: true }] }] } });
  await assert.rejects(fake(invite('soon')).sender.prepareBookMeeting({ child_id: 'child', meeting_id: 'm1', occurrence_id: 'o1' }), /gyldig frist/);
  // 23:30 Norwegian time yesterday has passed, even though it is not yet that time of day in UTC.
  await assert.rejects(fake(invite(`${plus(-1)}T23:30:00`)).sender.prepareBookMeeting({ child_id: 'child', meeting_id: 'm1', occurrence_id: 'o1' }), /passert/);
  const ok = await fake(invite(`${plus(2)}T08:00:00`)).sender.prepareBookMeeting({ child_id: 'child', meeting_id: 'm1', occurrence_id: 'o1' });
  assert.equal(ok.action, 'book_meeting');
});

test('a failed mark_thread_read is logged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-read-'));
  try {
    const log = join(dir, 'sent.jsonl');
    const refused = new Error('Vigilo svarte med HTTP 403.');
    const { sender } = fake({ 'PUT /message-threads/thread/read-status': () => { throw refused; } }, { log });
    await assert.rejects(sender.markThreadRead({ child_id: 'child', thread_id: 'thread' }), /403/);
    assert.match(await readFile(log, 'utf8'), /"action":"mark_thread_read".*"outcome":"failed"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a redirect after a write is uncertain, not a refusal', async () => {
  const portal = new Portal({ sessionProvider: async () => ({ accessToken: 'test' }),
    fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }) });
  await assert.rejects(portal.call('POST', '/message-threads', { body: {} }), (error) => error.uncertain === true);
  await assert.rejects(portal.call('GET', '/children/my'), (error) => !error.uncertain && /HTTP 302/.test(error.message));
});
