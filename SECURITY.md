# Security

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub:
**Security tab → Report a vulnerability** on this repo
([direct link](https://github.com/prdoring/Pat_Engine/security/advisories/new)).
Do not open a public issue for security reports.

This is a solo-maintained project; expect an acknowledgment within a week.

## Scope notes

- The dev server binds `127.0.0.1` by default and is not intended to be exposed to
  untrusted networks. If you set `HOST=0.0.0.0`, set `EDITOR_PASSWORD` too: it gates the
  editor UI and every write API.
- The save API only writes an allowlist of data files and keeps rotated backups under
  `data/.backups/`, which are never served over HTTP.
- The engine uses no `eval` or `new Function`; art angle expressions go through a small
  arithmetic parser, so a strict CSP is safe.
