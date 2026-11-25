import { createHash, randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { attachmentBody, attachmentLines, readAttachments } from './attachments.js';
import { PublicError, clean, dataDir } from './browser.js';
import { addDays, dateValue, osloToday, segment } from './portal.js';

// Sending is off unless VIGILO_ALLOW_SEND=1. Everything that changes Vigilo goes in two steps: a prepare tool checks
// the request and returns exactly what will be sent with a one-time code, and send_prepared sends only that.
// Endpoints and fields are the ones the parent web portal uses; they have not been tried against the live service.
export const sendingEnabled = () => process.env.VIGILO_ALLOW_SEND === '1';

const codeTtl = 10 * 60_000;
const maxPending = 20;
// shortcut: files of pending actions are held in memory, capped so a Raspberry Pi keeps running; move them to temp files if larger uploads are needed.
const maxPendingBase64 = 30_000_000;
const maxText = 5_000;
const maxTitle = 200;
// As in the portal's forms: 250 characters for an absence note, 200 for a check-out note.
const maxNote = 250;
const maxCheckoutNote = 200;
const maxRecipients = 10;
const maxSingleRange = 14;
const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const weekdayNames = { monday: 'mandag', tuesday: 'tirsdag', wednesday: 'onsdag', thursday: 'torsdag', friday: 'fredag' };
const relationNames = { contactTeacher: 'kontaktlærer', subjectTeacher: 'faglærer', departmentEmployee: 'ansatt' };
const checkOut = 'afterSchoolCheckOut';
const registrationTypes = ['singleChoice', 'multipleChoices', 'rankedChoices'];
const requiredActionNames = { fillAllergies: 'Fyll ut helseopplysninger (allergier) i Vigilo.' };

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

// A checked range of days. Vigilo takes the end date exclusive.
function span(from, to, { weekdaysOnly = false } = {}) {
  if (to < from) throw new PublicError('to_date kan ikke være før from_date.');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days > 366) throw new PublicError('Perioden kan ikke være lengre enn ett år.');
  if (weekdaysOnly && [from, to].some((day) => !weekday(day))) throw new PublicError('Hentemeldinger kan bare starte og slutte på en hverdag.');
  return { from, to, days, exclusiveTo: addDays(to, 1), text: from === to ? norwegian(from) : `${norwegian(from)}–${norwegian(to)}` };
}

// A date the parent picks: today or later in Norway, on or before to_date.
function period(fromDate, toDate, options) {
  const from = dateValue(fromDate, 'from_date');
  if (!from) throw new PublicError('from_date mangler.');
  const to = toDate === undefined || toDate === null ? from : dateValue(toDate, 'to_date');
  if (from < osloToday()) throw new PublicError('from_date kan ikke være tilbake i tid.');
  return span(from, to, options);
}

// HH:MM in quarter hours from 07:00 to 18:00, as the portal's time picker offers.
function timeOfDay(value) {
  const match = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  if (!match || Number(match[2]) % 15 !== 0 || value < '07:00' || value > '18:00') {
    throw new PublicError('time må være et kvarter mellom 07:00 og 18:00, som 15:00.');
  }
  return value;
}

function chosenDays(days) {
  if (!Array.isArray(days) || !days.length || !days.every((day) => weekdays.includes(day))) {
    throw new PublicError(`weekdays må være en liste med ${weekdays.join(', ')}.`);
  }
  return weekdays.filter((day) => days.includes(day));
}

// As in the portal: a type with useComment needs a comment, and a type without one has none.
function commentFor(type, given, current) {
  const comment = given ?? current;
  if (type.useComment === true && !comment.trim()) throw new PublicError(`«${type.name}» trenger en kommentar i note, for eksempel hvem som henter.`);
  if (type.useComment === false && comment) {
    if (given) throw new PublicError(`«${type.name}» har ingen kommentar. La note være tom, eller velg en annen type.`);
    return '';
  }
  return comment;
}

const noteDates = (note) => [...new Set([note.fromDate, note.toDate].filter(Boolean))].map(norwegian).join('–');
// The portal offers every week (1) and every other week (2).
const every = (interval) => (interval === 1 ? 'hver uke' : interval === 2 ? 'annenhver uke' : interval ? `hver ${interval}. uke` : 'ukentlig, ukjent intervall');
const weekly = (names, interval) => `${every(interval)}: ${names.join(', ') || 'alle hverdager'}`;
const noteRepeats = (note) => (note.recurring ? weekly(note.weekdays, note.interval) : 'hver dag i perioden');
const repeatsText = (dates, chosen, count, interval = 1) => `${chosen ? weekly(chosen.map((day) => weekdayNames[day]), interval) : dates.days === 1 ? 'én dag' : 'hver dag'} (${count} ${count === 1 ? 'dag' : 'dager'})`;
// What decides a note, to see at send time that nobody changed it after the preview.
const noteState = (n) => JSON.stringify([n.typeId, n.time, n.fromDate, n.toDate, n.recurring, n.interval, n.days, n.rawNote, n.childPersonIds, n.editable]);
// Text from Vigilo that may hold HTML or Markdown, as plain text.
const plain = (value, max) => str(typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim() : '', max);
const oneLine = (value) => String(value).replace(/\s+/g, ' ').trim();
// Text the parent or the AI wrote; shown last, after the facts, in the preview and the dialog.
const freeText = ['text', 'noteText'];
const counter = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

const mondayOf = (iso) => addDays(iso, -((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7));
// Weekdays (Monday–Friday) in the range that a daily or weekly note applies to. Every other week counts from the start week.
// shortcut: assumes Vigilo counts the weeks from from_date's week, as the form suggests; check against the portal's calendar.
function noteDays(from, to, days, interval = 1) {
  let count = 0;
  const start = Date.parse(mondayOf(from));
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const week = Math.round((Date.parse(mondayOf(day)) - start) / (7 * 86_400_000));
    if (weekday(day) && (!days || (days.includes(weekday(day)) && week % interval === 0))) count++;
  }
  return count;
}

const contactLabel = (c) => `${c.name}${[relationNames[c.relation] || c.jobTitle, c.group].filter(Boolean).length
  ? ` (${[relationNames[c.relation] || c.jobTitle, c.group].filter(Boolean).join(', ')})` : ''}`;

export class Sender {
  #portal;
  #confirm;
  #log;
  #now;
  #attachmentsDir;
  #pending = new Map();

  constructor({ portal, confirm = async () => null, log = join(dataDir, 'sent.jsonl'), now = Date.now,
    attachmentsDir = process.env.VIGILO_ATTACHMENTS_DIR }) {
    this.#portal = portal;
    this.#confirm = confirm;
    this.#log = log;
    this.#now = now;
    this.#attachmentsDir = attachmentsDir;
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

  // verify reads the result back after sending; check runs just before sending and refuses if things changed.
  #prepare(action, request, shown, { verify, check, files = [] } = {}) {
    const now = this.#now();
    const { text: body, noteText, ...facts } = shown;
    const preview = { ...facts, ...(body ? { text: body } : {}), ...(noteText ? { noteText } : {}) };
    // File contents count by their hash, so the key stays small and two different files are two requests.
    const key = JSON.stringify(request, (name, value) => (name === 'dataBase64' ? createHash('sha256').update(value).digest('hex') : value));
    // An expired code, or an older code for the very same request, is dropped, so only one code can send it.
    for (const [code, entry] of this.#pending) if (entry.expiresAt <= now || entry.key === key) this.#pending.delete(code);
    if (this.#pending.size >= maxPending) throw new PublicError('For mange forberedte handlinger venter. Send eller la dem gå ut først.');
    const bytes = list(request.body?.attachments).reduce((sum, file) => sum + file.dataBase64.length, 0);
    if (bytes && [...this.#pending.values()].reduce((sum, entry) => sum + entry.bytes, bytes) > maxPendingBase64) {
      throw new PublicError('For mange vedlegg venter på å bli sendt. Send eller la dem gå ut først.');
    }
    const code = randomBytes(4).toString('hex');
    // send_prepared must repeat this line, so a client's approval prompt shows what is sent, not only a code. The facts
    // that decide what happens come first; names and text are shortened to fit, never the facts.
    const factLine = [action, preview.child, preview.children?.join(', '), preview.to?.length && `til ${preview.to.join(', ')}`,
      preview.changes?.length && `endrer ${preview.changes.join('; ')}`,
      preview.type, preview.code, preview.dates, preview.time, preview.repeats, preview.start && `${preview.start}–${preview.end}`,
      files.length && `vedlegg: ${files.map((file) => file.name).join(', ')}`]
      .filter(Boolean).map(oneLine).join(' · ');
    if (factLine.length > 300) throw new PublicError('For mye å vise i én linje. Velg færre mottakere, barn, endringer eller vedlegg.');
    let summary = factLine;
    for (const part of [preview.thread, preview.meeting, preview.registration, preview.selected && `valgt: ${preview.selected}`,
      preview.unit, preview.title,
      (preview.text || preview.noteText) && `«${oneLine(preview.text || preview.noteText).slice(0, 60)}»`].filter(Boolean).map(oneLine)) {
      const room = 300 - summary.length - 3;
      if (room < 2) break;
      summary += ` · ${part.length > room ? `${part.slice(0, room - 1)}…` : part}`;
    }
    this.#pending.set(code, { action, request, preview, verify, check, summary, key, bytes, expiresAt: now + codeTtl });
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

  async prepareReply({ child_id, thread_id, text: body, attachments } = {}) {
    const reply = text(body, 'text', maxText);
    const child = await this.#child(child_id);
    const threadId = segment(thread_id, 'thread_id');
    const thread = await this.#thread(child.id, threadId);
    if (thread.isReplyDisabled) throw new PublicError('Det er slått av å svare i denne tråden.');
    // A reply in a group thread would reach every participant, for example all parents in a class.
    if (thread.isGroupMessageThread) throw new PublicError('Dette er en gruppetråd. Svar i Vigilo, eller skriv en ny melding med prepare_message.');
    // Vigilo's thread has no participant list here, so this shows the people who have written in it.
    const writers = [...new Set(list(thread.messages).map((m) => fullName(m?.sender)).filter(Boolean))].slice(0, 10);
    const files = await readAttachments(this.#attachmentsDir, attachments);
    return this.#prepare('reply', { method: 'POST', path: `/message-threads/${threadId}/reply`, body: { body: reply, attachments: attachmentBody(files) } },
      { child: child.name, thread: str(thread.title), ...(writers.length ? { writtenInThreadBy: writers } : {}), text: reply,
        ...(files.length ? { attachments: attachmentLines(files) } : {}) }, { files });
  }

  async prepareMessage({ child_id, unit_id, recipient_ids, title, text: body, attachments } = {}) {
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
    const files = await readAttachments(this.#attachmentsDir, attachments);
    return this.#prepare('message', { method: 'POST', path: '/message-threads',
      body: { title: subject, body: message, organizationalUnitId: unit.id, recipients, attachments: attachmentBody(files) } },
    { child: child.name, unit: unit.name, to: ids.map((id) => contactLabel(contacts.find((c) => c.id === id))), title: subject, text: message,
      ...(files.length ? { attachments: attachmentLines(files) } : {}) }, { files });
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
      editable: item.isEditable === true && item.organizationalUnit?.type === 'school',
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

  async prepareAbsence({ child_id, unit_id, from_date, to_date, absence_code_id, note, attachments } = {}) {
    const dates = period(from_date, to_date);
    const noteText = optionalText(note, 'note', maxNote);
    const { child, unit } = await this.#unit(child_id, unit_id, ['school', 'afterSchool']);
    // The portal requires a comment on a school absence.
    if (unit.type === 'school' && !noteText) throw new PublicError('Skolen krever en kommentar i note. Ikke skriv helseopplysninger.');
    const codes = await this.#absenceCodes(unit.id);
    let code;
    if (absence_code_id !== undefined) {
      code = codes.find((item) => item.id === segment(absence_code_id, 'absence_code_id'));
      if (!code) throw new PublicError('Ukjent fraværskode for enheten. Bruk list_absence_codes.');
    } else if (unit.type === 'school' && codes.length) throw new PublicError('Skolen krever en fraværskode. Bruk list_absence_codes.');
    const files = await readAttachments(this.#attachmentsDir, attachments);
    // The portal offers attachments on school absences only.
    if (files.length && unit.type !== 'school') throw new PublicError('Vigilo tar bare imot vedlegg på fravær til skolen.');
    const body = { absenceCodeId: code?.id ?? null, organizationalUnitId: unit.id, attachments: attachmentBody(files), note: noteText,
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
        ...(noteText ? { noteText } : {}), ...(files.length ? { attachments: attachmentLines(files) } : {}) }, { verify, files });
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
        ...(shown.code ? { code: shown.code } : {}), ...(shown.note ? { noteText: shown.note } : {}) }, { verify });
  }

  // The portal edits only the dates of a school absence, and only when Vigilo marks it editable.
  async prepareEditAbsence({ child_id, absence_id, from_date, to_date } = {}) {
    const id = segment(absence_id, 'absence_id');
    if (from_date === undefined && to_date === undefined) throw new PublicError('Ingenting å endre: oppgi from_date og/eller to_date.');
    const child = await this.#child(child_id);
    const find = async () => (await this.#absences(child.id)).find((absence) => absence.absenceId === id && absence.isAbsenceDeleted !== true);
    const item = await find();
    if (!item) throw new PublicError('Fant ikke fraværet. Bruk list_absences.');
    const shown = this.#absence(item);
    if (item.organizationalUnit?.type !== 'school') throw new PublicError('Bare skolefravær kan endres i Vigilo. Slett AKS-fraværet og registrer et nytt.');
    if (!shown.editable) throw new PublicError('Vigilo lar ikke dette fraværet endres. Ta kontakt med skolen.');
    if (!shown.fromDate || !shown.toDate) throw new PublicError('Kunne ikke lese datoene i fraværet. Endre det i Vigilo.');
    const unitId = segment(item.organizationalUnit?.id, 'organizationalUnit');
    const dates = span(dateValue(from_date, 'from_date') ?? shown.fromDate, dateValue(to_date, 'to_date') ?? shown.toDate);
    // A running absence can get a new end, but its start cannot be moved back in time.
    if (dates.from !== shown.fromDate && dates.from < osloToday()) throw new PublicError('from_date kan ikke flyttes tilbake i tid.');
    const before = noteDates(shown);
    if (dates.text === before) throw new PublicError('Ingenting å endre: fraværet har allerede disse datoene.');
    const check = async () => {
      const now = await find();
      if (!now || now.isEditable !== true || dayOf(now.fromDate) !== shown.fromDate || lastDay(now.toDate) !== shown.toDate) {
        throw new PublicError('Fraværet er endret siden forhåndsvisningen. Ingenting er sendt; forbered endringen på nytt.');
      }
    };
    const verify = async () => {
      const now = await find();
      return Boolean(now) && dayOf(now.fromDate) === dates.from && lastDay(now.toDate) === dates.to;
    };
    return this.#prepare('edit_absence', { method: 'PUT', path: `/student-absences/${id}`,
      body: { organizationalUnitId: unitId, fromDate: dates.from, toDate: dates.exclusiveTo } },
    { child: child.name, unit: shown.unit, changes: [`datoer ${before} → ${dates.text}`], dates: dates.text,
      ...(shown.code ? { code: shown.code } : {}), ...(shown.note ? { noteText: shown.note } : {}) }, { verify, check });
  }

  async #noteTypes(unitId) {
    const data = await this.#portal.call('GET', '/check-in-note-types', { query: { category: checkOut },
      headers: { 'x-organizational-unit-id': unitId } });
    return list(data?.items).filter((type) => typeof type?.id === 'string')
      .map((type) => ({ id: type.id, name: str(type.name), useComment: type.useComment === true }));
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
      const ids = Array.isArray(note.childPersonIds) ? note.childPersonIds : [note.childPersonId];
      const interval = note.recurrencePattern?.interval;
      return { id: note.id, type: str(note.type?.name), typeId: typeof note.type?.id === 'string' ? note.type.id : undefined,
        time: str(note.timeOfDay, 8).slice(0, 5), fromDate: dayOf(note.fromDate),
        toDate: lastDay(note.toDate), recurring: note.isRecurring === true, days,
        interval: note.isRecurring === true ? (Number.isInteger(interval) && interval > 0 ? interval : undefined) : 1,
        weekdays: days.map((day) => weekdayNames[day]), note: str(note.noteText, maxCheckoutNote),
        // The exact text, sent back unchanged when an edit leaves the comment alone.
        rawNote: typeof note.noteText === 'string' ? note.noteText : '',
        childPersonIds: ids.filter((id) => typeof id === 'string'),
        // As in the portal: a note that has started can at most get a new end date, and only if it repeats.
        editable: note.canUpdate === true ? 'yes' : note.canUpdateToDate === true && note.isRecurring === true ? 'to_date_only' : 'no',
        deletable: note.canDelete === true };
    });
  }

  async #note(childId, unitId, id) {
    const today = osloToday();
    const note = (await this.#notes(childId, unitId, today, addDays(today, 366))).find((item) => item.id === id);
    if (!note) throw new PublicError('Fant ikke hentemeldingen. Bruk list_checkout_notes.');
    return note;
  }

  // A note can cover several children; changing or deleting it does so for all of them.
  async #noteChildren(note, childId) {
    const ids = note.childPersonIds.length ? note.childPersonIds : [childId];
    const accountChildren = await this.#children();
    const names = ids.map((id) => fullName(accountChildren.find((item) => item.id === id)));
    if (names.some((name) => !name)) throw new PublicError('Hentemeldingen gjelder også et barn som ikke er på kontoen. Gjør det i Vigilo.');
    return names;
  }

  async #earliest(unitId) {
    const deadline = await this.#portal.call('GET', '/check-in-note-configuration/registration-deadlines', {
      query: { organizationalUnitId: unitId, noteCategory: checkOut } });
    return osloDay(deadline?.earliestAllowedDate);
  }

  // Existing notes for the same days, so the parent sees what a note adds to or contradicts.
  async #conflicts(childId, unitId, dates, chosen, except) {
    return (await this.#notes(childId, unitId, dates.from, dates.to))
      .filter((n) => n.id !== except && (!chosen || !n.days.length || n.days.some((day) => chosen.includes(day))))
      .slice(0, 10).map((n) => `${n.time} ${n.type}${n.note ? `: ${n.note}` : ''} (${noteDates(n)}${n.recurring ? `, ${weekly(n.weekdays, n.interval)}` : ''})`);
  }

  async listCheckoutNotes({ child_id, unit_id, from_date, to_date } = {}) {
    const { child, unit } = await this.#unit(child_id, unit_id, ['afterSchool']);
    const from = dateValue(from_date, 'from_date') || osloToday();
    const to = dateValue(to_date, 'to_date') || addDays(from, 27);
    if (to < from) throw new PublicError('to_date kan ikke være før from_date.');
    const notes = (await this.#notes(child.id, unit.id, from, to)).slice(0, 50);
    return { child: child.name, unit: unit.name, notes: notes.map(({ days, childPersonIds, typeId, rawNote, ...note }) => ({ ...note, repeats: noteRepeats(note) })) };
  }

  async prepareCheckoutNote({ child_id, unit_id, type_id, from_date, to_date, time, weekdays: days, note } = {}) {
    const recurring = days !== undefined;
    if (recurring && (to_date === undefined || to_date === null)) throw new PublicError('En hentemelding som gjentas, trenger to_date.');
    const dates = period(from_date, to_date, { weekdaysOnly: true });
    // A long range by mistake would apply the same pickup to every day for weeks; make it a deliberate weekly note.
    if (!recurring && dates.days > maxSingleRange) throw new PublicError(`Lengre enn ${maxSingleRange} dager: oppgi weekdays for en ukentlig hentemelding.`);
    const at = timeOfDay(time);
    const given = optionalText(note, 'note', maxCheckoutNote);
    const chosen = recurring ? chosenDays(days) : null;
    const { child, unit } = await this.#unit(child_id, unit_id, ['afterSchool']);
    const type = (await this.#noteTypes(unit.id)).find((item) => item.id === segment(type_id, 'type_id'));
    if (!type) throw new PublicError('Ukjent type hentemelding. Bruk list_checkout_note_types.');
    const noteText = commentFor(type, given, given);
    const deadline = async () => {
      const earliest = await this.#earliest(unit.id);
      if (!earliest) throw new PublicError('Fant ikke fristen for hentemeldinger hos AKS.');
      if (dates.from < earliest) throw new PublicError(`Fristen er passert: tidligste dato er ${norwegian(earliest)}.`);
    };
    await deadline();
    const count = noteDays(dates.from, dates.to, chosen);
    if (!count) throw new PublicError('Ingen av ukedagene er i perioden.');
    const conflicts = await this.#conflicts(child.id, unit.id, dates, chosen);
    const body = { childPersonIds: [child.id], category: checkOut, typeId: type.id, fromDate: dates.from, toDate: dates.exclusiveTo,
      timeOfDay: `${at}:00`, recurrencePattern: recurring ? { recurrenceType: 'weekly', interval: 1, daysOfWeek: chosen }
        : { recurrenceType: 'daily', interval: 1, daysOfWeek: null }, noteText };
    const verify = async () => (await this.#notes(child.id, unit.id, dates.from, dates.to))
      .some((n) => n.type === type.name && n.time === at && n.fromDate === dates.from && n.toDate === dates.to);
    // The deadline is checked again when sending, as it can pass while the preview waits.
    return this.#prepare('checkout_note', { method: 'POST', path: '/check-in-notes', body, headers: { 'x-organizational-unit-id': unit.id } },
      { child: child.name, unit: unit.name, type: type.name, time: at, dates: dates.text, repeats: repeatsText(dates, chosen, count),
        ...(noteText ? { noteText } : {}), ...(conflicts.length ? { conflicts } : {}),
        warning: 'Dette sier AKS hvordan og når barnet skal hentes eller gå hjem. Sjekk barn, type, tid og datoer nøye.' }, { verify, check: deadline });
  }

  // Leaves out a field to keep it. A note that has started can only get a new to_date, as in the portal.
  async prepareEditCheckoutNote({ child_id, unit_id, note_id, type_id, from_date, to_date, time, weekdays: days, note } = {}) {
    const id = segment(note_id, 'note_id');
    const given = Object.entries({ type_id, from_date, to_date, time, weekdays: days, note }).filter(([, value]) => value !== undefined);
    if (!given.length) throw new PublicError('Ingenting å endre: oppgi feltene som skal endres.');
    const onlyToDate = given.length === 1 && given[0][0] === 'to_date';
    const { child, unit } = await this.#unit(child_id, unit_id, ['afterSchool']);
    const old = await this.#note(child.id, unit.id, id);
    if (old.editable === 'no' || (old.editable === 'to_date_only' && !onlyToDate)) {
      throw new PublicError(old.editable === 'no' ? 'Vigilo lar ikke denne hentemeldingen endres. Slett den og lag en ny, eller ring AKS.'
        : 'Hentemeldingen har startet: bare to_date kan endres.');
    }
    if (!old.fromDate || !old.toDate || !old.typeId || (old.recurring && (!old.days.length || ![1, 2].includes(old.interval)))) {
      throw new PublicError('Kunne ikke lese hentemeldingen. Endre den i Vigilo.');
    }
    const names = await this.#noteChildren(old, child.id);
    // shortcut: a weekly note stays weekly unless new weekdays are given; to make it daily, delete it and add a new one.
    const chosen = days !== undefined ? chosenDays(days) : old.recurring ? old.days : null;
    // Every other week stays every other week.
    const interval = chosen && old.recurring ? old.interval : 1;
    let dates;
    if (onlyToDate) {
      // The start may have passed; only the new end date is the parent's choice.
      dates = span(old.fromDate, dateValue(to_date, 'to_date') ?? old.toDate, { weekdaysOnly: true });
    } else dates = period(from_date ?? old.fromDate, to_date ?? old.toDate, { weekdaysOnly: true });
    if (!chosen && dates.days > maxSingleRange) throw new PublicError(`Lengre enn ${maxSingleRange} dager: oppgi weekdays for en ukentlig hentemelding.`);
    const at = timeOfDay(time ?? old.time);
    const types = await this.#noteTypes(unit.id);
    const type = type_id === undefined ? types.find((item) => item.id === old.typeId) ?? { id: old.typeId, name: old.type }
      : types.find((item) => item.id === segment(type_id, 'type_id'));
    if (!type) throw new PublicError('Ukjent type hentemelding. Bruk list_checkout_note_types.');
    // An untouched comment is sent back exactly as Vigilo has it, not the cleaned and shortened copy shown here.
    const noteText = onlyToDate ? old.rawNote : commentFor(type, note === undefined ? undefined : optionalText(note, 'note', maxCheckoutNote), old.rawNote);
    const count = noteDays(dates.from, dates.to, chosen, interval);
    if (!count) throw new PublicError('Ingen av ukedagene er i perioden.');
    const after = { type: type.name, time: at, dates: noteDates({ fromDate: dates.from, toDate: dates.to }),
      repeats: chosen ? weekly(chosen.map((day) => weekdayNames[day]), interval) : 'hver dag i perioden', note: noteText };
    const before = { type: old.type, time: old.time, dates: noteDates(old), repeats: noteRepeats(old), note: old.rawNote };
    const labels = { type: 'type', time: 'tid', dates: 'datoer', repeats: 'gjentas', note: 'kommentar' };
    const changes = Object.keys(labels).filter((key) => before[key] !== after[key])
      .map((key) => (key !== 'note' ? `${labels[key]} ${before[key]} → ${after[key]}` : noteText ? 'kommentar' : 'kommentar fjernes'));
    if (!changes.length) throw new PublicError('Ingenting å endre: hentemeldingen er allerede slik.');
    // Every changed day must be after the AKS deadline, as for a new note; checked again when sending.
    const firstChanged = onlyToDate ? addDays(dates.to < old.toDate ? dates.to : old.toDate, 1) : dates.from < old.fromDate ? dates.from : old.fromDate;
    const deadline = async () => {
      const earliest = await this.#earliest(unit.id);
      if (!earliest) throw new PublicError('Fant ikke fristen for hentemeldinger hos AKS.');
      if (firstChanged < earliest) throw new PublicError(`Fristen er passert: endringen gjelder fra ${norwegian(firstChanged)}, tidligste dato er ${norwegian(earliest)}.`);
    };
    await deadline();
    const conflicts = await this.#conflicts(child.id, unit.id, dates, chosen, id);
    const request = old.editable === 'to_date_only'
      ? { method: 'PUT', path: `/check-in-notes/${id}/to-date`, body: { toDate: dates.exclusiveTo }, headers: { 'x-organizational-unit-id': unit.id } }
      : { method: 'PUT', path: `/check-in-notes/${id}`, headers: { 'x-organizational-unit-id': unit.id },
        body: { typeId: type.id, fromDate: dates.from, toDate: dates.exclusiveTo, timeOfDay: `${at}:00`,
          recurrencePattern: chosen ? { recurrenceType: 'weekly', interval, daysOfWeek: chosen } : { recurrenceType: 'daily', interval: 1, daysOfWeek: null },
          noteText } };
    // Someone else may change the note between preview and send; then the preview's "before" is wrong.
    const check = async () => {
      const now = (await this.#notes(child.id, unit.id, osloToday(), addDays(osloToday(), 366))).find((item) => item.id === id);
      if (!now || noteState(now) !== noteState(old)) throw new PublicError('Hentemeldingen er endret siden forhåndsvisningen. Ingenting er sendt; forbered endringen på nytt.');
      await deadline();
    };
    const verify = async () => (await this.#notes(child.id, unit.id, dates.from, dates.to))
      .some((n) => n.id === id && n.type === type.name && n.time === at && n.fromDate === dates.from && n.toDate === dates.to);
    return this.#prepare('edit_checkout_note', request,
      { children: names, unit: unit.name, changes, type: type.name, time: at, dates: dates.text, repeats: repeatsText(dates, chosen, count, interval),
        ...(noteText ? { noteText: str(noteText, maxCheckoutNote) } : {}),
        before: `${before.time} ${before.type}, ${before.dates}, ${before.repeats}${old.note ? `: ${old.note}` : ''}`,
        ...(conflicts.length ? { conflicts } : {}),
        warning: 'Dette endrer hvordan og når barnet skal hentes eller gå hjem fra AKS. Sjekk før og etter nøye.' }, { verify, check });
  }

  async prepareDeleteCheckoutNote({ child_id, unit_id, note_id } = {}) {
    const id = segment(note_id, 'note_id');
    const { child, unit } = await this.#unit(child_id, unit_id, ['afterSchool']);
    const today = osloToday();
    const note = await this.#note(child.id, unit.id, id);
    if (!note.deletable) throw new PublicError('Vigilo lar ikke denne hentemeldingen slettes. Ring AKS.');
    const names = await this.#noteChildren(note, child.id);
    const verify = async () => !(await this.#notes(child.id, unit.id, today, addDays(today, 366))).some((item) => item.id === id);
    // Days before the AKS deadline may already be planned for; deleting does not tell the staff in time.
    const earliest = await this.#earliest(unit.id).catch(() => undefined);
    const late = !earliest ? 'Fant ikke fristen hos AKS: ring AKS hvis noe gjelder i dag eller i morgen.'
      : note.fromDate && note.fromDate < earliest ? `Hentemeldingen gjelder dager før fristen hos AKS (${norwegian(earliest)}): gi AKS beskjed om disse dagene.` : null;
    return this.#prepare('delete_checkout_note', { method: 'DELETE', path: `/check-in-notes/${id}`, headers: { 'x-organizational-unit-id': unit.id } },
      { children: names, unit: unit.name, type: note.type, time: note.time, dates: noteDates(note), repeats: noteRepeats(note),
        ...(note.note ? { noteText: note.note } : {}), deletes: 'Hele hentemeldingen slettes, også dager som gjentas.',
        warning: 'Dette endrer hvordan barnet forlater AKS. Sjekk at det finnes en ny avtale.', ...(late ? { deadline: late } : {}) }, { verify });
  }

  // The deadline in milliseconds, Infinity if there is none. Refuses a passed or unreadable deadline.
  #beforeDeadline(value, what) {
    if (value === undefined || value === null) return Infinity;
    const deadline = osloMs(value);
    if (!Number.isFinite(deadline)) throw new PublicError(`Fant ikke en gyldig frist for ${what}. Gjør det i Vigilo.`);
    if (deadline < this.#now()) throw new PublicError(`Fristen for ${what} er passert.`);
    return deadline;
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
    this.#beforeDeadline(meeting.registrationDeadline, 'møtet');
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
    { verify });
  }

  async #registrations(childId) {
    const data = await this.#portal.call('GET', `/forms/registrations/invitations/${childId}`);
    return list(data?.items).filter((item) => typeof item?.id === 'string').map((item) => ({ ...item,
      choices: list(item.registrationChoices).filter((c) => typeof c?.registrationChoiceId === 'string')
        .map((c) => ({ id: c.registrationChoiceId, number: Number.isInteger(c.choiceNumber) ? c.choiceNumber : undefined, text: str(c.choiceText) })),
      // The current answer, in rank order; null when not answered.
      answer: item.reply ? list(item.reply.selectedRegistrationChoices).filter((c) => typeof c?.registrationChoiceId === 'string')
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((c) => c.registrationChoiceId) : null }));
  }

  async listRegistrations({ child_id } = {}) {
    const child = await this.#child(child_id);
    return { child: child.name, registrations: (await this.#registrations(child.id)).slice(0, 50).map((item) => ({
      id: item.id, title: str(item.title), unit: str(item.organizationalUnitName) || undefined, type: str(item.registrationType, 40),
      registrationDeadline: localTime(item.registrationDeadline) || undefined, choices: item.choices.slice(0, 50),
      answered: item.answer ?? undefined })) };
  }

  // Single choice takes one id, multiple choice one or more, ranked choice every id in the order wanted.
  async prepareRegistrationReply({ child_id, registration_id, choice_ids } = {}) {
    const registrationId = segment(registration_id, 'registration_id');
    if (!Array.isArray(choice_ids) || !choice_ids.length || choice_ids.length > 50) throw new PublicError('choice_ids må være en liste med ID-er fra list_registrations.');
    const ids = choice_ids.map((id) => segment(id, 'choice_ids'));
    if (new Set(ids).size !== ids.length) throw new PublicError('Samme valg er oppgitt to ganger.');
    const child = await this.#child(child_id);
    const item = (await this.#registrations(child.id)).find((entry) => entry.id === registrationId);
    if (!item) throw new PublicError('Fant ikke påmeldingen. Bruk list_registrations.');
    const deadline = this.#beforeDeadline(item.registrationDeadline, 'påmeldingen');
    const type = item.registrationType;
    if (!registrationTypes.includes(type)) throw new PublicError('Ukjent type påmelding. Svar i Vigilo.');
    const picked = ids.map((id) => item.choices.find((choice) => choice.id === id));
    if (picked.some((choice) => !choice)) throw new PublicError('Valget hører ikke til påmeldingen.');
    if (type === 'singleChoice' && ids.length !== 1) throw new PublicError('Denne påmeldingen tar bare ett valg.');
    if (type === 'rankedChoices' && ids.length !== item.choices.length) throw new PublicError('Ranger alle valgene: oppgi alle choice_ids i ønsket rekkefølge.');
    if (type !== 'rankedChoices' && picked.some((choice) => choice.number === undefined)) throw new PublicError('Kunne ikke lese valgene. Svar i Vigilo.');
    // As in the portal: a ranked answer sends every choice with its place, the others the chosen ones with their number.
    const ordered = type === 'rankedChoices' ? picked : [...picked].sort((a, b) => a.number - b.number);
    const selected = ordered.map((choice, index) => ({ registrationChoiceId: choice.id, rank: type === 'rankedChoices' ? index + 1 : choice.number }));
    const same = (answer) => Array.isArray(answer) && answer.length === ordered.length
      && (type === 'rankedChoices' ? answer.every((id, index) => id === ordered[index].id) : ordered.every((choice) => answer.includes(choice.id)));
    if (same(item.answer)) throw new PublicError('Påmeldingen er allerede besvart slik.');
    const user = await this.#portal.call('GET', '/current-user');
    const personId = segment(user?.person?.id, 'person');
    const choiceText = (id) => item.choices.find((choice) => choice.id === id)?.text || id;
    const check = async () => { if (deadline < this.#now()) throw new PublicError('Fristen for påmeldingen er passert. Ingenting er sendt.'); };
    const verify = async () => same((await this.#registrations(child.id)).find((entry) => entry.id === registrationId)?.answer);
    return this.#prepare('registration_reply', { method: 'POST', path: `/forms/registrations/${registrationId}/replies`,
      body: { childPersonId: child.id, inviteePersonId: personId, selectedRegistrationChoices: selected } },
    { child: child.name, registration: str(item.title), selected: ordered.map((choice) => choice.text).join(', '),
      choices: type === 'rankedChoices' ? ordered.map((choice, index) => `${index + 1}. ${choice.text}`)
        : item.choices.slice(0, 50).map((choice) => `${ids.includes(choice.id) ? '[x]' : '[ ]'} ${choice.text}`),
      ...(Number.isFinite(deadline) ? { deadline: localTime(item.registrationDeadline) } : {}),
      changeable: Number.isFinite(deadline) ? 'Svaret kan endres i Vigilo frem til fristen.' : 'Svaret kan endres i Vigilo senere.',
      ...(item.answer ? { replaces: item.answer.map(choiceText).join(', ') || 'ingen valg' } : {}) }, { verify, check });
  }

  // Read-only: the portal's to-do items (today only health information) and the unread badges per child.
  async listRequiredActions() {
    const actions = await this.#portal.call('GET', '/required-actions');
    const counters = await this.#portal.call('GET', '/children-counters');
    const children = await this.#children();
    const childOf = (id) => children.find((item) => item.id === id);
    return {
      actions: list(actions?.items).slice(0, 50).map((item) => {
        const childId = str(item?.properties?.childId, 128);
        const unitId = str(item?.properties?.organizationalUnitId, 128);
        return { type: str(item?.type, 40), description: Object.hasOwn(requiredActionNames, item?.type) ? requiredActionNames[item.type] : undefined, childId: childId || undefined,
          child: fullName(childOf(childId)) || undefined, unitId: unitId || undefined,
          unit: str(list(childOf(childId)?.organizationalUnits).find((unit) => unit?.id === unitId)?.name) || undefined };
      }),
      unread: list(counters?.counters).filter((item) => typeof item?.childId === 'string').slice(0, 50).map((item) => ({
        childId: item.childId, child: fullName(childOf(item.childId)) || undefined, messageThreads: counter(item.unreadMessageThreadsCounter),
        consents: counter(item.unreadConsentsCounter), absenceNotifications: counter(item.unreadAbsenceNotificationCounter) })),
    };
  }

  // Read-only. Giving or revoking consent is left to Vigilo: a revoked consent cannot be given again there.
  async listConsentForms({ child_id, unit_id } = {}) {
    const { child, unit } = await this.#unit(child_id, unit_id);
    const data = await this.#portal.call('GET', '/consent-forms', { query: { childId: child.id, organizationalUnitId: unit.id } });
    const me = (await this.#portal.call('GET', '/current-user'))?.person?.id;
    const status = (guardian) => (guardian?.consent?.revokedAt ? 'revoked' : guardian?.consent?.givenAt ? 'given' : 'pending');
    const information = plain(data?.consentInformation, 2_000);
    return { child: child.name, unit: unit.name, ...(information ? { information } : {}),
      forms: list(data?.consentForms).filter((form) => typeof form?.id === 'string').slice(0, 50).map((form) => {
        const guardians = list(form.legalGuardians).filter((guardian) => guardian && typeof guardian === 'object');
        const mine = typeof me === 'string' ? guardians.find((guardian) => guardian.id === me) : undefined;
        return { id: form.id, text: plain(form.description, 1_000), status: mine ? status(mine) : 'not_asked',
          answeredAt: localTime(mine?.consent?.revokedAt || mine?.consent?.givenAt) || undefined,
          guardians: guardians.slice(0, 10).map((guardian) => ({ name: fullName(guardian), status: status(guardian) })) };
      }) };
  }

  // Asks the parent in the client's dialog when the client can. null means it cannot ask, and the client's own tool
  // approval is the check; anything but a clear yes stops it.
  async #confirmed(action, preview) {
    // Every fact is one line, so a name with a line break cannot fake another line, and no fact is ever cut.
    const lines = Object.entries(preview).filter(([key]) => !freeText.includes(key))
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.map(oneLine).join('; ') : oneLine(value)}`);
    let message = `Vigilo: ${action}\n${lines.join('\n')}`;
    // Free text comes last and labelled; only it is shortened to fit.
    for (const key of freeText.filter((name) => preview[name])) {
      const heading = `\n\n${key === 'text' ? 'Meldingstekst' : 'Kommentar'} (fritekst):\n`;
      const room = Math.max(500, 4_000 - message.length - heading.length);
      message += heading + (preview[key].length > room ? `${preview[key].slice(0, room - 1)}…` : preview[key]);
    }
    const answer = await this.#confirm(message);
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

  // Not two-step: a mark only clears an unread mark. Vigilo has no way to set it again, so it is confirmed.
  async #mark(action, preview, method, path, body) {
    await this.#confirmed(action, preview);
    try {
      await this.#portal.call(method, path, { body });
    } catch (error) {
      await this.#logged({ action, ...preview, outcome: error?.uncertain ? 'uncertain' : 'failed' }, {});
      throw error;
    }
    const result = { ...preview, read: true };
    return this.#logged({ action, ...result }, result);
  }

  async markThreadRead({ child_id, thread_id } = {}) {
    const child = await this.#child(child_id);
    const threadId = segment(thread_id, 'thread_id');
    const thread = await this.#thread(child.id, threadId);
    return this.#mark('mark_thread_read', { child: child.name, thread: str(thread.title) }, 'PUT', `/message-threads/${threadId}/read-status`, { isRead: true });
  }

  // shortcut: looks back 90 days like list_news, so an older post cannot be marked; take a date if that is needed.
  async markNewsRead({ child_id, post_id } = {}) {
    const child = await this.#child(child_id);
    const postId = segment(post_id, 'post_id');
    const today = osloToday();
    const feed = await this.#portal.call('GET', '/news-feed', { query: { childIds: child.id, fromDate: addDays(today, -90), toDate: addDays(today, 1) } });
    const post = list(feed).find((item) => item?.id === postId);
    if (!post) throw new PublicError('Fant ikke oppslaget de siste 90 dagene. Bruk list_news.');
    // The portal marks only posts as viewed, not other items in the feed.
    if (post.type !== 'post') throw new PublicError('Bare vanlige oppslag kan merkes som lest.');
    const preview = { child: child.name, news: str(post.title ?? post.heading) };
    if (post.isRead === true) return { ...preview, read: true, note: 'Oppslaget var allerede lest. Ingenting er endret.' };
    return this.#mark('mark_news_read', preview, 'POST', '/post-viewings', { postIds: [postId] });
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
    if (entry.check) await entry.check();
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
