# ChatGPT connection implementation

The primary 0.4.8 desktop UI uses the separately installed official **Codex app-server**. This is a technical reference for the 0.4.8 implementation, not a claim of universal account entitlement. [Official protocol documentation](https://developers.openai.com/codex/app-server/).

Continue with ChatGPT can reuse an existing official login. A fresh-account action starts the official browser flow. Completion must match the pending login identifier; Notework then checks the account and obtains the runtime model catalog. A browser redirect alone is not success. Stop/timeout closes owned pending work without logging the official client out. Only runtime-provided models and supported reasoning efforts are selectable.

The desktop runtime resolves the native official executable through PATH or configured installation paths, starts app-server over stdio in a dedicated system-temporary working directory, and uses the user's official authentication. It does not read/copy Codex credential files. Subscription subprocesses remove inherited API-key variables. No automatic API fallback is used.

Inference requests supply the explicit question and eligible reference evidence to an ephemeral read-only turn. Shell, hooks and web search are disabled, interactive server requests are rejected, and observed tool items interrupt the request. These controls are limited by upstream runtime behavior and are not an OS sandbox or a comprehensive no-tools guarantee. [Security policy](../SECURITY.md).

The retained `ChatGPTSubscription` direct OAuth adapter is legacy implementation, not the primary Continue with ChatGPT route. Its credentials use Obsidian SecretStorage. Its presence does not promise that a direct OAuth route can use every catalog model or account plan. See [provider boundaries](provider-boundaries.md) for the supported user-facing choices.

Selecting a model makes no generation request. Sending a question uses account allowance, and a completed answer automatically adds one bounded same-model conversation-structure request. Live account checks and synthetic fixtures are separate release evidence; this document does not repeat historical model counts or tests as current guarantees.
