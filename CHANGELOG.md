# Changelog

[Norsk](CHANGELOG.no.md)

## 0.6.0 (2026-11-25)

- Attachments on `prepare_reply`, `prepare_message` and `prepare_absence` (school only). Off unless `VIGILO_ATTACHMENTS_DIR` names a folder; only PDF, PNG and JPEG files inside it, checked by content, up to 5 files of 5 MB each and 10 MB in all. Files are read at prepare time, and the preview names each file with its size and a short sha256.
- New send tools (with `VIGILO_ALLOW_SEND=1`): `prepare_edit_checkout_note` (change or shorten a check-out note, before and after shown), `prepare_edit_absence` (new dates for a school absence Vigilo marks editable), `prepare_registration_reply` (answer a sign-up) and `mark_news_read`. Edits are refused at send time if the note or absence changed after the preview.
- New read tools, always on: `list_registrations`, `list_required_actions` and `list_consent_forms`. `list_news` shows `type` and `isRead`; `list_absences` and `list_checkout_notes` show what can be edited.
- Attachment files must sit directly in the folder; subfolders, hard links and names with line breaks are refused.
- Check-out notes: every-other-week notes keep their interval when edited, a comment is required or refused by the note type as in the portal (at most 200 characters), and the AKS deadline is checked again when sending. School absences need a note, as in the portal. A note is deletable only when Vigilo says so.
- The confirmation dialog lists every fact first, one line each, and the free text last; only the free text is shortened. Not yet tried against the live service.

## 0.5.0 (2026-11-25)

- Opt-in sending with `VIGILO_ALLOW_SEND=1`: reply in a thread, write to staff, report absence at school or AKS/SFO, delete an absence, add or delete an AKS/SFO check-out note, book a meeting time, and mark a thread read. Every send takes two steps: a `prepare_…` tool, then `send_prepared` with a one-time code. `send_prepared` needs the `summary` the prepare tool returned, and clients that support confirmation dialogs ask the parent there. A send without a clear answer is reported as possibly sent. Sent, failed and uncertain attempts are logged in `.data/sent.jsonl`. Not yet tried against the live service.
- New read tools, always on: `list_contacts`, `list_absences`, `list_absence_codes`, `list_checkout_notes`, `list_checkout_note_types` and `list_meeting_invitations`.

## 0.4.0 (2026-11-25)

- A network or server failure while renewing the sign-in no longer says the sign-in must be renewed. Only messages the server wrote itself are shown; parser, file and browser errors still get a generic message. Wrong arguments now name the argument.
- Invisible characters (direction overrides, zero-width and Unicode tag characters) are removed from all text, and text cut in the middle of an emoji stays valid.
- A token Vigilo has already renewed is always saved, also if the lock was lost meanwhile. An unreadable `mobile-session.json` says to run `npm run login`.
- The browser sign-in renews under the same lock across processes, so two clients on one computer don't renew at once.
- Requests run concurrently, so a slow call no longer blocks the others. Invalid JSON-RPC ids are refused, and the version comes from `package.json`.
- Private files are written so a failed write leaves no copy behind. Closing the `npm run login` window stops it at once instead of after ten minutes.
- Default dates follow Norwegian time. Removed the unused `npm run login:renewable` alias.

## 0.3.0 (2026-11-25)

- `get_after_school_status` returns `periods`: each check-in with its check-out, in UTC and Oslo time. Before, it gave only the latest registration, so the check-in time was lost once the child was checked out. Who registered it is still left out.

## 0.2.1 (2026-11-25)

- Sign-in errors name the right command: `npm run login:browser` for the browser sign-in, `npm run login` for the renewable one. Before, they always said `npm run login`.
- `npm run login` opens Chrome with a temporary profile and no longer keeps one in `.data/`. An old `.data/mobile-browser-profile/` is deleted after the next successful sign-in.

## 0.2.0 (2026-11-09)

- The renewable sign-in works on Linux, for example on a Raspberry Pi. The session lock uses `flock` on Linux and `lockf` on macOS. Before this, calls to Vigilo failed on Linux once the first token expired.

## 0.1.0 (2026-10-07)

- First public version: `list_children`, `list_message_threads`, `get_message_thread`, `list_news` and `get_message_attachment`.
- Added the same day: `get_after_school_status` (after-school check-ins) and `get_schedule` (school schedule).
