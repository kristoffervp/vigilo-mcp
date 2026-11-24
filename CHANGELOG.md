# Changelog

[Norsk](CHANGELOG.no.md)

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
