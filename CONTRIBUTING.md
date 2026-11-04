# Contributing

Thanks for helping improve session-bridge / 星桥!

## Before you start

- This plugin targets DSH Desktop. Host APIs are not stable; mention your DSH version in the issue.
- Do not include private DSH data, tokens, personal paths, manuscripts, or screenshots with account info.
- Runtime data lives under `<DSH_HOME>/session-bridge/` and must never be committed.

## Development

```bash
# offline contract tests
node dsh-plugin/test/contract.mjs
```

There is no build step: `dsh-plugin/index.js` is a single ESM host plugin, `client.js` is a hand-written `__ModuleLoader__` bundle, and `app.html` is the standalone social window.

## Pull requests

1. Keep changes focused and describe the user-visible effect.
2. Run the contract tests locally; CI also runs them on `windows-latest`.
3. Update `README.md` / version history when behavior changes.
4. Avoid adding runtime dependencies to the host plugin.
5. Never commit runtime state, logs, backups, or credentials.

## Security

Please report security issues privately via GitHub Security Advisories rather than public issues.

## Language policy

- User-facing changes need an English summary in the PR description and release notes.
- Keep `README.md` and `README.en.md` consistent.
- Release notes must follow [.github/RELEASE_TEMPLATE.md](./.github/RELEASE_TEMPLATE.md): English first, Chinese second.
