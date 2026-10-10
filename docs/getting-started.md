# Getting started with Notework AI

This guide covers **0.4.8 alpha**, desktop Obsidian **1.11.4 or later**. Open the [official Community Plugins listing](https://community.obsidian.md/plugins/notework-ai) and choose **Add to Obsidian**, then install and enable **Notework AI**. You can also use the [version-matched manual installation files](../README.md#installation-and-first-use).

## Try your first question with three notes

The shortest first exercise is a small folder, one question, and a check of its original passages. **You need a ready answer connection.** If you have not connected one, complete the answer-connection step in [Connect and build](#connect-and-build) first. **Connected** confirms authentication and catalog readiness, not remaining allowance or a guaranteed answer.

### 1. Copy the sample folder

Copy these three Markdown files into a new folder named `Notework First Question` in your vault. A test vault is also suitable. All names, dates, decisions and tasks are fictional; these files contain no account setup, API keys or real user notes.

| File | What to inspect |
| --- | --- |
| [01-pilot-brief.md](examples/first-question/01-pilot-brief.md) | The original pilot plan and original review date. |
| [02-pilot-decisions.md](examples/first-question/02-pilot-decisions.md) | The later review-date decision and its reason. |
| [03-pilot-checklist.md](examples/first-question/03-pilot-checklist.md) | Open feedback tasks and the decision still needed. |

Save the file contents as Markdown notes; do not copy the repository's entire `docs` folder into your vault.

### 2. Build only this starting scope

In **Settings → Notework AI → Scope**, select only `Notework First Question` for this walkthrough, check that your existing tag filters and exclusions do not remove it, then choose **Apply scope**.

Open **Build → Build settings**. Set **Retrieval route** to **Keyword search** and **Category, hierarchy and relation analysis** to **Local structure only**, then select **Build knowledge** and wait for local saving to finish. This route needs no Ollama model download or Jev key. The answer model is still a separate, required connection. You can explore embeddings and optional Jev/AI organization later.

### 3. Ask one question

Run **Notework AI: Open Notework**, keep your intended answer model selected, and use **Send question** with this text:

> What is the Harbor pilot review date, why did it change, and what must be ready before the review? Cite the notes and say what is still undecided.

The notes and this prompt are authored examples. No provider answer is bundled or claimed here. Sending a question uses your selected connection; a completed answer also triggers the documented bounded conversation-structure request under the same account's allowance or API billing.

### 4. Open the original passages

Expand **Source notes**, use **Inspect retrieved excerpt**, and open the note-path buttons. Find the named sections below in the original notes and compare them with the response. Use **Retrieval details** to inspect the route, matched chunks, valid sources and applicable filters.

| Check | Original passage to find |
| --- | --- |
| Original plan | **01-pilot-brief → Original plan:** `The original review date was 13 November 2026.` |
| Updated review and reason | **02-pilot-decisions → Review-date decision:** `Move the Harbor pilot review to 16 November 2026.` Feedback closes on 13 November, so the review waits for its completed summary. |
| Work before review | **03-pilot-checklist → Open tasks:** collect ten feedback forms by 13 November and have Mira send the feedback summary before the review. These are open tasks, not completed work. |
| Still undecided | **03-pilot-checklist → Not yet decided:** `No date for a wider rollout has been approved.` |

A response should distinguish the old plan from the later decision and pending tasks from completed work. These checks come from reading the supplied notes, not from a successful model run. If a source is missing or a claim conflicts with its original passage, review the scope and build status; rebuild after editing the sample notes. A source link is a place to check, not a correctness certificate.

After this exercise, change the scope to a small collection of your own notes and use the fuller connection, graph and knowledge-organization options below. Review [connections and costs](provider-boundaries.md) and [security](../SECURITY.md) before sending sensitive material.

## From selected notes to connected knowledge

Use your personal AI subscription or your own API key for answers, and optionally your Jev API key for advanced ontology-style organization. Categories group topics, roles describe a note's purpose, hierarchy separates overview/topic/detail, and candidate relationships connect notes. These are navigation and retrieval judgments to inspect, not automatic fact verification. Local basic retrieval works without Jev.

## Connect and build

Open **Settings → Notework AI → Setup** and follow the five steps.

1. **Connect your answer model.** Choose the official Codex ChatGPT connection, your installed official Claude Code login, an OpenAI/Anthropic API key, or local Ollama chat. Subscription usage and API billing are separate. **Connected** means authentication and the available model catalog are ready; it does not certify remaining allowance or a future answer. Install official external tools yourself when needed.
2. **Prepare retrieval.** Start a local Ollama server and select a verified installed embedding model. Discovery does not download a model. Use the explicit download action if you want the local server to fetch model weights. Alternatively choose **Keyword search**. Embeddings find passages; the answer model is a separate choice.
3. **Optionally connect Jev.** Use your own Jev key for category, role, hierarchy, and candidate-relationship judgments during knowledge construction. Local retrieval works without Jev. Its provider usage is separate from local embeddings and chat.
4. **Choose your notes.** Include folders and optional tags in **Scope**, then **Apply scope**. Parent folders include descendants. Included tags use ANY-match; folder and tag conditions combine, and exclusions take precedence. Review the retrieval and analysis routes, then **Build knowledge**. Eligible scope notes are processed unless you explicitly enable note, AI-request, or chunk limits. A reading counter is only one stage; wait for indexing, analysis when selected, and local saving to complete.
5. **Ask a question.** Run **Notework AI: Open Notework**. Choose the model and supported reasoning effort in the bottom composer, then **Send question**. The selected cloud model receives the question, bounded retrieved excerpts, eligible history, and explicit attachments. Source material is checked against current scope and content hashes before use.

Folder badges and **Check index status** describe local saved coverage and source freshness, not cloud synchronization. Rebuild after changing source notes. Compatible unchanged embeddings are reused. If a build or save fails, the previous saved index remains available. Builds do not provide crash-resume support.

## Inspect the answer and graph

Assistant answers render as Markdown in the right sidebar. For each question, Source notes and Retrieval details refresh to show its current references and retrieval trace: route, matched chunks, valid/candidate notes, applicable filters and stale exclusions. Expand the source evidence and open original notes to verify claims. Select **Show knowledge graph** to add a graph pane beside your current document; chat remains open. A stationary star click opens its original Markdown note in a native pane to the left of the graph.

Left-drag rotates, right-drag or Alt-left-drag pans, and the wheel zooms toward the cursor. **Reset camera** fits the visible stars. Categories, hierarchy levels, roles, and **Only related notes** change visibility only. **Pin selected context** explicitly constrains later retrieval. An explicitly empty pinned selection blocks indexed chat rather than broadening it. Star positions are for navigation, not a measured similarity distance.

The default hierarchy separates Overview, Topic, Detail, and Unassigned notes when an explicit AI/Jev build provides those judgments. Local-only structure leaves abstraction levels Unassigned. Categories, layers, confidence values, and links remain suggestions; they do not prove that two notes have a factual relationship.

## Follow and save a conversation

After a completed answer, Notework automatically records that exchange and requests topic/relationship structure from the same selected answer AI. The request uses up to the latest **20 eligible completed pairs** within **32 KiB serialized UTF-8**. Eligibility verification covers at most **64 distinct source references** across that window. Complete eligible pairs are prioritized from the most recent exchanges; exchanges outside that verified window remain locally readable. This does not cap the knowledge build. It uses the same account's allowance or API billing. Jev does not structure conversations. Failed or cancelled answers do not create completed pairs; a failed structure update leaves the answer intact.

Select **Show conversation summary** to open the resizable dock in the graph. Select a card to inspect its exact original question and answer; **Show question** returns to that exchange in chat. Opening, filtering, or navigating the dock makes no AI request.

Select **Save conversation**, or enable **Save after every answer** in **Archive**. The default folder is `Notework/Chats`. Archives are ordinary Markdown notes and may sync with your vault. They preserve actual turns, model/context labels, sources and valid saved structure. Saving automatically is optional; conversation structure after an answer is automatic. The archive folder is excluded from retrieval.

Use **Prompt library** to create and reuse local Markdown prompts (default `Notework/Prompts`). If a draft already exists, choose **Insert into draft** or **Replace draft**. Neither sends it. Refresh to see external changes; stale editor content cannot silently overwrite a changed prompt note. Prompt notes are excluded from retrieval.

## Attach text files

Use **Add files** or drop files on the composer. Supported UTF-8 formats are `.md`, `.txt`, `.csv`, `.json`, and `.log`. You can attach up to eight files; each is at most 32 KiB and the combined serialized names/text must fit within 32 KiB. Unsupported, binary, invalid UTF-8, and oversized files are rejected instead of silently truncated. PDF, Office, and image attachments are unsupported.

Attaching alone makes no provider request. **Send question** sends the decoded text as reference data to the selected answer model. Attachments do not become graph notes or vault citations. Saved user turns retain filenames, not raw attachment bodies. Reattach a file when a later question needs it. **Enter** sends; **Shift+Enter** adds a line; IME composition does not send.

## Keep a phone vault safe

The plugin is desktop-only. Disable an older Notework installation on the phone itself. Keep **Active community plugin list** and **Installed community plugin list** Sync off on PC and phone; ordinary note Sync can continue. Retained experimental export/import helpers do not enable mobile support. [Mobile status and recovery](mobile-quickstart.md).

Read [connections and costs](provider-boundaries.md) and [security and privacy](../SECURITY.md) before selecting sensitive notes or cloud analysis.
