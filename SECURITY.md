# Security and data handling

Applies to **Notework AI 0.4.8 desktop alpha**, Obsidian **1.11.4 or later**. Updated 2026-10-08. This describes implementation controls and their limits; it is not a security certification. Release availability and Community Plugins approval must be checked independently.

## Report a problem

Use [GitHub private vulnerability reporting](https://github.com/hpsonghyun/notework-ai/security/advisories/new) if available. Otherwise open an issue containing only a short non-sensitive request for a private reporting channel. Use the reporting channels available in the repository. No guaranteed response time or bug bounty is offered.

Never publish credentials, login URLs/codes, OAuth tokens, raw provider logs, account screenshots or real vault notes. Reproduce with synthetic notes and sanitized steps. Rotate a credential with its provider if it was exposed; deleting a message does not invalidate it.

## What leaves the device

| Action | Destination and content |
| --- | --- |
| Official ChatGPT login | Installed Codex app-server and official browser authorization. The official runtime retains authentication. Notework validates completion/account/catalog without reading or copying Codex credential files. |
| Official Claude login | Separately installed official Claude Code CLI and its browser authorization. The user signs in directly. The CLI retains authentication; Notework does not read its credential files. |
| Cloud answer | The selected OpenAI/Anthropic route receives your question, bounded source excerpts and note paths, eligible prior turns, and explicitly attached text. API routes use your key; CLI routes use your own official login. |
| Automatic conversation structure | After each completed answer, one additional request sends up to the latest 20 eligible completed question/answer pairs within a 32 KiB serialized UTF-8 request limit to the same selected answer model. Eligibility verification covers at most 64 distinct source references across that window. Complete eligible pairs are prioritized from the most recent exchanges; cards outside that verified window stay readable locally. This is not a knowledge-build cap. Its account limits/API billing apply. This is automatic, with no opt-in or manual update requirement. Opening the summary dock makes no request. Jev is not used. |
| Optional AI/Jev knowledge build | When you choose that analysis route and Build knowledge, selected excerpts go to the selected answer AI or `api.typesafe.ai` for category, role, hierarchy and candidate-relation judgments. Jev key/model-list calls contact its service separately. |
| Local Ollama chat/embeddings | Requests go to a loopback server on this computer. Indexing sends chunks; query retrieval can send the question for embedding. Server deployment, model licenses and configuration remain the user's responsibility. |
| Explicit embedding download | The local Ollama server retrieves the requested model weights. Discovery alone never starts a download. |

Cloud provider retention, training, and abuse-monitoring policies remain the provider's own. No developer analytics endpoint or automatic diagnostic-upload feature was found in the reviewed implementation. This statement does not include the necessary authentication, catalog, model, and download traffic listed above.

## Filesystem and process access outside the vault

Desktop operation discovers official Codex/Claude Code executables through PATH or configured absolute paths and checks installation metadata. It launches subprocesses and creates dedicated `notework-codex-*` and `notework-claude-*` working directories under the system temporary folder, outside the vault. The Node runtime and official tool installations are external filesystem dependencies. Hardware guidance reads local memory/thread metadata. Browser login opens validated official external URLs.

Notework does not silently install Codex, Claude Code, or Ollama. Use official installation instructions and an unmodified Claude Code CLI. Do not place vault notes or secrets in the dedicated temporary directories. Review your local process permissions and backup policies.

Codex inference uses ephemeral read-only turns in the dedicated directory, with shell, hooks and web search disabled. Interactive requests are rejected and tool items interrupt the turn. The upstream protocol has no comprehensive no-tools switch; a notification is not proof that it always precedes execution. Claude requests use stdin prompts, no composed shell command, a reduced inherited credential environment, and CLI flags intended to disable tools, hooks, plugins, MCP and session persistence. Unsupported options fail rather than silently broadening execution. These controls depend on official runtime behavior and are not an operating-system sandbox.

## Credentials and local records

- **API keys and retained direct OAuth credentials:** Obsidian SecretStorage is required. Credential values are not written to ordinary settings, Markdown or a plaintext fallback file. SecretStorage is vault-local; it is not an OS keychain, encryption guarantee, or isolation from other installed plugins. Configure credentials locally. [Official storage documentation](https://docs.obsidian.md/plugins/guides/secret-storage).
- **Official CLI login:** Codex and Claude Code retain their own login. Disconnecting their Notework connection closes owned sessions; it does not log the official client out or delete its authentication files. API-key environment variables are removed from subscription subprocesses to prevent implicit API billing.
- **Settings:** Store selected provider/model, scope, options and allowed installation paths. They are not intended to contain credential values.
- **Knowledge index:** Normally `knowledge-index.json` inside `.obsidian/plugins/notework-ai/`. Contains source excerpts, paths, hashes, vectors, categories and relation evidence without encryption. Pending/recovery copies can contain the same private data. Backup/Sync behavior depends on the host and your configuration. These files are excluded from source and release assets.
- **Conversations:** Saved only by Save conversation or optional Save after every answer, in a visible vault folder (default `Notework/Chats`). Records contain exact messages, timestamps, model/context labels, allowlisted retrieval/source evidence, bounded path/hash lineage and valid saved structure. The machine-readable copy uses Base64/checksums for restoration and integrity; neither is encryption or authenticity. Secrets pasted into chat text remain in that text.
- **Prompt library:** Ordinary marked Markdown notes, default `Notework/Prompts`. Prompt notes and the configured conversation archive folder are excluded from retrieval. External edits require a refresh; stale updates are rejected.
- **Attachments:** Supported UTF-8 text is sent on the explicit question request. Saved user turns retain filenames rather than raw attachment bodies. File-derived assistant turns are not automatically reused as evidence for later questions; reattach to use the material again.

## Scope and source checks

Folder/tag exclusions take precedence. Hidden-path files, prompt notes and the configured conversation archive folder are excluded from retrieval. Local keyword search before indexing skips files larger than 1 MB; knowledge builds do not impose that automatic note-size exclusion. All eligible saved-scope notes are processed by default unless explicit note/request/chunk limits are enabled. A cap can leave coverage partial and is reported as such.

Indexed retrieval checks live source identity, current scope and content hashes before sending excerpts. Changed or missing indexed material is excluded pending a rebuild. Graph display filters do not pin retrieval. Pin selected context is explicit; an empty pinned selection blocks indexed chat. A scope/model/provider/knowledge-selection change excludes incompatible earlier provider history while retaining locally visible turns.

Outgoing assistant history and conversation-structure pairs require eligible current sources and complete stored lineage. Inherited path/hash references are checked even when an ancestor turn is outside the outgoing window. Older assistant records without proven lineage remain readable locally but are omitted externally. Eligibility is checked again near transmission; pending structure is invalidated by incompatible context/session changes. These controls do not prove that every generated statement is grounded or that an allowed note contains no secret.

Conversation structure failure preserves the answer and recorded cards; earlier compatible validated structure can remain. If no complete eligible pair fits the bounded window, no structure request is sent. Failed, cancelled and streaming answers do not become completed map pairs. No automatic switch to an API billing route occurs after a subscription or local embedding failure.

Failed/cancelled knowledge builds and failed local saves preserve the previously published index. Compatible vectors may be reused, but builds are not crash-resumable. Optional category, relation and hierarchy judgments are model suggestions, not verification.

## Rendering and stored-note controls

Markdown answers are displayed through Obsidian. Raw HTML/image embeds and known inline-query forms are guarded in the answer display, but arbitrary third-party Markdown postprocessors are not isolated. The stored original answer remains original text. Treat installed plugins and your vault environment as part of the trust boundary.

Archive/prompt paths reject traversal, absolute/hidden paths and reserved Windows forms. New records use unique names. Safe updates revalidate ownership/format inside Obsidian's atomic Vault.process; unsupported or stale updates fail. Malformed and unrelated notes are not treated as owned records. These are application controls, not filesystem permission isolation.

Notes and attachments are treated as reference data in prompts. This is not immunity to prompt injection or hallucinations. Notework does not automatically classify or redact every sensitive passage. Review selected notes before choosing a cloud route.

## Mobile and retained experimental helpers

Mobile is under active development and currently disabled. Android and iOS cannot run this release. Desktop-only metadata and a startup guard prevent this version from initializing on mobile. Disable an older phone copy on the phone itself; a PC update cannot do that remotely. Keep Active community plugin list and Installed community plugin list Sync off on PC and phone. Ordinary Markdown note Sync can continue.

Retained mobile transport, knowledge export/import modules, and historical fixtures are development material. They do not enable current mobile support. An explicit knowledge export can write excerpts/vectors/relationships to `Notework/Sync/knowledge-index.json`, an ordinary unencrypted vault file; no installation-time export occurs. Existing experimental mobile caches are not deleted by the desktop-only change. [Mobile status](docs/mobile-quickstart.md).

## Release evidence and limits

Automated and browser fixtures use invented notes, accounts and provider responses. Website illustrations and screenshots do the same. They do not prove live provider entitlement, model quality, every operating system, or physical phone use. Real account checks and release validation are tracked separately from public-facing copy. No new paid provider request is implied by this document update.

The source, tests, website in `docs/`, and shared assets use one repository. Use version-matched release assets when available and check Community Plugins listing status separately. The former personal-site repository is not a second development target. Credentials, runtime indexes, saved conversations, real vault notes and local QA output do not belong in release/source assets. Only the current alpha is actively maintained; no guaranteed support period is offered.

[Codex app-server guidance](https://developers.openai.com/codex/app-server/), [ChatGPT open-source/local-app conditions](https://developers.openai.com/siwc/token-sharing-open-source), and [Claude Code integration conditions](https://code.claude.com/docs/en/legal-and-compliance) apply independently of the MIT license. Notework does not resell, pool, or proxy other users' subscription access.
