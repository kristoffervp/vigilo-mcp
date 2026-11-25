# Endringslogg

[English](CHANGELOG.md)

## 0.4.0 (2026-11-25)

- Et brudd i nettet eller en serverfeil mens innloggingen fornyes, sier ikke lenger at innloggingen må fornyes. Bare meldinger serveren selv har skrevet, vises; parser-, fil- og nettleserfeil gir fortsatt en generell melding. Feil argumenter sier nå hvilket argument det gjelder.
- Usynlige tegn (retningsoverstyring, tegn uten bredde og Unicode-tagger) fjernes fra all tekst, og tekst som kuttes midt i en emoji, er fortsatt gyldig.
- Et token Vigilo allerede har fornyet, lagres alltid, også om låsen ble mistet underveis. En uleselig `mobile-session.json` sier at du skal kjøre `npm run login`.
- Nettleserinnloggingen fornyes under samme lås på tvers av prosesser, så to klienter på samme maskin ikke fornyer samtidig.
- Kall kjøres samtidig, så ett tregt kall ikke lenger holder de andre igjen. Ugyldige JSON-RPC-id-er avvises, og versjonen hentes fra `package.json`.
- Private filer skrives slik at en mislykket skriving ikke etterlater en kopi. Lukker du vinduet fra `npm run login`, stopper den med en gang i stedet for etter ti minutter.
- Standarddatoene følger norsk tid. Fjernet det ubrukte aliaset `npm run login:renewable`.

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
