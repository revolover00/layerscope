---
name: Bug report
about: Something analyzes wrong, refuses, or breaks in the UI
---

**Describe the bug**

**Image tarball that triggers it**
- Layout: legacy docker-save / OCI / OCI multi-arch
- Compression: gzip / zstd / plain
- File size (approx.) and single-layer size (approx.)

**What you expected vs. what happened**

**Console errors** (open devtools → Console)

**Environment**
- layerscope version or commit SHA:
- Browser + version:
- OS:

**Integrity note**
If the failure involves the fallback zstd decoder, include the exact error text
(it names layer index, digests, and the 160 MiB limit). If `rootfs.diff_ids`
mismatch is reported, keep the archive — that is a data-integrity issue worth
investigating, not "just tell me it is fine".
