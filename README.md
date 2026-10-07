# Vigilo MCP

English · [Norsk](README.no.md)

Read Vigilo's parent portal through a local, read-only MCP server. It can list children and their school or after-school units, list and read message threads, list news, read the school schedule, check registered after-school check-in status, and download message attachments. It cannot send messages or change Vigilo data.

**Tested only on macOS with Google Chrome.** Other platforms and browsers have not been tested. This project uses undocumented Vigilo endpoints that may change.

## Install

Install Node.js 20 or later and Google Chrome. Download or clone this repository, open its folder in Terminal, and run:

```sh
npm ci
npm run login:browser
```

Complete ID-porten sign-in in Chrome. Choose your affiliation and open **Foreldreportal** if prompted. The session is saved in the private `.data/` folder. Browser sign-in is short-lived; repeat `npm run login:browser` when it expires. Run `npm test` to check the project without using your account.

Optional renewable sign-in uses `npm run login` or `npm run login:renewable`. It **requires** a private `.data/mobile-client.json` with Vigilo app OAuth configuration, which is not included here. Without that file, use `login:browser`. Never publish your configuration or copy someone else's. Vigilo controls the session lifetime.

## Connect a local MCP client

Add a **stdio MCP server** in your client:

| Field | Value |
| --- | --- |
| Command | Absolute path to Node.js; find it with `command -v node` |
| Arguments | One argument: absolute path to this project's `src/server.js` |
| Working directory | Absolute path to this project folder |
| Environment variables | None required |

Save and restart the client, then check that `vigilo-local-mcp` is connected. `npm start` starts the server directly. A browser chat cannot launch a local stdio process by itself; follow your client's connection instructions.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_children` | List children and units |
| `list_message_threads` | List threads for one child, including after-school units by default |
| `get_message_thread` | Read a thread without changing read status |
| `list_news` | List news for one child |
| `get_after_school_status` | Read the latest registered SFO/AKS check-in or check-out for one child and date |
| `get_schedule` | Read the school timetable and calendar events for the week containing a date |
| `get_message_attachment` | Download an attachment to private `.data/downloads/` and return its path |

Threads and news default to the last 90 days. `from_date` and `to_date` accept `YYYY-MM-DD`, with a maximum range of 366 days per request. Lists return at most 50 entries and indicate truncation. Attachments are limited to 10 MB. Long text may be shortened and marked as such.

For `get_after_school_status`, first use `list_children` to find the child's `id` and confirm an `afterSchool` unit. Pass that ID as `child_id`; `date` is optional and defaults to today's date in Norway. The result is `checked_in`, `checked_out`, or `unknown`, with the time of the latest registration. `unknown` means no usable registration was returned. The result reflects what staff registered in Vigilo and may lag behind the child's actual location.

For `get_schedule`, pass a `child_id` from `list_children`. The optional `date` (`YYYY-MM-DD`) selects its ISO week and defaults to today's date in Norway. If the child has more than one school unit, pass `school_unit_id` from `list_children` to choose one; otherwise the first school unit is used. The result combines lessons and calendar events, with local dates and times as shown in Vigilo. It returns at most 50 entries and indicates truncation. Missing entries may mean that Vigilo has no schedule for that week.

## Privacy and security

The server runs locally over stdio and opens no listening port. A connected AI client can retrieve the Vigilo information you request. Content used with a cloud AI service may be sent to that service. Treat messages and news as untrusted content, review tool calls, and use a client you trust.

Sessions, browser profiles, downloads, and OAuth configuration belong in `.data/` and must stay private. The `.gitignore` allowlist keeps local data and machine-specific files out of a broad `git add .`.

## License

Code and documentation use the [0BSD license](LICENSE). This does not cover Vigilo's service or retrieved data.
