# Notework AI roadmap

The 0.4.8 alpha is desktop-only. This page separates implemented behavior from possible future work; it makes no delivery promise.

## Implemented in the current candidate

- Folder/tag scope with explicit exclusions, local retrieval, saved-index coverage and source freshness checks; current reference notes and retrieval details refresh for each question.
- Ollama embeddings or explicit keyword search; optional selected-AI/Jev category, hierarchy, role and relationship judgments during Build for ontology-style note organization.
- Right-sidebar Markdown chat, source evidence, eligible context/history boundaries and bounded text attachments.
- A 3D knowledge graph with note inspection, compact controls, stable colors and explicit retrieval context pinning.
- Automatic selected-AI conversation structure after completed answers, with bounded requests and independent failure handling.
- Optional Markdown conversation saving, history restoration and a local prompt library.
- Official installed Codex/Claude Code connection paths, API connections, and local Ollama chat.

## Release preparation

Each release needs source/privacy review, current synthetic captures, and packaging/credential checks. Public releases and Obsidian Community Plugins review are separate steps: use matching release assets when available, and install from the directory only when its listing is approved. The website lives in the same repository's `docs/` folder when hosting is enabled. Release availability does not imply directory acceptance.

## Possible future directions

Improve evidence inspection, indexing recovery, accessibility and supported-host validation as feedback warrants. Mobile is under active development and currently disabled. Enabling Android/iOS requires a supported architecture and physical-device validation, without a promised release date. Broader knowledge-management ideas are research directions, not current features.

The current alpha remains the maintained line; no long-term support period or feature timetable is guaranteed. [Current guide](getting-started.md) · [Security](../SECURITY.md).
