import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from '../src/browser.js';
import { Portal } from '../src/portal.js';
import { Sender } from '../src/sending.js';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(new Date());
const plus = (days) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// The next Monday at least a week ahead, so check-out notes land on weekdays.
const monday = (() => { for (let d = 7; ; d++) if (new Date(`${plus(d)}T12:00:00Z`).getUTCDay() === 1) return plus(d); })();
const pastMonday = (() => { for (let d = -1; ; d--) if (new Date(`${plus(d)}T12:00:00Z`).getUTCDay() === 1) return plus(d); })();
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
  isRecurring: false, noteText: 'Ringer hjem', childPersonIds: ['child'], canDelete: true };

// Tests never write to the real .data/ folder.
const testLog = join(tmpdir(), `vigilo-mcp-test-${process.pid}.jsonl`);
test.after(() => rm(testLog, { force: true }));

function fake(overrides = {}, { log = testLog, confirm, now, attachmentsDir } = {}) {
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
    'GET /check-in-note-types': { items: [{ id: 'alone', name: 'Går hjem alene', useComment: false }, { id: 'pickup', name: 'Hentes av', useComment: true }] },
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
  const sender = new Sender({ portal, log, attachmentsDir, ...(confirm ? { confirm } : {}), ...(now ? { now } : {}) });
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
  assert.match(questions[0], /^Vigilo: reply\n.*thread: Trip on Friday\nwrittenInThreadBy: Tea Cher\n\nMeldingstekst \(fritekst\):\nHei$/s);
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
  await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(1), note: 'Syk' }), /fraværskode/);
  await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'nursery', from_date: plus(1) }), /denne enheten/);
  await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'aks', from_date: plus(2), to_date: plus(1) }), /før from_date/);
  await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(1), absence_code_id: 'sick' }), /krever en kommentar/);
  const school = await sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(1), absence_code_id: 'sick', note: 'Syk' });
  assert.deepEqual(school.to, ['Tea Cher (kontaktlærer, 3A)']);
  const aks = await sender.prepareAbsence({ child_id: 'child', unit_id: 'aks', from_date: plus(1), to_date: plus(2), note: 'Hos besteforeldre' });
  await send(school);
  await send(aks);
  const [toSchool, toAks] = writes();
  assert.equal(toSchool.path, '/student-absences');
  assert.deepEqual(toSchool.body, { absenceCodeId: 'sick', organizationalUnitId: 'school', attachments: [], note: 'Syk', fromDate: plus(1),
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
  await assert.rejects(noTeacher.sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(1), absence_code_id: 'sick', note: 'Syk' }), /kontaktlærer/);
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
    to_date: later(monday, 25), weekdays: ['monday'], time: '16:30', note: 'N'.repeat(200) });
  assert.ok(prepared.summary.length <= 300);
  assert.match(prepared.summary, /^checkout_note · Kid Test · Hentes av · .* · 16:30 · hver uke: mandag \(4 dager\) · U+…?$/);
  const message = await sender.prepareMessage({ child_id: 'child', unit_id: 'school', recipient_ids: ['teacher'], title: 'T', text: 'x'.repeat(5000) });
  await send(message);
  assert.ok(questions.at(-1).length <= 4000);
  assert.equal(questions.at(-1).endsWith('…'), true);
  assert.match(questions.at(-1), /\nto: Tea Cher \(kontaktlærer, 3A\)\n/);
});

test('dates from Vigilo that are not real days are left out instead of throwing', async () => {
  const { sender } = fake({ 'GET /absences': { absences: [{ absenceId: 'z', fromDate: '2026-02-30', toDate: '2026-13-01' }] } });
  const [item] = (await sender.listAbsences({ child_id: 'child' })).absences;
  assert.deepEqual([item.fromDate, item.toDate], [undefined, undefined]);
});

test('conflicts name the weekdays of a weekly note, and deleting a note warns about days before the AKS deadline', async () => {
  const weeklyNote = { ...note1, isRecurring: true, toDate: later(monday, 26), recurrencePattern: { interval: 1, daysOfWeek: ['monday', 'friday'] } };
  const { sender } = fake({ 'GET /check-in-notes': { items: [weeklyNote] },
    'GET /check-in-note-configuration/registration-deadlines': { earliestAllowedDate: later(monday, 1) } });
  const late = await sender.prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1' });
  assert.match(late.deadline, /før fristen hos AKS/);
  const early = fake({ 'GET /check-in-notes': { items: [weeklyNote] } });
  const prepared = await early.sender.prepareCheckoutNote({ child_id: 'child', unit_id: 'aks', type_id: 'pickup', from_date: monday, time: '15:00', note: 'Bestemor' });
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

const pdf = Buffer.from('%PDF-1.4\n% test\n');

test('attachments are read at prepare, named in the summary and the dialog, and the prepared bytes are sent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-attach-'));
  try {
    await writeFile(join(dir, 'scan.pdf'), pdf);
    const log = join(dir, 'sent.jsonl');
    const questions = [];
    const { sender, send, writes } = fake({}, { log, attachmentsDir: dir, confirm: async (message) => { questions.push(message); return true; } });
    const prepared = await sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Se vedlegg', attachments: ['scan.pdf'] });
    assert.match(prepared.attachments[0], /^scan\.pdf \(PDF, 1 kB, sha256 [0-9a-f]{12}\)$/);
    assert.equal(prepared.summary, 'reply · Kid Test · vedlegg: scan.pdf · Trip on Friday · «Se vedlegg»');
    assert.equal(JSON.stringify(prepared).includes(pdf.toString('base64')), false);
    // A file swapped after the preview is not what gets sent.
    await writeFile(join(dir, 'scan.pdf'), '%PDF-1.4 something else');
    await send(prepared);
    assert.deepEqual(writes()[0].body.attachments, [{ name: 'scan.pdf', mimeType: 'application/pdf', dataBase64: pdf.toString('base64') }]);
    assert.match(questions[0], /attachments: scan\.pdf \(PDF.*\n\nMeldingstekst \(fritekst\):\nSe vedlegg$/s);
    assert.equal((await readFile(log, 'utf8')).includes(pdf.toString('base64')), false);

    const message = await sender.prepareMessage({ child_id: 'child', unit_id: 'school', recipient_ids: ['teacher'], title: 'T', text: 'B', attachments: ['scan.pdf'] });
    assert.match(message.summary, /vedlegg: scan\.pdf/);
    const school = await sender.prepareAbsence({ child_id: 'child', unit_id: 'school', from_date: plus(1), absence_code_id: 'sick', note: 'Legeerklæring', attachments: ['scan.pdf'] });
    await send(school);
    assert.equal(writes().at(-1).body.attachments[0].name, 'scan.pdf');
    await assert.rejects(sender.prepareAbsence({ child_id: 'child', unit_id: 'aks', from_date: plus(1), attachments: ['scan.pdf'] }), /bare imot vedlegg på fravær til skolen/);
    await assert.rejects(sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Hei', attachments: ['../sent.jsonl'] }), /vedleggsmappen/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  await assert.rejects(fake().sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Hei', attachments: ['scan.pdf'] }), /slått av/);
});

const editable = { ...note1, type: { id: 'alone', name: 'Går hjem alene' }, noteText: '', canUpdate: true, canUpdateToDate: true, canDelete: true };
const started = { id: 'n2', type: { id: 'pickup', name: 'Hentes av' }, timeOfDay: '15:00:00', fromDate: pastMonday, toDate: later(monday, 29),
  isRecurring: true, recurrencePattern: { interval: 1, daysOfWeek: ['monday'] }, noteText: 'Bestemor', childPersonIds: ['child'], canUpdate: false, canUpdateToDate: true };

test('editing a check-out note shows before and after and keeps the rules for new notes', async () => {
  const { sender, send, writes } = fake({ 'GET /check-in-notes': { items: [editable] } });
  const base = { child_id: 'child', unit_id: 'aks', note_id: 'n1' };
  await assert.rejects(fake().sender.prepareEditCheckoutNote({ ...base, time: '16:00' }), /lar ikke denne hentemeldingen endres/);
  await assert.rejects(sender.prepareEditCheckoutNote(base), /Ingenting å endre/);
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, time: '15:00' }), /allerede slik/);
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, time: '18:15' }), /kvarter/);
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, to_date: later(monday, 18) }), /weekdays/);
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, type_id: 'unknown' }), /list_checkout_note_types/);
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, note_id: 'missing', time: '16:00' }), /Fant ikke/);
  const late = fake({ 'GET /check-in-notes': { items: [editable] }, 'GET /check-in-note-configuration/registration-deadlines': { earliestAllowedDate: later(monday, 1) } });
  await assert.rejects(late.sender.prepareEditCheckoutNote({ ...base, time: '16:00' }), /Fristen er passert/);
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, time: '16:00', type_id: 'pickup' }), /trenger en kommentar/);
  const edit = await sender.prepareEditCheckoutNote({ ...base, time: '16:00', type_id: 'pickup', note: 'Bestemor' });
  assert.deepEqual(edit.changes, ['type Går hjem alene → Hentes av', 'tid 15:00 → 16:00', 'kommentar']);
  assert.equal(edit.before, `15:00 Går hjem alene, ${nor(monday)}, hver dag i perioden`);
  assert.equal('conflicts' in edit, false);  // the note itself is not a conflict
  assert.match(edit.summary, /^edit_checkout_note · Kid Test · endrer type Går hjem alene → Hentes av; tid 15:00 → 16:00; kommentar · Hentes av · /);
  await send(edit);
  assert.deepEqual(writes()[0], { method: 'PUT', path: '/check-in-notes/n1', headers: { 'x-organizational-unit-id': 'aks' }, query: undefined,
    body: { typeId: 'pickup', fromDate: monday, toDate: later(monday, 1), timeOfDay: '16:00:00',
      recurrencePattern: { recurrenceType: 'daily', interval: 1, daysOfWeek: null }, noteText: 'Bestemor' } });
});

test('a started weekly note can only get a new end date, sent to the to-date endpoint', async () => {
  const { sender, send, writes } = fake({ 'GET /check-in-notes': { items: [started] } });
  const base = { child_id: 'child', unit_id: 'aks', note_id: 'n2' };
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, time: '16:00' }), /bare to_date/);
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, to_date: later(monday, 5) }), /hverdag/);
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, to_date: plus(-30) }), /før from_date|hverdag/);
  const shorter = await sender.prepareEditCheckoutNote({ ...base, to_date: later(monday, 14) });
  assert.deepEqual(shorter.changes, [`datoer ${nor(pastMonday)}–${nor(later(monday, 28))} → ${nor(pastMonday)}–${nor(later(monday, 14))}`]);
  await send(shorter);
  assert.deepEqual(writes()[0], { method: 'PUT', path: '/check-in-notes/n2/to-date', body: { toDate: later(monday, 15) },
    headers: { 'x-organizational-unit-id': 'aks' }, query: undefined });
  const late = fake({ 'GET /check-in-notes': { items: [started] }, 'GET /check-in-note-configuration/registration-deadlines': { earliestAllowedDate: later(monday, 20) } });
  await assert.rejects(late.sender.prepareEditCheckoutNote({ ...base, to_date: later(monday, 14) }), /Fristen er passert/);
});

test('an edit is refused at send time if the note changed after the preview, and read back after sending', async () => {
  let current = editable;
  let saved = false;
  const { sender, send, writes } = fake({ 'GET /check-in-notes': () => ({ items: [current] }),
    'PUT /check-in-notes/n1': () => { if (saved) current = { ...editable, timeOfDay: '16:00:00' }; return null; } });
  const edit = await sender.prepareEditCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1', time: '16:00' });
  current = { ...editable, timeOfDay: '14:00:00' };
  await assert.rejects(send(edit), /endret siden forhåndsvisningen/);
  assert.equal(writes().length, 0);
  current = editable;
  const again = await sender.prepareEditCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1', time: '16:00' });
  assert.equal((await send(again)).verified, false);  // Vigilo still shows 15:00
  saved = true;
  assert.equal((await send(await sender.prepareEditCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1', time: '16:00' }))).verified, true);
  await assert.rejects(fake({ 'GET /check-in-notes': { items: [{ ...editable, canDelete: false }] } }).sender
    .prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1' }), /lar ikke denne hentemeldingen slettes/);
});

test('a school absence that Vigilo marks editable gets new dates; others are refused', async () => {
  let a4 = { absenceId: 'a4', organizationalUnit: { id: 'school', name: 'Test School', type: 'school' }, fromDate: plus(1), toDate: plus(3),
    isEditable: true, absenceCode: { name: 'Sykdom' } };
  const others = [
    { absenceId: 'a1', organizationalUnit: { id: 'aks', name: 'Test AKS', type: 'afterSchool' }, fromDate: plus(2), toDate: plus(3), isEditable: true },
    { absenceId: 'a2', organizationalUnit: { id: 'school', type: 'school' }, fromDate: plus(1), toDate: plus(2), isEditable: false }];
  const absences = () => ({ absences: [...others, a4] });
  const { sender, send, writes } = fake({ 'GET /absences': absences });
  assert.equal((await sender.listAbsences({ child_id: 'child' })).absences[2].editable, true);
  await assert.rejects(sender.prepareEditAbsence({ child_id: 'child', absence_id: 'a1', to_date: plus(2) }), /Bare skolefravær/);
  await assert.rejects(sender.prepareEditAbsence({ child_id: 'child', absence_id: 'a2', to_date: plus(1) }), /lar ikke/);
  await assert.rejects(sender.prepareEditAbsence({ child_id: 'child', absence_id: 'a4' }), /Ingenting å endre/);
  await assert.rejects(sender.prepareEditAbsence({ child_id: 'child', absence_id: 'a4', to_date: plus(2) }), /allerede disse datoene/);
  await assert.rejects(sender.prepareEditAbsence({ child_id: 'child', absence_id: 'a4', from_date: plus(-1) }), /tilbake i tid/);
  await assert.rejects(sender.prepareEditAbsence({ child_id: 'child', absence_id: 'a4', to_date: plus(0) }), /før from_date/);
  const shorter = await sender.prepareEditAbsence({ child_id: 'child', absence_id: 'a4', to_date: plus(1) });
  assert.deepEqual(shorter.changes, [`datoer ${nor(plus(1))}–${nor(plus(2))} → ${nor(plus(1))}`]);
  a4 = { ...a4, toDate: plus(4) };
  await assert.rejects(send(shorter), /endret siden forhåndsvisningen/);
  assert.equal(writes().length, 0);
  const again = await sender.prepareEditAbsence({ child_id: 'child', absence_id: 'a4', to_date: plus(1) });
  await send(again);
  assert.deepEqual(writes()[0], { method: 'PUT', path: '/student-absences/a4', body: { organizationalUnitId: 'school', fromDate: plus(1), toDate: plus(2) },
    query: undefined, headers: undefined });
});

const registrations = { items: [
  { id: 'r1', title: 'Skidag', registrationType: 'multipleChoices', registrationDeadline: `${plus(5)}T12:00:00Z`, organizationalUnitName: 'Test School', reply: null,
    registrationChoices: [{ registrationChoiceId: 'c1', choiceNumber: 1, choiceText: 'Slalom' }, { registrationChoiceId: 'c2', choiceNumber: 2, choiceText: 'Langrenn' },
      { registrationChoiceId: 'c3', choiceNumber: 3, choiceText: 'Aking' }] },
  { id: 'r2', title: 'Foto', registrationType: 'singleChoice', reply: { selectedRegistrationChoices: [{ registrationChoiceId: 'y', rank: 1 }] },
    registrationChoices: [{ registrationChoiceId: 'y', choiceNumber: 1, choiceText: 'Ja' }, { registrationChoiceId: 'n', choiceNumber: 2, choiceText: 'Nei' }] },
  { id: 'r3', title: 'Valgfag', registrationType: 'rankedChoices', reply: null,
    registrationChoices: [{ registrationChoiceId: 'a', choiceNumber: 1, choiceText: 'Kunst' }, { registrationChoiceId: 'b', choiceNumber: 2, choiceText: 'Kode' }] },
  { id: 'r4', title: 'Gammel', registrationType: 'singleChoice', registrationDeadline: `${plus(-1)}T12:00:00Z`,
    registrationChoices: [{ registrationChoiceId: 'y', choiceNumber: 1, choiceText: 'Ja' }] },
] };

test('a sign-up answer must use choices from the form, fit its type and come before the deadline', async () => {
  let now = Date.now();
  const { sender, send, writes } = fake({ 'GET /forms/registrations/invitations/child': registrations });
  const reply = (registration_id, choice_ids) => sender.prepareRegistrationReply({ child_id: 'child', registration_id, choice_ids });
  const listed = await sender.listRegistrations({ child_id: 'child' });
  assert.deepEqual(listed.registrations[1].answered, ['y']);
  await assert.rejects(reply('missing', ['c1']), /list_registrations/);
  await assert.rejects(reply('r1', ['c9']), /hører ikke/);
  await assert.rejects(reply('r1', ['c1', 'c1']), /to ganger/);
  await assert.rejects(reply('r2', ['y', 'n']), /bare ett valg/);
  await assert.rejects(reply('r2', ['y']), /allerede besvart/);
  await assert.rejects(reply('r3', ['b']), /Ranger alle/);
  await assert.rejects(reply('r4', ['y']), /Fristen for påmeldingen er passert/);
  const multiple = await reply('r1', ['c3', 'c1']);
  assert.deepEqual(multiple.choices, ['[x] Slalom', '[ ] Langrenn', '[x] Aking']);
  assert.match(multiple.summary, /^registration_reply · Kid Test · Skidag · valgt: Slalom, Aking$/);
  assert.match(multiple.changeable, /frem til fristen/);
  assert.equal((await reply('r2', ['n'])).replaces, 'Ja');
  const ranked = await reply('r3', ['b', 'a']);
  assert.deepEqual(ranked.choices, ['1. Kode', '2. Kunst']);
  await send(ranked);
  assert.deepEqual(writes()[0], { method: 'POST', path: '/forms/registrations/r3/replies', query: undefined, headers: undefined,
    body: { childPersonId: 'child', inviteePersonId: 'parent', selectedRegistrationChoices: [{ registrationChoiceId: 'b', rank: 1 }, { registrationChoiceId: 'a', rank: 2 }] } });
  // The deadline is checked again when sending.
  const soon = { items: [{ ...registrations.items[0], registrationDeadline: new Date(now + 60_000).toISOString() }] };
  const closing = fake({ 'GET /forms/registrations/invitations/child': soon }, { now: () => now });
  const prepared = await closing.sender.prepareRegistrationReply({ child_id: 'child', registration_id: 'r1', choice_ids: ['c1'] });
  now += 2 * 60_000;
  await assert.rejects(closing.send(prepared), /Fristen for påmeldingen er passert/);
  assert.equal(closing.writes().length, 0);
});

test('a sign-up answer is read back as verified', async () => {
  let stored = registrations;
  const { sender, send, writes } = fake({ 'GET /forms/registrations/invitations/child': () => stored });
  const prepared = await sender.prepareRegistrationReply({ child_id: 'child', registration_id: 'r1', choice_ids: ['c2'] });
  stored = { items: [{ ...registrations.items[0], reply: { selectedRegistrationChoices: [{ registrationChoiceId: 'c2', rank: 2 }] } }] };
  assert.equal((await send(prepared)).verified, true);
  assert.deepEqual(writes()[0].body.selectedRegistrationChoices, [{ registrationChoiceId: 'c2', rank: 2 }]);
});

test('marking a news post read checks it is the child\'s post and does nothing when it is already read', async () => {
  const feed = [{ id: 'p1', type: 'post', title: 'Juleavslutning', isRead: false }, { id: 'p2', type: 'post', title: 'Gammel', isRead: true },
    { id: 'f1', type: 'formativeAssessment' }];
  const { sender, writes } = fake({ 'GET /news-feed': feed });
  await assert.rejects(sender.markNewsRead({ child_id: 'child', post_id: 'missing' }), /list_news/);
  await assert.rejects(sender.markNewsRead({ child_id: 'child', post_id: 'f1' }), /Bare vanlige oppslag/);
  assert.match((await sender.markNewsRead({ child_id: 'child', post_id: 'p2' })).note, /allerede lest/);
  assert.equal(writes().length, 0);
  assert.deepEqual(await sender.markNewsRead({ child_id: 'child', post_id: 'p1' }), { child: 'Kid Test', news: 'Juleavslutning', read: true });
  assert.deepEqual(writes(), [{ method: 'POST', path: '/post-viewings', body: { postIds: ['p1'] } }]);
  const no = fake({ 'GET /news-feed': feed }, { confirm: async () => false });
  await assert.rejects(no.sender.markNewsRead({ child_id: 'child', post_id: 'p1' }), /ikke bekreftet/);
  assert.equal(no.writes().length, 0);
});

test('required actions and unread badges are listed with child and unit names, and nothing is written', async () => {
  const { sender, writes } = fake({
    'GET /required-actions': { items: [{ type: 'fillAllergies', properties: { childId: 'child', organizationalUnitId: 'school' } }, { type: 'constructor', properties: {} }] },
    'GET /children-counters': { counters: [{ childId: 'child', unreadMessageThreadsCounter: 2, unreadConsentsCounter: -1 }, { childId: 5 }] } });
  const result = await sender.listRequiredActions();
  assert.deepEqual(result.actions[0], { type: 'fillAllergies', description: 'Fyll ut helseopplysninger (allergier) i Vigilo.', childId: 'child',
    child: 'Kid Test', unitId: 'school', unit: 'Test School' });
  assert.equal(result.actions[1].description, undefined);
  assert.deepEqual(result.unread, [{ childId: 'child', child: 'Kid Test', messageThreads: 2, consents: 0, absenceNotifications: 0 }]);
  assert.equal(writes().length, 0);
});

test('consent forms show the parent\'s own status and every guardian\'s, as plain text', async () => {
  const { sender, writes, calls } = fake({ 'GET /consent-forms': { consentInformation: '<b>Les</b> dette',
    consentForms: [{ id: 'f1', description: '<p>Foto på nett</p>', legalGuardians: [
      { id: 'parent', firstName: 'Pa', lastName: 'Rent', consent: { givenAt: '2026-09-01T10:00:00Z' } },
      { id: 'other', firstName: 'Ot', lastName: 'Her', consent: { givenAt: '2026-09-01T10:00:00Z', revokedAt: '2026-09-02T10:00:00Z' } }] },
    { id: 'f2', description: 'Tur', legalGuardians: [{ id: 'parent' }] }, { id: 'f3', legalGuardians: [] }] } });
  await assert.rejects(sender.listConsentForms({ child_id: 'child', unit_id: 'other-unit' }), /hører ikke/);
  const result = await sender.listConsentForms({ child_id: 'child', unit_id: 'school' });
  assert.equal(result.information, 'Les dette');
  assert.deepEqual(result.forms.map((form) => [form.text, form.status]), [['Foto på nett', 'given'], ['Tur', 'pending'], ['', 'not_asked']]);
  assert.deepEqual(result.forms[0].guardians, [{ name: 'Pa Rent', status: 'given' }, { name: 'Ot Her', status: 'revoked' }]);
  assert.deepEqual(calls.find((call) => call.path === '/consent-forms').query, { childId: 'child', organizationalUnitId: 'school' });
  assert.equal(writes().length, 0);
});

// Security review 2026-11-25, one test per finding.
const biweekly = { id: 'n3', type: { id: 'alone', name: 'Går hjem alene' }, timeOfDay: '15:00:00', fromDate: monday, toDate: later(monday, 29),
  isRecurring: true, recurrencePattern: { recurrenceType: 'weekly', interval: 2, daysOfWeek: ['monday'] }, noteText: '', childPersonIds: ['child'],
  canUpdate: true, canDelete: true };

test('review 1: an every-other-week note stays every other week when edited, and says so everywhere', async () => {
  let current = biweekly;
  const { sender, send, writes } = fake({ 'GET /check-in-notes': () => ({ items: [current] }) });
  const base = { child_id: 'child', unit_id: 'aks', note_id: 'n3' };
  const edit = await sender.prepareEditCheckoutNote({ ...base, time: '14:00' });
  assert.match(edit.before, /annenhver uke: mandag/);
  assert.equal(edit.repeats, 'annenhver uke: mandag (3 dager)');  // weeks 0, 2 and 4 of five Mondays
  await send(edit);
  assert.deepEqual(writes()[0].body.recurrencePattern, { recurrenceType: 'weekly', interval: 2, daysOfWeek: ['monday'] });
  assert.equal((await sender.listCheckoutNotes(base)).notes[0].repeats, 'annenhver uke: mandag');
  assert.match((await sender.prepareDeleteCheckoutNote(base)).repeats, /^annenhver uke/);
  const again = await sender.prepareEditCheckoutNote({ ...base, time: '14:00' });
  current = { ...biweekly, recurrencePattern: { ...biweekly.recurrencePattern, interval: 1 } };
  await assert.rejects(send(again), /endret siden forhåndsvisningen/);
  current = { ...biweekly, recurrencePattern: { ...biweekly.recurrencePattern, interval: 3 } };
  await assert.rejects(sender.prepareEditCheckoutNote({ ...base, time: '14:00' }), /Kunne ikke lese/);
});

test('review 2: facts come before free text in the dialog, are never cut, and are one line each', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigilo-mcp-dialog-'));
  try {
    await writeFile(join(dir, 'scan.pdf'), pdf);
    const questions = [];
    const { sender, send } = fake({ 'GET /message-threads/thread': { title: 'Trip\nchild: Someone Else', isReplyDisabled: false } },
      { attachmentsDir: dir, confirm: async (message) => { questions.push(message); return true; } });
    const prepared = await sender.prepareReply({ child_id: 'child', thread_id: 'thread', text: 'Hei. '.repeat(999), attachments: ['scan.pdf'] });
    assert.deepEqual(Object.keys(prepared).slice(0, 5), ['action', 'child', 'thread', 'attachments', 'text']);
    assert.equal(prepared.summary.includes('\n'), false);
    await send(prepared);
    const [dialog] = questions;
    assert.ok(dialog.length <= 4000);
    assert.match(dialog, /\nthread: Trip child: Someone Else\nattachments: scan\.pdf \(PDF[^\n]*\n\nMeldingstekst \(fritekst\):\nHei\. /);
    assert.equal(dialog.split('\n').filter((line) => line.startsWith('child:')).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('review 3: a type with useComment needs a comment, and a type without one has none', async () => {
  const { sender, send, writes } = fake({ 'GET /check-in-notes': { items: [{ ...editable, noteText: 'Gammel kommentar' }] } });
  const base = { child_id: 'child', unit_id: 'aks', from_date: monday, time: '15:00' };
  await assert.rejects(sender.prepareCheckoutNote({ ...base, type_id: 'pickup' }), /trenger en kommentar/);
  await assert.rejects(sender.prepareCheckoutNote({ ...base, type_id: 'alone', note: 'Bestemor' }), /har ingen kommentar/);
  const edit = await sender.prepareEditCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1', time: '16:00' });
  assert.deepEqual(edit.changes, ['tid 15:00 → 16:00', 'kommentar fjernes']);
  await send(edit);
  assert.equal(writes()[0].body.noteText, '');
});

test('review 4: the AKS deadline is checked again when sending, for new and edited notes', async () => {
  let earliest = `${plus(1)}T00:00:00`;
  const { sender, send, writes } = fake({ 'GET /check-in-notes': { items: [editable] },
    'GET /check-in-note-configuration/registration-deadlines': () => ({ earliestAllowedDate: earliest }) });
  const created = await sender.prepareCheckoutNote({ child_id: 'child', unit_id: 'aks', type_id: 'alone', from_date: monday, time: '15:00' });
  const edited = await sender.prepareEditCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1', time: '16:00' });
  earliest = later(monday, 1);
  await assert.rejects(send(created), /Fristen er passert/);
  await assert.rejects(send(edited), /Fristen er passert/);
  assert.equal(writes().length, 0);
  // A change in what Vigilo allows to edit also stops the send.
  earliest = `${plus(1)}T00:00:00`;
  let note = editable;
  const other = fake({ 'GET /check-in-notes': () => ({ items: [note] }) });
  const prepared = await other.sender.prepareEditCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1', time: '16:00' });
  note = { ...editable, canUpdate: false };
  await assert.rejects(other.send(prepared), /endret siden forhåndsvisningen/);
});

test('review 8: an untouched comment is sent back exactly as Vigilo has it', async () => {
  const original = `Bestemor​ henter. ${'x'.repeat(220)}`;
  const { sender, send, writes } = fake({ 'GET /check-in-notes': { items: [{ ...editable, type: { id: 'pickup', name: 'Hentes av' }, noteText: original }] } });
  const edit = await sender.prepareEditCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1', time: '16:00' });
  assert.deepEqual(edit.changes, ['tid 15:00 → 16:00']);
  await send(edit);
  assert.equal(writes()[0].body.noteText, original);
});

test('review 10 and 11: a note is deletable only when Vigilo says so, and a check-out comment has at most 200 characters', async () => {
  const { canDelete, ...unknown } = note1;
  await assert.rejects(fake({ 'GET /check-in-notes': { items: [unknown] } }).sender
    .prepareDeleteCheckoutNote({ child_id: 'child', unit_id: 'aks', note_id: 'n1' }), /lar ikke denne hentemeldingen slettes/);
  const { sender } = fake();
  await assert.rejects(sender.prepareCheckoutNote({ child_id: 'child', unit_id: 'aks', type_id: 'pickup', from_date: monday, time: '15:00',
    note: 'N'.repeat(201) }), /høyst 200 tegn/);
  // An absence note keeps the portal's 250.
  assert.equal((await sender.prepareAbsence({ child_id: 'child', unit_id: 'aks', from_date: plus(1), note: 'N'.repeat(250) })).noteText.length, 250);
});
