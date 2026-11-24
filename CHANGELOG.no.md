# Endringslogg

[English](CHANGELOG.md)

## 0.2.0 (2026-11-09)

- Den fornybare innloggingen virker på Linux, for eksempel på en Raspberry Pi. Låsen rundt økten bruker `flock` på Linux og `lockf` på macOS. Før dette feilet kall til Vigilo på Linux så snart det første tokenet gikk ut.

## 0.1.0 (2026-10-07)

- Første offentlige versjon: `list_children`, `list_message_threads`, `get_message_thread`, `list_news` og `get_message_attachment`.
- Lagt til samme dag: `get_after_school_status` (inn- og utsjekk på AKS/SFO) og `get_schedule` (timeplan).
