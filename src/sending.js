import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PublicError, clean, dataDir } from './browser.js';
import { addDays, dateValue, osloToday, segment } from './portal.js';

// Sending is off unless VIGILO_ALLOW_SEND=1. Everything that changes Vigilo goes in two steps: a prepare tool checks
// the request and returns exactly what will be sent with a one-time code, and send_prepared sends only that.
// Endpoints and fields are the ones the parent web portal uses; they have not been tried against the live service.
export const sendingEnabled = () => process.env.VIGILO_ALLOW_SEND === '1';

const codeTtl = 10 * 60_000;
const maxPending = 20;
const maxText = 5_000;
const maxTitle = 200;
const maxNote = 250;
const maxRecipients = 10;
const maxSingleRange = 14;
const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const weekdayNames = { monday: 'mandag', tuesday: 'tirsdag', wednesday: 'onsdag', thursday: 'torsdag', friday: 'fredag' };
const relationNames = { contactTeacher: 'kontaktlærer', subjectTeacher: 'faglærer', departmentEmployee: 'ansatt' };
const checkOut = 'afterSchoolCheckOut';

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new PublicError(`${name} må være tekst.`);
  const cleaned = clean(value).replace(/\r\n?/g, '\n').trim();
  if (!cleaned) throw new PublicError(`${name} må være tekst.`);
  if (cleaned.length > max) throw new PublicError(`${name} kan ha høyst ${max} tegn.`);
  return cleaned;
}

function optionalText(value, name, max) {
  return value === undefined || value === null || value === '' ? '' : text(value, name, max);
}

// Only strings from Vigilo are shown, cut so a long name cannot crowd out the rest of a preview.
const str = (value, max = 200) => (typeof value === 'string' ? clean(value).slice(0, max) : '');
const fullName = (person) => str([person?.firstName, person?.lastName].filter((part) => typeof part === 'string').join(' ')).trim();
const list = (value) => (Array.isArray(value) ? value : []);
const norwegian = (iso) => iso.split('-').reverse().join('.');
// A date from Vigilo only if it is a real calendar day, so a malformed one never throws.
function dayOf(value) {
  const day = typeof value === 'string' ? value.slice(0, 10) : '';
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day ? day : undefined;
}
// Vigilo gives end dates exclusive; a malformed one is left out instead of failing.
const lastDay = (value) => (dayOf(value) ? addDays(dayOf(value), -1) : undefined);
const weekday = (iso) => weekdays[new Date(`${iso}T12:00:00Z`).getUTCDay() - 1];

const osloDateTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// A time with an offset or Z is shown in Norwegian time; one without is already local.
function localTime(value) {
  const raw = str(value, 40);
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) return raw.replace('T', ' ').slice(0, 16);
  return osloDateTime.format(new Date(raw)).replace(', ', ' ');
}
// Milliseconds for a time with an offset, or for a time without one read as Norwegian time. NaN if unreadable.
function osloMs(value) {
  const raw = str(value, 40);
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) return Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) return NaN;
  const naive = Date.parse(`${raw}Z`);
  if (!Number.isFinite(naive)) return NaN;
  const shown = Date.parse(`${osloDateTime.format(naive).replace(', ', 'T')}:00Z`);
  return naive - (shown - naive);
}
function osloDay(value) {
  const raw = str(value, 40);
  return /(Z|[+-]\d{2}:?\d{2})$/.test(raw) && Number.isFinite(Date.parse(raw)) ? localTime(raw).slice(0, 10) : dayOf(raw);
}

// A date the parent picks: today or later in Norway, on or before to_date. Vigilo takes the end date exclusive.
function period(fromDate, toDate, { weekdaysOnly = false } = {}) {
  const from = dateValue(fromDate, 'from_date');
  if (!from) throw new PublicError('from_date mangler.');
  const to = toDate === undefined || toDate === null ? from : dateValue(toDate, 'to_date');
  if (from < osloToday()) throw new PublicError('from_date kan ikke være tilbake i tid.');
  if (to < from) throw new PublicError('to_date kan ikke være før from_date.');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days > 366) throw new PublicError('Perioden kan ikke være lengre enn ett år.');
  if (weekdaysOnly && [from, to].some((day) => !weekday(day))) throw new PublicError('Hentemeldinger kan bare starte og slutte på en hverdag.');
  return { from, to, days, exclusiveTo: addDays(to, 1), text: from === to ? norwegian(from) : `${norwegian(from)}–${norwegian(to)}` };
}

// HH:MM in quarter hours from 07:00 to 18:00, as the portal's time picker offers.
function timeOfDay(value) {
  const match = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  if (!match || Number(match[2]) % 15 !== 0 || value < '07:00' || value > '18:00') {
    throw new PublicError('time må være et kvarter mellom 07:00 og 18:00, som 15:00.');
  }
  return value;
}

// Weekdays (Monday–Friday) in the range that a daily or weekly note applies to.
function noteDays(from, to, days) {
  let count = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) if (weekday(day) && (!days || days.includes(weekday(day)))) count++;
  return count;
}

const contactLabel = (c) => `${c.name}${[relationNames[c.relation] || c.jobTitle, c.group].filter(Boolean).length
  ? ` (${[relationNames[c.relation] || c.jobTitle, c.group].filter(Boolean).join(', ')})` : ''}`;

export class Sender {
  #portal;
  #confirm;
  #log;
  #now;
  #pending = new Map();

  constructor({ portal, confirm = async () => null, log = join(dataDir, 'sent.jsonl'), now = Date.now }) {
    this.#portal = portal;
    this.#confirm = confirm;
    this.#log = log;
    this.#now = now;
  }

  // The child with its units, straight from Vigilo, so a unit or child that is not on the account is refused.
  async #children() {
    const data = await this.#portal.call('GET', '/children/my');
    return list(data?.items).filter((child) => typeof child?.id === 'string');
  }

  async #child(childId) {
    const id = segment(childId, 'child_id');
    const child = (await this.#children()).find((item) => item.id === id);
    if (!child) throw new PublicError('Barnet finnes ikke på kontoen.');
    return { id, name: fullName(child), units: list(child.organizationalUnits) };
  }

  async #unit(childId, unitId, types) {
    const child = await this.#child(childId);
    const id = segment(unitId, 'unit_id');
    const unit = child.units.find((item) => item?.id === id);
    if (!unit) throw new PublicError('Enheten hører ikke til barnet.');
    if (types && !types.includes(unit.type)) throw new PublicError('Det kan ikke gjøres for denne enheten.');
    return { child, unit: { id, name: str(unit.name), type: unit.type, raw: unit } };
  }

  #prepare(action, request, preview, verify) {
    const now = this.#now();
    const key = JSON.stringify(request);
    // An expired code, or an older code for the very same request, is dropped, so only one code can send it.
    for (const [code, entry] of this.#pending) if (entry.expiresAt <= now || entry.key === key) this.#pending.delete(code);
    if (this.#pending.size >= maxPending) throw new PublicError('For mange forberedte handlinger venter. Send eller la dem gå ut først.');
    const code = randomBytes(4).toString('hex');
    // send_prepared must repeat this line, so a client's approval prompt shows what is sent, not only a code. The facts
    // that decide what happens come first; names and text are shortened to fit, never the facts.
    const facts = [action, preview.child, preview.children?.join(', '), preview.to?.length && `til ${preview.to.join(', ')}`,
      preview.type, preview.code, preview.dates, preview.time, preview.repeats, preview.start && `${preview.start}–${preview.end}`]
      .filter(Boolean).join(' · ');
    if (facts.length > 300) throw new PublicError('For mye å vise i én linje. Velg færre mottakere eller barn.');
    let summary = facts;
    for (const part of [preview.thread, preview.meeting, preview.unit, preview.title,
      (preview.text || preview.noteText) && `«${(preview.text || preview.noteText).replace(/\s+/g, ' ').slice(0, 60)}»`].filter(Boolean)) {
      const room = 300 - summary.length - 3;
      if (room < 2) break;
      summary += ` · ${part.length > room ? `${part.slice(0, room - 1)}…` : part}`;
    }
    this.#pending.set(code, { action, request, preview, verify, summary, key, expiresAt: now + codeTtl });
    return { action, ...preview, summary, confirmationCode: code, expiresInMinutes: codeTtl / 60_000,
      note: 'Ingenting er sendt. Vis dette til forelderen, og kall send_prepared med koden og summary nøyaktig slik den står, bare etter at de har godkjent det.' };
  }

  async #contacts(childId, unitId) {
    const data = await this.#portal.call('GET', `/messages/contact-list/children/${childId}`, { query: { organizationalUnitId: unitId } });
    const all = [...list(data?.relatedEmployees), ...list(data?.otherEmployees)]
      .filter((employee) => typeof employee?.id === 'string' && employee.id)
      .map((employee) => ({ id: employee.id, name: fullName(employee), relation: str(employee.relationType, 40),
        group: str(employee.groupName), jobTitle: str(employee.jobTitle) }));
    return [...new Map(all.map((c) => [c.id, c])).values()];
  }

  async listContacts({ child_id, unit_id } = {}) {
    const { child, unit } = await this.#unit(child_id, unit_id);
    return { child: child.name, unit: unit.name, contacts: await this.#contacts(child.id, unit.id) };
  }

  async #thread(childId, threadId) {
    const thread = await this.#portal.call('GET', `/message-threads/${threadId}`, { query: { childPersonId: childId } });
    if (!thread || typeof thread !== 'object' || thread.isDeleted) throw new PublicError('Fant ikke meldingstråden.');
    return thread;
  }

  async prepareReply({ child_id, thread_id, text: body } = {}) {
    const reply = text(body, 'text', maxText);
    const child = await this.#child(child_id);
    const threadId = segment(thread_id, 'thread_id');
    const thread = await this.#thread(child.id, threadId);
    if (thread.isReplyDisabled) throw new PublicError('Det er slått av å svare i denne tråden.');
    // A reply in a group thread would reach every participant, for example all parents in a class.
    if (thread.isGroupMessageThread) throw new PublicError('Dette er en gruppetråd. Svar i Vigilo, eller skriv en ny melding med prepare_message.');
    // Vigilo's thread has no participant list here, so this shows the people who have written in it.
    const writers = [...new Set(list(thread.messages).map((m) => fullName(m?.sender)).filter(Boolean))].slice(0, 10);
    return this.#prepare('reply', { method: 'POST', path: `/message-threads/${threadId}/reply`, body: { body: reply, attachments: [] } },
      { child: child.name, thread: str(thread.title), ...(writers.length ? { writtenInThreadBy: writers } : {}), text: reply });
  }

  async prepareMessage({ child_id, unit_id, recipient_ids, title, text: body } = {}) {
    if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) throw new PublicError('recipient_ids må være en liste med ID-er fra list_contacts.');
    const ids = [...new Set(recipient_ids.map((id) => segment(id, 'recipient_ids')))];
    if (ids.length > maxRecipients) throw new PublicError(`Høyst ${maxRecipients} mottakere.`);
    const subject = text(title, 'title', maxTitle);
    const message = text(body, 'text', maxText);
    const { child, unit } = await this.#unit(child_id, unit_id);
    if (unit.raw.hasCommunicationLicense === false || unit.raw.isActive === false) throw new PublicError('Enheten tar ikke imot meldinger i Vigilo.');
    const contacts = await this.#contacts(child.id, unit.id);
    if (ids.some((id) => !contacts.some((c) => c.id === id))) throw new PublicError('Bare ansatte fra list_contacts kan være mottakere.');
    // As in the portal: the child comes first, then the chosen employees.
    const recipients = [{ type: 'client', externalId: child.id, readOnly: false },
      ...ids.map((id) => ({ type: 'employee', externalId: id, readOnly: false }))];
    return this.#prepare('message', { method: 'POST', path: '/message-threads',
      body: { title: subject, body: message, organizationalUnitId: unit.id, recipients, attachments: [] } },
    { child: child.name, unit: unit.name, to: ids.map((id) => contactLabel(contacts.find((c) => c.id === id))), title: subject, text: message });
  }

  async #absences(childId) {
    const data = await this.#portal.call('GET', '/absences', { query: { childIds: childId, includeAfterSchoolAbsences: 'true' } });
    return list(data?.absences).filter((item) => item && typeof item === 'object');
  }

  #absence(item) {
    return { id: typeof item.absenceId === 'string' ? item.absenceId : undefined,
      unit: str(item.organizationalUnit?.name), unitType: str(item.organizationalUnit?.type, 40),
      fromDate: dayOf(item.fromDate), toDate: lastDay(item.toDate),
      code: str(item.absenceCode?.name) || str(item.absenceCode), note: str(item.note, maxNote),
      deletable: item.isDeletable === true, deleted: item.isAbsenceDeleted === true };
  }

  async listAbsences({ child_id } = {}) {
    const child = await this.#child(child_id);
    return { child: child.name, absences: (await this.#absences(child.id)).slice(0, 50).map((item) => this.#absence(item)) };
  }

  async #absenceCodes(unitId) {
    const data = await this.#portal.call('GET', '/absencecodes', { query: { organizationalUnitIds: unitId } });
    const entry = list(data?.items).find((item) => item?.organizationalUnitId === unitId);
    return list(entry?.codes).filter((code) => typeof code?.id === 'string').map((code) => ({ id: code.id, name: str(code.name) }));
  }

  async listAbsenceCodes({ child_id, unit_id } = {}) {
    const { unit } = await this.#unit(child_id, unit_id);
    return { unit: unit.name, codes: await this.#absenceCodes(unit.id) };
  }

  async prepareAbsence({ child_id, unit_id, from_date, to_date, absence_code_id, note } = {}) {
    const dates = period(from_date, to_date);
    const noteText = optionalText(note, 'note', maxNote);
    const { child, unit } = await this.#unit(child_id, unit_id, ['school', 'afterSchool']);
    const codes = await this.#absenceCodes(unit.id);
    let code;
    if (absence_code_id !== undefined) {
      code = codes.find((item) => item.id === segment(absence_code_id, 'absence_code_id'));
      if (!code) throw new PublicError('Ukjent fraværskode for enheten. Bruk list_absence_codes.');
    } else if (unit.type === 'school' && codes.length) throw new PublicError('Skolen krever en fraværskode. Bruk list_absence_codes.');
    const body = { absenceCodeId: code?.id ?? null, organizationalUnitId: unit.id, attachments: [], note: noteText,
      fromDate: dates.from, toDate: dates.exclusiveTo };
    let to = [];
    if (unit.type === 'school') {
      // The school receives it through the child's contact teachers, as the portal preselects.
      const teachers = (await this.#contacts(child.id, unit.id)).filter((c) => c.relation === 'contactTeacher');
      if (!teachers.length) throw new PublicError('Barnet har ingen kontaktlærer registrert i Vigilo. Ta kontakt med skolen.');
      const groups = list(unit.raw.groups).map((group) => str(group?.name)).filter(Boolean).join(' ');
      Object.assign(body, { childId: child.id, title: `Fravær for ${child.name}${groups ? `, ${groups}` : ''}`,
        recipients: teachers.map((t) => ({ type: 'Employee', externalId: t.id })) });
      to = teachers.map(contactLabel);
    } else Object.assign(body, { childPersonId: child.id, title: `Fravær for ${child.name}` });
    const path = unit.type === 'school' ? '/student-absences' : '/after-school-absences';
    const verify = async () => (await this.#absences(child.id)).some((item) => item.organizationalUnit?.id === unit.id
      && dayOf(item.fromDate) === dates.from && lastDay(item.toDate) === dates.to && item.isAbsenceDeleted !== true);
    return this.#prepare('absence', { method: 'POST', path, body },
      { child: child.name, unit: unit.name, dates: dates.text, ...(code ? { code: code.name } : {}), ...(to.length ? { to } : {}),
        ...(noteText ? { noteText } : {}) }, verify);
  }

  async prepareDeleteAbsence({ child_id, absence_id } = {}) {
    const id = segment(absence_id, 'absence_id');
    const child = await this.#child(child_id);
    const item = (await this.#absences(child.id)).find((absence) => absence.absenceId === id);
    if (!item) throw new PublicError('Fant ikke fraværet. Bruk list_absences.');
    if (item.isDeletable !== true) throw new PublicError('Vigilo lar ikke dette fraværet slettes. Ta kontakt med skolen eller AKS.');
    const unitId = segment(item.organizationalUnit?.id, 'organizationalUnit');
    const kind = item.organizationalUnit?.type === 'afterSchool' ? 'after-school-absences' : 'absences';
    const shown = this.#absence(item);
    const verify = async () => !(await this.#absences(child.id)).some((absence) => absence.absenceId === id && absence.isAbsenceDeleted !== true);
    return this.#prepare('delete_absence', { method: 'DELETE', path: `/${kind}/${id}`, query: { organizationalUnitId: unitId } },
      { child: child.name, unit: shown.unit, dates: [...new Set([shown.fromDate, shown.toDate].filter(Boolean))].map(norwegian).join('–'),
        ...(shown.code ? { code: shown.code } : {}), ...(shown.note ? { noteText: shown.note } : {}) }, verify);
  }

  async #noteTypes(unitId) {
    const data = await this.#portal.call('GET', '/check-in-note-types', { query: { category: checkOut },
      headers: { 'x-organizational-unit-id': unitId } });
    return list(data?.items).filter((type) => typeof type?.id === 'string').map((type) => ({ id: type.id, name: str(type.name) }));
  }

  async listCheckoutNoteTypes({ child_id, unit_id } = {}) {
    const { unit } = await this.#unit(child_id, unit_id, ['afterSchool']);
    return { unit: unit.name, types: await this.#noteTypes(unit.id) };
  }

  async #notes(childId, unitId, from, to) {
    const data = await this.#portal.call('GET', '/check-in-notes', {
      query: { childPersonId: childId, category: checkOut, includeDisabled: 'false', fromDate: from, toDate: addDays(to, 1) },
      headers: { 'x-organizational-unit-id': unitId } });
    return list(data?.items).filter((note) => typeof note?.id === 'string').map((note) => {
      const days = list(note.recurrencePattern?.daysOfWeek).filter((day) => weekdays.includes(day));
      return { id: note.id, type: str(note.type?.name), time: str(note.timeOfDay, 8).slice(0, 5), fromDate: dayOf(note.fromDate),
        toDate: lastDay(note.toDate), recurring: note.isRecurring === true, days,
        weekdays: days.map((day) => weekdayNames[day]), note: str(note.noteText, maxNote),
        childPersonIds: list(note.childPersonIds).filter((id) => typeof id === 'string') };
    });
  }

  async listCheckoutNotes({ child_id, unit_id, from_date, to_date } = {}) {
    const { child, unit } = await this.#unit(child_id, unit_id, ['afterSchool']);
    const from = dateValue(from_date, 'from_date') || osloToday();
    const to = dateValue(to_date, 'to_date') || addDays(from, 27);
    if (to < from) throw new PublicError('to_date kan ikke være før from_date.');
    const notes = (await this.#notes(child.id, unit.id, from, to)).slice(0, 50);
    return { child: child.name, unit: unit.name, notes: notes.map(({ days, childPersonIds, ...note }) => note) };
  }

  async prepareCheckoutNote({ child_id, unit_id, type_id, from_date, to_date, time, weekdays: days, note } = {}) {
    const recurring = days !== undefined;
    if (recurring && (to_date === undefined || to_date === null)) throw new PublicError('En hentemelding som gjentas, trenger to_date.');
    const dates = period(from_date, to_date, { weekdaysOnly: true });
    // A long range by mistake would apply the same pickup to every day for weeks; make it a deliberate weekly note.
    if (!recurring && dates.days > maxSingleRange) throw new PublicError(`Lengre enn ${maxSingleRange} dager: oppgi weekdays for en ukentlig hentemelding.`);
    const at = timeOfDay(time);
    const noteText = optionalText(note, 'note', maxNote);
    let chosen = null;
    if (recurring) {
      if (!Array.isArray(days) || !days.length || !days.every((day) => weekdays.includes(day))) {
        throw new PublicError(`weekdays må være en liste med ${weekdays.join(', ')}.`);
      }
      chosen = weekdays.filter((day) => days.includes(day));
    }
    const { child, unit } = await this.#unit(child_id, unit_id, ['afterSchool']);
    const type = (await this.#noteTypes(unit.id)).find((item) => item.id === segment(type_id, 'type_id'));
    if (!type) throw new PublicError('Ukjent type hentemelding. Bruk list_checkout_note_types.');
    const deadline = await this.#portal.call('GET', '/check-in-note-configuration/registration-deadlines', {
      query: { organizationalUnitId: unit.id, noteCategory: checkOut } });
    const earliest = osloDay(deadline?.earliestAllowedDate);
    if (!earliest) throw new PublicError('Fant ikke fristen for hentemeldinger hos AKS.');
    if (dates.from < earliest) throw new PublicError(`Fristen er passert: tidligste dato er ${norwegian(earliest)}.`);
    const count = noteDays(dates.from, dates.to, chosen);
    if (!count) throw new PublicError('Ingen av ukedagene er i perioden.');
    const repeats = `${chosen ? `hver uke: ${chosen.map((day) => weekdayNames[day]).join(', ')}` : dates.days === 1 ? 'én dag' : 'hver dag'} (${count} ${count === 1 ? 'dag' : 'dager'})`;
    // Existing notes for the same days, so the parent sees what the new one adds to or contradicts.
    const conflicts = (await this.#notes(child.id, unit.id, dates.from, dates.to))
      .filter((n) => !chosen || !n.days.length || n.days.some((day) => chosen.includes(day)))
      .slice(0, 10).map((n) => `${n.time} ${n.type}${n.note ? `: ${n.note}` : ''} (${[...new Set([n.fromDate, n.toDate].filter(Boolean))].map(norwegian).join('–')}`
        + `${n.recurring ? `, hver uke: ${n.weekdays.join(', ') || 'alle hverdager'}` : ''})`);
    const body = { childPersonIds: [child.id], category: checkOut, typeId: type.id, fromDate: dates.from, toDate: dates.exclusiveTo,
      timeOfDay: `${at}:00`, recurrencePattern: recurring ? { recurrenceType: 'weekly', interval: 1, daysOfWeek: chosen }
        : { recurrenceType: 'daily', interval: 1, daysOfWeek: null }, noteText };
    const verify = async () => (await this.#notes(child.id, unit.id, dates.from, dates.to))
      .some((n) => n.type === type.name && n.time === at && n.fromDate === dates.from && n.toDate === dates.to);
    return this.#prepare('checkout_note', { method: 'POST', path: '/check-in-notes', body, headers: { 'x-organizational-unit-id': unit.id } },
      { child: child.name, unit: unit.name, type: type.name, time: at, dates: dates.text, repeats,
        ...(noteText ? { noteText } : {}), ...(conflicts.length ? { conflicts } : {}),
        warning: 'Dette sier AKS hvordan og når barnet skal hentes eller gå hjem. Sjekk barn, type, tid og datoer nøye.' }, verify);
  }

  async prepareDeleteCheckoutNote({ child_id, unit_id, note_id } = {}) {
    const id = segment(note_id, 'note_id');
    const { child, unit } = await this.#unit(child_id, unit_id, ['afterSchool']);
    const today = osloToday();
    const note = (await this.#notes(child.id, unit.id, today, addDays(today, 366))).find((item) => item.id === id);
    if (!note) throw new PublicError('Fant ikke hentemeldingen. Bruk list_checkout_notes.');
    // A note can cover several children; deleting it removes it for all of them.
    const ids = note.childPersonIds.length ? note.childPersonIds : [child.id];
    const accountChildren = await this.#children();
    const names = ids.map((childId) => fullName(accountChildren.find((item) => item.id === childId)));
    if (names.some((name) => !name)) throw new PublicError('Hentemeldingen gjelder også et barn som ikke er på kontoen. Slett den i Vigilo.');
    const verify = async () => !(await this.#notes(child.id, unit.id, today, addDays(today, 366))).some((item) => item.id === id);
    // Days before the AKS deadline may already be planned for; deleting does not tell the staff in time.
    const deadline = await this.#portal.call('GET', '/check-in-note-configuration/registration-deadlines', {
      query: { organizationalUnitId: unit.id, noteCategory: checkOut } }).catch(() => null);
    const earliest = osloDay(deadline?.earliestAllowedDate);
    const late = !earliest ? 'Fant ikke fristen hos AKS: ring AKS hvis noe gjelder i dag eller i morgen.'
      : note.fromDate && note.fromDate < earliest ? `Hentemeldingen gjelder dager før fristen hos AKS (${norwegian(earliest)}): gi AKS beskjed om disse dagene.` : null;
    return this.#prepare('delete_checkout_note', { method: 'DELETE', path: `/check-in-notes/${id}`, headers: { 'x-organizational-unit-id': unit.id } },
      { children: names, unit: unit.name, type: note.type, time: note.time,
        dates: [...new Set([note.fromDate, note.toDate].filter(Boolean))].map(norwegian).join('–'),
        repeats: note.recurring ? `hver uke: ${note.weekdays.join(', ') || 'alle hverdager'}` : 'hver dag i perioden',
        ...(note.note ? { noteText: note.note } : {}), deletes: 'Hele hentemeldingen slettes, også dager som gjentas.',
        warning: 'Dette endrer hvordan barnet forlater AKS. Sjekk at det finnes en ny avtale.', ...(late ? { deadline: late } : {}) }, verify);
  }

  async #invitations(childId) {
    const data = await this.#portal.call('GET', `/forms/meetings/invitations/${childId}`);
    return list(data?.items).filter((meeting) => meeting && typeof meeting === 'object');
  }

  async listMeetingInvitations({ child_id } = {}) {
    const child = await this.#child(child_id);
    return { child: child.name, meetings: (await this.#invitations(child.id)).slice(0, 50).map((meeting) => ({
      id: typeof meeting.id === 'string' ? meeting.id : undefined, title: str(meeting.title),
      registrationDeadline: localTime(meeting.registrationDeadline) || undefined,
      booked: typeof meeting.reply?.meetingOccurrenceId === 'string' ? meeting.reply.meetingOccurrenceId : undefined,
      times: list(meeting.meetingOccurrences).slice(0, 100).map((time) => ({ id: str(time?.meetingOccurrenceId, 128),
        start: localTime(time?.startTime), end: localTime(time?.endTime), available: time?.isAvailable === true })),
    })) };
  }

  async prepareBookMeeting({ child_id, meeting_id, occurrence_id } = {}) {
    const meetingId = segment(meeting_id, 'meeting_id');
    const occurrenceId = segment(occurrence_id, 'occurrence_id');
    const child = await this.#child(child_id);
    const meeting = (await this.#invitations(child.id)).find((item) => item.id === meetingId);
    if (!meeting) throw new PublicError('Fant ikke møteinvitasjonen. Bruk list_meeting_invitations.');
    if (meeting.registrationDeadline !== undefined && meeting.registrationDeadline !== null) {
      const deadline = osloMs(meeting.registrationDeadline);
      if (!Number.isFinite(deadline)) throw new PublicError('Fant ikke en gyldig frist for møtet. Velg tid i Vigilo.');
      if (deadline < this.#now()) throw new PublicError('Fristen for å velge tid er passert.');
    }
    const time = list(meeting.meetingOccurrences).find((item) => item?.meetingOccurrenceId === occurrenceId);
    if (!time) throw new PublicError('Tiden hører ikke til møtet.');
    if (meeting.reply?.meetingOccurrenceId === occurrenceId) throw new PublicError('Denne tiden er allerede valgt.');
    if (time.isAvailable !== true) throw new PublicError('Tiden er opptatt.');
    const old = list(meeting.meetingOccurrences).find((item) => meeting.reply?.meetingOccurrenceId && item?.meetingOccurrenceId === meeting.reply.meetingOccurrenceId);
    const user = await this.#portal.call('GET', '/current-user');
    const personId = segment(user?.person?.id, 'person');
    const verify = async () => (await this.#invitations(child.id)).some((item) => item.id === meetingId && item.reply?.meetingOccurrenceId === occurrenceId);
    return this.#prepare('book_meeting', { method: 'POST', path: `/forms/meetings/${meetingId}/replies`,
      body: { childPersonId: child.id, meetingOccurrenceId: occurrenceId, inviteePersonId: personId } },
    { child: child.name, meeting: str(meeting.title), start: localTime(time.startTime), end: localTime(time.endTime),
      ...(meeting.reply?.meetingOccurrenceId ? { replaces: old ? `${localTime(old.startTime)}–${localTime(old.endTime)}` : 'tiden som er valgt nå' } : {}) },
    verify);
  }

  // Asks the parent in the client's dialog when the client can. null means it cannot ask, and the client's own tool
  // approval is the check; anything but a clear yes stops it.
  async #confirmed(action, preview) {
    const lines = Object.entries(preview).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join('; ') : value}`);
    const message = `Vigilo: ${action}\n${lines.join('\n')}`;
    const answer = await this.#confirm(message.length > 4_000 ? `${message.slice(0, 3_999)}…` : message);
    if (answer === false) throw new PublicError('Ikke sendt: ikke bekreftet i dialogen. Forbered det på nytt hvis forelderen fortsatt vil.');
  }

  // A failed log write must not turn a completed action into an error. Codes and tokens are never logged.
  async #logged(entry, result) {
    try {
      await mkdir(dirname(this.#log), { recursive: true, mode: 0o700 });
      await appendFile(this.#log, JSON.stringify({ time: new Date(this.#now()).toISOString(), ...entry }) + '\n', { mode: 0o600 });
      await chmod(this.#log, 0o600);
      return result;
    } catch {
      return { ...result, note: [result.note, 'Det ble sendt, men kunne ikke skrives til den lokale loggen.'].filter(Boolean).join(' ') };
    }
  }

  // Not two-step: it only clears the unread mark. Vigilo has no way to mark a thread unread again, so it is confirmed.
  async markThreadRead({ child_id, thread_id } = {}) {
    const child = await this.#child(child_id);
    const threadId = segment(thread_id, 'thread_id');
    const thread = await this.#thread(child.id, threadId);
    const preview = { child: child.name, thread: str(thread.title) };
    await this.#confirmed('mark_thread_read', preview);
    try {
      await this.#portal.call('PUT', `/message-threads/${threadId}/read-status`, { body: { isRead: true } });
    } catch (error) {
      await this.#logged({ action: 'mark_thread_read', ...preview, outcome: error?.uncertain ? 'uncertain' : 'failed' }, {});
      throw error;
    }
    const result = { ...preview, read: true };
    return this.#logged({ action: 'mark_thread_read', ...result }, result);
  }

  async sendPrepared({ confirmation_code: code, summary } = {}) {
    const entry = typeof code === 'string' ? this.#pending.get(code) : undefined;
    if (!entry || entry.expiresAt <= this.#now()) {
      this.#pending.delete(code);
      throw new PublicError('Ukjent eller utløpt kode. Forbered handlingen på nytt.');
    }
    if (summary !== entry.summary) throw new PublicError('summary stemmer ikke med det som ble forberedt. Send summary nøyaktig slik prepare ga den.');
    this.#pending.delete(code);  // single use, also when sending fails, so nothing is sent twice by a retry
    await this.#confirmed(entry.action, entry.preview);
    const { method, path, body, query, headers } = entry.request;
    try {
      await this.#portal.call(method, path, { body, query, headers });
    } catch (error) {
      await this.#logged({ action: entry.action, ...entry.preview, outcome: error?.uncertain ? 'uncertain' : 'failed' }, {});
      throw error;
    }
    const verified = entry.verify ? await entry.verify().catch(() => false) : null;
    const result = { sent: true, action: entry.action, ...entry.preview, ...(verified === null ? {} : { verified }) };
    const shown = verified === false
      ? { ...result, note: 'Vigilo tok imot forespørselen, men viser det ikke ennå. Sjekk i Vigilo.' } : result;
    return this.#logged(result, shown);
  }
}
