# Vigilo MCP

Norsk · [English](README.md)

Les Vigilos foreldreportal med en lokal MCP-server som kun henter informasjon. Den kan vise barn og skole- eller AKS/SFO-enheter, liste og lese meldingstråder, vise oppslag og laste ned meldingsvedlegg. Den kan ikke sende meldinger eller endre data i Vigilo.

**Kun testet på macOS med Google Chrome.** Andre plattformer og nettlesere er ikke testet. Prosjektet bruker udokumenterte Vigilo-endepunkter som kan endres.

## Installer

Installer Node.js 20 eller nyere og Google Chrome. Last ned eller klon prosjektet, åpne mappen i Terminal og kjør:

```sh
npm ci
npm run login:browser
```

Fullfør innloggingen via ID-porten i Chrome. Velg tilhørighet og åpne **Foreldreportal** hvis du blir bedt om det. Økten lagres i den private `.data/`-mappen. Nettleserinnloggingen er kortvarig; gjenta `npm run login:browser` når den utløper. Kjør `npm test` for å kontrollere prosjektet uten kontoen din.

Valgfri fornybar innlogging bruker `npm run login` eller `npm run login:renewable`. Den **krever** privat Vigilo-appoppsett i `.data/mobile-client.json`, som ikke følger med her. Bruk `login:browser` uten denne filen. Publiser aldri oppsettet ditt eller kopier andres. Vigilo bestemmer hvor lenge økten varer.

## Koble til en lokal MCP-klient

Legg til en **MCP-server via stdio** i klienten:

| Felt | Verdi |
| --- | --- |
| Kommando | Fullstendig sti til Node.js; finn den med `command -v node` |
| Argumenter | Ett argument: fullstendig sti til prosjektets `src/server.js` |
| Arbeidsmappe | Fullstendig sti til prosjektmappen |
| Miljøvariabler | Ingen påkrevd |

Lagre og start klienten på nytt, og kontroller at `vigilo-local-mcp` er tilkoblet. `npm start` starter serveren direkte. En chat i nettleseren kan ikke starte en lokal stdio-prosess alene; følg klientens tilkoblingsveiledning.

## Verktøy

| Verktøy | Bruk |
| --- | --- |
| `list_children` | Vis barn og enheter |
| `list_message_threads` | List tråder for ett barn, inkludert AKS/SFO som standard |
| `get_message_thread` | Les en tråd uten å endre lesestatus |
| `list_news` | Vis oppslag for ett barn |
| `get_message_attachment` | Last ned vedlegg til privat `.data/downloads/` og returner filstien |

Tråder og oppslag hentes som standard for de siste 90 dagene. `from_date` og `to_date` bruker `YYYY-MM-DD`, med maksimalt 366 dager per kall. Lister viser maks 50 elementer og merker avkorting. Vedlegg er begrenset til 10 MB. Lange tekster kan forkortes og merkes.

## Sikkerhet og personvern

Serveren kjører lokalt via stdio og åpner ingen lyttende nettverksport. En tilkoblet KI-klient kan hente Vigilo-informasjonen du ber om. Innhold brukt med en skybasert KI-tjeneste kan bli sendt dit. Behandle meldinger og oppslag som ikke-betrodd innhold, se gjennom verktøykall og bruk en klient du stoler på.

Økter, nettleserprofiler, nedlastinger og OAuth-oppsett hører hjemme i `.data/` og må holdes private. Tillatelseslisten i `.gitignore` holder lokale data og maskinspesifikke filer unna en bred `git add .`.

## Lisens

Kode og dokumentasjon har [0BSD-lisens](LICENSE). Den gjelder ikke Vigilo-tjenesten eller informasjonen som hentes fra den.
