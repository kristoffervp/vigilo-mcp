# Endringslogg

[English](CHANGELOG.md)

## 0.3.0 (2026-11-25)

- `get_after_school_status` gir `periods`: hver innsjekk med utsjekken som hører til, i UTC og norsk tid. Før ga den bare siste registrering, så innsjekktiden forsvant når barnet var sjekket ut. Hvem som registrerte, er fortsatt utelatt.

## 0.2.1 (2026-11-25)

- Feilmeldinger om innlogging nevner riktig kommando: `npm run login:browser` for nettleserinnloggingen, `npm run login` for den fornybare. Før sa de alltid `npm run login`.
- `npm run login` åpner Chrome med en midlertidig profil og beholder ikke lenger en i `.data/`. En gammel `.data/mobile-browser-profile/` slettes etter neste vellykkede innlogging.

## 0.2.0 (2026-11-09)

- Den fornybare innloggingen virker på Linux, for eksempel på en Raspberry Pi. Låsen rundt økten bruker `flock` på Linux og `lockf` på macOS. Før dette feilet kall til Vigilo på Linux så snart det første tokenet gikk ut.

## 0.1.0 (2026-10-07)

- Første offentlige versjon: `list_children`, `list_message_threads`, `get_message_thread`, `list_news` og `get_message_attachment`.
- Lagt til samme dag: `get_after_school_status` (inn- og utsjekk på AKS/SFO) og `get_schedule` (timeplan).
