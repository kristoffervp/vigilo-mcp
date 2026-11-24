<p align="center"><img src="assets/banner.jpg" alt="Vigilo MCP: en telefon med en melding kobles til en innsjekkingsstatus for AKS" width="100%"></p>

<h1 align="center">Vigilo MCP</h1>

<p align="center">
  <a href="https://github.com/kristoffervp/vigilo-mcp/actions/workflows/test.yml"><img src="https://github.com/kristoffervp/vigilo-mcp/actions/workflows/test.yml/badge.svg" alt="Test"></a>
  <a href="https://github.com/kristoffervp/vigilo-mcp/releases"><img src="https://img.shields.io/github/v/release/kristoffervp/vigilo-mcp" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="Lisens: 0BSD"></a>
</p>

<p align="center">Norsk · <a href="README.md">English</a></p>

En lokal MCP-server som lar en KI-klient lese Vigilos foreldreportal: meldinger, oppslag, timeplanen, inn- og utsjekk på AKS/SFO og meldingsvedlegg. Den leser bare, og kan ikke sende meldinger eller endre noe i Vigilo.

**Uoffisiell.** Ikke laget av eller knyttet til Vigilo AS, skolen eller kommunen. Den bruker udokumenterte endepunkter som kan endres uten varsel.

## Kom i gang

Du trenger Node.js 20 eller nyere og Google Chrome. Innloggingen er testet på macOS.

```sh
git clone https://github.com/kristoffervp/vigilo-mcp.git
cd vigilo-mcp
npm install
npm run login:browser
```

`npm run login:browser` åpner Chrome for innlogging med ID-porten, og `npm test` sjekker serveren uten å bruke kontoen din. Legg så til serveren i KI-klienten som en lokal (stdio) server. For Claude Desktop, i `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vigilo": {
      "command": "node",
      "args": ["/full/sti/til/vigilo-mcp/src/server.js"]
    }
  }
}
```

## Verktøy

| Verktøy | Hva det gjør |
| --- | --- |
| `list_children` | Barna dine og skole- og AKS/SFO-enhetene deres |
| `list_message_threads` | Meldingstråder for ett barn, med AKS/SFO med mindre `include_after_school` er `false`. Filtre: `from_date`, `to_date` |
| `get_message_thread` | Én tråd med meldingene, uten å endre lesestatus |
| `list_news` | Oppslag for ett barn. Filtre: `from_date`, `to_date` |
| `get_after_school_status` | Inn- og utsjekk på SFO/AKS for ett barn på en `date`, med klokkeslett |
| `get_schedule` | Skoletimer og kalenderhendelser for uken som inneholder `date` |
| `get_message_attachment` | Lagrer et meldingsvedlegg i `.data/downloads/` og gir stien |

Begynn med `list_children`. De andre verktøyene tar barnets `id` som `child_id`, og `get_schedule` kan ta en skoleenhets `id` som `school_unit_id`. Uten den brukes barnets første skoleenhet.

Tråder og oppslag gjelder de siste 90 dagene fram til i morgen, med mindre du setter `from_date` og `to_date` (`ÅÅÅÅ-MM-DD`, høyst 366 dager mellom). `date` er dagens dato i Norge hvis den ikke er satt. Lister gir høyst 50 elementer, med `total` og `truncated`, og en tråd viser de siste 50 meldingene. Tekst over 20 000 tegn kuttes og merkes `textTruncated`. Svarene kommer som `structuredContent` og som JSON-tekst.

`get_after_school_status` gir `checked_in`, `checked_out` eller `unknown`, med tidspunktet for siste registrering. `periods` viser hver innsjekk med utsjekken som hører til, som UTC-`time` og norsk `localTime` (`HH:MM`). En dag kan ha flere perioder, for eksempel morgen-AKS før skolen og AKS etter skolen. En periode som ikke er avsluttet, har `checkOut: null`. Den viser det personalet har registrert i Vigilo, og det kan avvike fra hvor barnet er.

Vigilo sier også hvem som registrerte inn- eller utsjekken (ansatt eller forelder). Serveren tar ikke med navnet. Trenger du det, kan det legges til et valg for det.

`get_message_attachment` tar filer opptil 10 MB og gir bare sti, type og størrelse, så klienten må kunne lese lokale filer for å åpne den. Andre typer enn PDF, JPEG, PNG, ren tekst og Word (`.docx`) lagres med `.bin`.

## Fornybar innlogging (valgfritt)

Serveren fornyer nettleserinnloggingen i Chrome uten vindu så lenge Vigilos nettøkt tillater det. Etter det kjører du `npm run login:browser` på nytt.

`npm run login` lager en innlogging som fornyer seg selv med et fornyelsestoken, slik Vigilo-appen gjør. Den trenger en privat `.data/mobile-client.json` med appens OAuth-oppsett (`clientId`, `clientSecret`, `redirectUri`, `authority`), som ikke følger med. Publiser aldri denne filen, og bruk aldri andres. Innloggingen åpner Chrome med en midlertidig profil som slettes etterpå.

- Når `.data/mobile-session.json` finnes, bruker serveren den i stedet for nettleserinnloggingen.
- En fillås hindrer at to prosesser fornyer samtidig (`lockf` på macOS, `flock` på Linux).
- Serveren kjører også på Linux med en fornybar innlogging laget på en annen datamaskin. Kopier `mobile-client.json` og `mobile-session.json` til `.data/`. En fornyelse kan bytte ut fornyelsestokenet, så bruk kopien på bare én datamaskin.

## Slik virker det

Serveren kjører på datamaskinen din og snakker med KI-klienten over stdio. Den bruker den fornybare innloggingen hvis den finnes, og ellers nettleserinnloggingen, begge lagret i `.data/`. `mcp-format.js` merker hvert svar som ikke-betrodd innhold fra Vigilo og holder feilmeldingene generelle.

```mermaid
flowchart LR
  client["KI-klient<br/>for eksempel Claude Desktop"]
  subgraph computer["Din datamaskin"]
    server["MCP-server<br/>server.js, mcp-format.js"]
    tools["Verktøy<br/>portal.js"]
    signin["Innlogging i bruk og fornyelse<br/>session.js, mobile-auth.js"]
    login["npm run login:browser, npm run login<br/>Chrome via Playwright<br/>login.js, login-mobile.js, oauth.js"]
    data[(".data/<br/>innlogging, nettleserprofil,<br/>appoppsett, nedlastinger")]
  end
  idporten["ID-porten"]
  auth["Vigilo-innlogging<br/>auth.prod.vigilo-oas.no"]
  portal["Vigilos foreldreportal<br/>web-parent.prod.vigilo-oas.no"]
  client <-->|"MCP over stdio"| server
  server --> tools
  tools --> signin
  tools <-->|"HTTPS med innloggingen"| portal
  signin -->|"fornyer innloggingen"| auth
  signin -.->|"leser og lagrer innloggingen"| data
  login -->|"logg inn"| idporten
  login -->|"Vigilo-innlogging"| auth
  login -->|"lagrer"| data
  tools -.->|"lagrer vedlegg"| data
```

## Innstillinger

Settes i klientoppsettet (og i Terminal for innloggingskommandoene):

| Variabel | Standard | Brukes til |
| --- | --- | --- |
| `VIGILO_DATA_DIR` | `.data` i denne mappen | Innlogging, nettleserprofilen, appoppsett og nedlastinger |
| `VIGILO_BROWSER_CHANNEL` | `chrome` | Nettleser for innlogging og for fornyelse av nettleserinnloggingen |
| `VIGILO_AUTH_DEBUG` | av | `1` får `npm run login` til å skrive ut vertene innloggingen går gjennom |

## Feilsøking

- **«Vigilo-innloggingen må fornyes».** Innloggingen mangler eller er utløpt. Kjør `npm run login:browser` på nytt, eller `npm run login` hvis du bruker den fornybare innloggingen.
- **«Vigilos appoppsett mangler» eller «er ufullstendig».** `npm run login` trenger en komplett `.data/mobile-client.json`. Bruk `npm run login:browser` i stedet.
- **«Innloggingen tok mer enn ti minutter».** Innloggingen må fullføres innen ti minutter. Velg tilhørighet og åpne **Foreldreportal** hvis du blir bedt om det. Vinduet lukkes når portalen har lastet.
- **«Playwright mangler».** Kjør `npm install` i prosjektmappen.
- **Klienten får ikke startet serveren.** Bruk hele stien til både `node` (fra `command -v node`) og `src/server.js`.
- **«Ugyldige argumenter til Vigilo-verktøyet».** En ID eller dato har feil format. Bruk ID-er fra `list_children` og datoer som `ÅÅÅÅ-MM-DD`.
- **«Vigilo-svaret er for stort».** Bruk en kortere datoperiode. Vedlegg over 10 MB avvises.
- **«Vigilo-kallet kunne ikke fullføres».** Andre feil vises ikke i detalj. Sjekk nettverket og ID-ene, og prøv igjen.

## Sikkerhet og personvern

- Serveren kjører på din datamaskin og åpner ingen nettverksport. En KI-klient du kobler til, kan likevel lese det verktøyene gir, og en KI-tjeneste i skyen får det klienten leser. Vurder selv hva du vil dele.
- Bare utvalgte felt fra Vigilo sendes videre, merket som data og ikke instruksjoner. Det kan ikke stoppe alle forsøk på å styre KI-en gjennom en melding. Bruk klienter du stoler på, og se over verktøykallene.
- Feilmeldinger gjentar ikke Vigilos svar eller innholdet i lokale filer.
- `.data/` inneholder innloggingen din, og kan bare leses av brukeren din. Med nettleserinnloggingen ligger også Chrome-profilen serveren bruker til å fornye den, der. Del den aldri. Vedlegg ligger der til du sletter dem, og stiene klienten får, kan inneholde brukernavnet ditt.
- Se [SECURITY.md](SECURITY.md) for å melde fra om sikkerhetshull.

## Endringslogg

Se [CHANGELOG.no.md](CHANGELOG.no.md) og [Releases](https://github.com/kristoffervp/vigilo-mcp/releases).

## Lisens

[0BSD](LICENSE): bruk, endre og del fritt, også kommersielt, uten krav om kreditering. Lisensen gjelder ikke Vigilo-tjenesten eller innholdet der.
