# Contributing

Notework AI is an early desktop alpha. Please keep changes small enough to review and test against a disposable vault.

## Before opening an issue

Read [getting started](docs/getting-started.md) and [the roadmap](docs/roadmap.md). A planned feature should not be reported as a shipped feature failing. Include the plugin and Obsidian versions, operating system, connection type, sanitized error, and steps using synthetic notes. Do not include credentials, real account details, raw login output, or private vault contents. Use [SECURITY.md](SECURITY.md) for vulnerabilities.

## Local development

Use Node.js 24.x. The tested development version is recorded in `.node-version`.

```sh
npm ci
npm run lint
npm run build
npm test
```

Build before testing: the compiled mobile-host tests load `dist/notework-ai/main.js`.

Copy the generated `dist/notework-ai/` files into a separate test vault's `.obsidian/plugins/notework-ai/`. Reload and enable the plugin. Never use a real research or work vault as a committed fixture.

Tests use synthetic providers and local subprocess fixtures. `tests/ui-qa.cjs` is a separate browser fixture check; it needs a developer-provided Playwright setup. It does not log into real accounts. A passing test or model catalog does not prove live entitlement, successful inference, or provider approval.

## Pull requests

- Explain the user problem, the changed behavior, and the checks performed.
- Preserve explicit route selection, the difference between connection and inference, and the user's transmission consent.
- Add meaningful regression coverage for credentials, scope, cancellation, stream completion, and provider failures when changing those paths.
- Keep user-visible claims matched to implemented and verified behavior. Update the English README and relevant setup documentation; the alternate README is a redirect.
- Do not add analytics SDKs, automatic code/model installation, silent API fallback, provider tokens, or copied competitor code.
- Disclose dependencies and follow their licenses. Contributions are submitted under this repository's MIT license.

Screenshots should use invented accounts and notes. Review the staged diff and generated assets for credentials, private paths, and real data before submitting. Automated scans supplement that review; they do not guarantee that a file contains no sensitive material.
