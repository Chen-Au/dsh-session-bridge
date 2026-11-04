# Security Policy

## Reporting

Please report suspected security issues privately via a GitHub Security Advisory
(or open an issue without including exploit details / personal data).

## Scope

- The plugin stores data locally under `<DSH_HOME>/session-bridge/`.
- The HTTP API is intended for loopback use only and validates same-origin requests.
- The install script only edits the DSH profile patch file and copies the plugin
  under a content-hashed filename; it does not modify `node_modules` or install packages.

## Do not commit

- DSH runtime data (`board.jsonl`, `groups.json`, profiles, backups, logs);
- API tokens, provider keys, cookies, or credentials;
- Personal file paths, names, unpublished manuscripts, or private screenshots.

Use the provided `.gitignore` as a baseline and scan before pushing.
