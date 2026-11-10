# Security Policy

## Reporting a vulnerability

layerscope is a fully static, client-side web app. There is no server, no
database, no network calls at runtime, and no data ever leaves the user's
browser. Even so — if you find a vulnerability (e.g. a way for a crafted image
tarball to run script in the page, an integrity bypass, or a parsing bug with
security impact), please report it privately:

1. **Preferred:** open a private security advisory from the repository's
   [Security tab → Report a vulnerability](https://github.com/revolover00/layerscope/security/advisories/new).
2. Alternatively, open a minimal public issue asking for a private contact
   channel — please do **not** include details in the public issue.

You can expect an acknowledgment within a few days. Please give the maintainer
a reasonable window to ship a fix before public disclosure.

Please include, where possible:

- the crafted tarball or a minimal description of its structure
- what you expected to happen vs. what happened
- browser/OS and layerscope version (commit SHA) you tested

## Scope notes

- The 8 GiB fallback-decode limit (`maxLayerBytes`), the 32 MiB
  window-descriptor policy (`WINDOW_TOO_BIG`) and the `rootfs.diff_ids` integrity check
  are documented **design constraints**, not vulnerabilities — but the repair
  path or the error UX can still be improved; feature requests go in a normal
  issue.
- Out-of-scope: issues in the user's own machine (e.g. an already-malicious
  tarball opened in a locally-served instance, social engineering of the
  upload dialog). The app reads the file you explicitly drop — nothing more.

## Past incidents

None published to date. If this changes, notes will be appended here with
the affected versions and the fix commit.
