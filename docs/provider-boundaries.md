# Connections, costs, and data flow

Notework AI 0.4.8 is a desktop alpha. You bring your own eligible account, API key, or local model. The MIT-licensed plugin has no access fee; external services set their own eligibility, terms, limits, and prices. A listed model and a Connected indicator do not guarantee permission or remaining allowance.

| Route | Authentication and model selection | Usage |
| --- | --- | --- |
| ChatGPT / Codex | The separately installed official Codex app-server manages browser login and its own credentials. Notework checks the account and reads the runtime catalog; it does not copy Codex credential files. | Your account's available models and Codex limits. No API fallback, imported ChatGPT chats, or all-plans/all-models guarantee. |
| Claude Code | The separately installed, unmodified official CLI handles direct user login. Notework discovers its runtime model menu and passes the selected model. | Eligible account/subscription usage; CLI model discovery alone does not prove entitlement. |
| OpenAI / Anthropic API | Your own key is sent only to the corresponding official endpoint. | Separate API billing; subscriptions do not automatically pay these charges. |
| Ollama chat | A running loopback Ollama server and an installed chat model. | Local inference has no per-call cloud API charge; compute, model licensing and server configuration remain your responsibility. |
| Ollama embeddings | A separate installed embedding model. Keyword retrieval is an explicit alternative. | Local chunk/question embedding. Model weights download only after your explicit download action. |
| Jev | Your own key and available model at `api.typesafe.ai`. | Optional selected-scope category, role, hierarchy and relation judgments at Build; separate Jev usage. No Jev request for graph navigation or conversation structure. |

## Advanced organization and question-by-question evidence

Your personal AI subscription or API-key answer connection is separate from the optional Jev API key. At Build, Jev can organize selected notes into ontology-style categories, roles, hierarchy and candidate relationships. A selected-AI build is another analysis route; basic local structure and retrieval work without Jev. Jev does not answer every question or incur a separate per-question analysis call merely because the graph is open.

Each question updates its current reference notes and retrieval details. Inspect the route, matched chunks, valid/candidate notes, applicable filters and stale-source exclusions, then open the original excerpts. This trace explains retrieval behavior; it does not certify every generated statement.

## The extra request after an answer

After each completed answer, Notework automatically sends one bounded conversation-structure request to the **same selected answer AI**, using the supported selected reasoning effort. It includes up to the latest **20 eligible completed question/answer pairs**, within **32 KiB of serialized UTF-8 request text**. Eligibility verification covers at most **64 distinct source references** across that window. Complete eligible pairs are prioritized from the most recent exchanges. Cards outside that verified window remain locally readable. This is separate from knowledge builds, which still process all eligible scope notes by default. The same account's subscription limits or API billing apply. There is no opt-in checkbox or manual refresh requirement for this behavior.

The structure request labels topics and refinements, branches and follow-ups; it does not replace the original messages. If no complete eligible pair fits the bounded window, no structure request is sent. Opening or closing the summary, selecting a card, and moving its camera make no provider request. Failed structure leaves the answer and recorded cards intact. Current scope, source hashes, and stored source lineage determine eligibility for outgoing assistant text; incompatible earlier turns remain locally readable. These checks reduce stale-source transmission but do not establish that every generated claim is correct.

## Data sent by an action

| Action | Data and destination |
| --- | --- |
| Send cloud question | Question, eligible prior turns, selected retrieved excerpts and note paths, and explicitly attached decoded text go to the selected OpenAI/Anthropic route through API or official CLI. |
| Completed answer | Eligible completed question/answer pairs go to the same selected answer model for automatic conversation structure. |
| Build with AI or Jev analysis | Selected note excerpts go to that configured route for category, hierarchy, role and candidate-relation judgments. |
| Build/query with local embeddings | Note chunks or the question go to the local loopback Ollama server. |
| Download embedding model | Your explicitly requested model is downloaded by the local Ollama server from its configured model source. |
| Graph, source preview or prompt library | Local reads and display; no provider generation request. A local preview can read the full selected note. |

Connection setup can contact authentication services and model catalogs. Provider retention, training, and abuse-monitoring policies apply independently. A local index does not make a cloud answer local.

## Desktop access outside the vault

The plugin resolves official CLI installations through PATH or configured paths, checks installation metadata, starts processes, and uses dedicated working directories in the system temporary folder. Browser login opens official external URLs. Those operations access the local filesystem outside the vault. Codex and Claude Code are not bundled or silently installed. CLI controls attempt to keep inference text-only and restrict tools, hooks, and persistence; they are not an operating-system sandbox and depend on the actual official runtime version.

API keys and retained legacy direct OAuth credentials use Obsidian SecretStorage. Codex and Claude Code retain their own official login. Ordinary settings, local unencrypted indexes, prompt notes, and optional Markdown conversation archives remain on your computer/vault and can be included in your chosen backups or Sync. [Full security policy](../SECURITY.md).

## Official references

- [Codex app-server documentation](https://developers.openai.com/codex/app-server/) explains the installed runtime protocol and authentication path.
- [ChatGPT plan usage for open-source/local apps](https://developers.openai.com/siwc/token-sharing-open-source) explains account eligibility separately from API billing.
- [Claude Code setup](https://code.claude.com/docs/en/setup) and [legal and integration conditions](https://code.claude.com/docs/en/legal-and-compliance) govern the official CLI independently of Notework's license.
- [Ollama embeddings](https://docs.ollama.com/capabilities/embeddings) describe local embedding capability.
- [Obsidian SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) describes vault-local credential storage.

The route descriptions above are based on Notework's code; upstream documentation does not certify this independent plugin. Check your provider's current account terms and catalog before relying on a route.
