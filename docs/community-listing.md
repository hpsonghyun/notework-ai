# Notework AI community listing draft

Prepared listing draft, 2026-10-08. Version 0.4.8 alpha; desktop Obsidian 1.11.4 or later. This draft does not establish Community Plugins approval. Confirm version-matched release assets and the directory form before submitting.

## Short description

Build a connected knowledge map with optional Jev, ask through your own AI account or API key, and inspect refreshed source references.

## About

1. **Connect your AI.** Use an eligible personal subscription through official Codex or Claude Code, or your own API key.
2. **Build your knowledge.** Add your Jev API key for optional ontology-style organization of selected notes; basic local retrieval works without Jev.
3. **Ask and inspect.** Reference notes, retrieved excerpts, graph highlights and retrieval details update for each question.

**Ask your vault. See the evidence.**

Bring your personal AI subscription or your own API key for answers, and your Jev API key for advanced knowledge organization. Build an ontology-style map of selected Obsidian notes: topic categories, note roles, hierarchy levels and candidate relationships. Then ask in the right sidebar and inspect the reference notes and retrieval details that refresh for each question. Advanced Jev analysis is optional; local basic retrieval works without it.

Explore indexed notes as small luminous stars in a dark 3D graph. Topic colors, hierarchy/role views, source highlights and note previews help you navigate. Display filters do not change later retrieval; use the explicit context pin when you want to narrow it.

Completed conversations are automatically organized into topics, refinements, branches and follow-ups by the selected answer AI. Inspect each exchange's exact original question and answer in the summary dock. This adds one bounded request after a completed answer, under the same provider's limits or API billing: up to the latest 20 eligible completed pairs within 32 KiB of serialized UTF-8. Eligibility verification covers at most 64 distinct source references across that window. Complete eligible pairs are prioritized from the most recent exchanges; cards outside that verified window stay local. This is separate from the full-scope default knowledge build. Opening the map makes no request. Jev is not used for conversation structure.

Save conversations as ordinary Markdown notes and keep reusable prompts in a local library. Automatic archive saving is optional. The interface is English; notes and questions can use other languages.

![Conceptual Notework brand illustration based on its connected N-node logo. Not a product screenshot.](../assets/notework-promo.png)

Categories and relations are model judgments to inspect against original passages. Retrieval details show the route, matched chunks, valid/candidate notes, applicable filters and stale-source exclusions; they do not certify every answer.

## Access and payment disclosure

The MIT-licensed plugin has no access fee. Bring an eligible account, your own API key, or local model:

- ChatGPT through a separately installed official Codex app-server and your own official login. Account model access and Codex limits apply.
- Claude through separately installed, unmodified official Claude Code and direct login. Eligibility and subscription limits apply.
- OpenAI/Anthropic API keys with separate API billing.
- Local Ollama chat and embeddings with installed models. Local inference has no per-call cloud API charge.
- Optional Jev category, role, hierarchy and relation analysis at Build using your own API key. Separate provider usage applies; local retrieval works without it.

No all-plans/all-models or free-subscription-inference promise is made. Optional creator support: [Buy Me a Coffee](https://buymeacoffee.com/namsonghyun2); donations do not unlock features.

## Network and filesystem disclosure

Cloud questions send your question, eligible prior turns, retrieved excerpts and note paths, and explicit text attachments to the chosen provider. Automatic structure sends eligible completed exchanges. Optional AI/Jev builds send selected note excerpts. Connection setup can contact official authentication/model catalogs; Ollama uses a local loopback server and explicit model downloads.

Desktop connections discover official CLIs through PATH/configured paths, inspect installation metadata, launch processes, and create dedicated working directories under the system temporary folder outside the vault. Notework does not install these tools itself. Text-only/restricted execution controls are not an OS sandbox. API keys and retained direct OAuth credentials use vault-local Obsidian SecretStorage; it is not an OS keychain. Local indexes and optional conversation archives contain private unencrypted data. No developer analytics or automatic diagnostic upload was found in the reviewed implementation. Read the security policy before using sensitive notes.

## Compatibility and installation

Desktop only, Obsidian 1.11.4 or later. Mobile is under active development and currently disabled. Disable older mobile copies on the phone and keep installed/active community-plugin-list Sync off; normal Markdown Sync can continue.

Community installation requires an approved listing. Use matching release assets when available, or prepared assets supplied for authorized prerelease review. Manual installation uses `main.js`, `manifest.json` and `styles.css` in the plugin folder. Do not advertise a Community Plugins install button until the listing is approved.

## Gallery and links

Use current synthetic desktop captures, not historical touch or stale UI images:

| Asset | Caption |
| --- | --- |
| `assets/notework-chat.png` | Ask beside your notes and inspect the original source evidence. Invented notes and synthetic provider state. |
| `assets/notework-knowledge.png` | Navigate the knowledge workspace while keeping your document and chat open. Invented notes and synthetic provider state. |
| `assets/notework-overview.svg` | An authored illustration of knowledge, chat and evidence; not a product screenshot. |

- [Repository and README](https://github.com/hpsonghyun/notework-ai) — source, releases and support.
- [Getting started](getting-started.md), [provider boundaries](provider-boundaries.md), [security](../SECURITY.md).
- [Listing preview](community.html).
- Project Pages address: `https://hpsonghyun.github.io/notework-ai/`, when hosting is available. The older personal-site repository is not a second development target.

Directory payment/category fields must use the actual options available at submission. Use the approved metadata version and funding URL; this draft does not substitute for official review.
