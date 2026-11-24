# Changelog

[Norsk](CHANGELOG.no.md)

## 0.2.0 (2026-11-09)

- The renewable sign-in works on Linux, for example on a Raspberry Pi. The session lock uses `flock` on Linux and `lockf` on macOS. Before this, calls to Vigilo failed on Linux once the first token expired.

## 0.1.0 (2026-10-07)

- First public version: `list_children`, `list_message_threads`, `get_message_thread`, `list_news` and `get_message_attachment`.
- Added the same day: `get_after_school_status` (after-school check-ins) and `get_schedule` (school schedule).
