# After-action reports

Newest first. Facts, not analysis (tosijs-coding-practices releasing.md step 10).

## 0.2.0 — 2026-09-26

- Went well: the first publish through the shared OIDC + staged workflow. It was staged,
  2FA-approved about 7.5 minutes later, and verified: published bytes equal the staged tarball,
  `latest` → 0.2.0, and the registry smoke test passed. Live checks (emulator 53/0 with the
  switch on, sandbox 17 + 94) were run and recorded before the tag.
- Didn't: the first real run failed at Stage with E401. The npm Trusted Publisher entry named a
  different repo from the one publishing (`tosijs-platform`). Nothing reached npm.
- Surprised: `functions/package-lock.json` can't be made `npm ci`-clean (an npm napi-rs
  binding bug), and committing it would likely break Cloud Build deploys. The emulator silently
  loaded the production switch file and made every platform collection inaccessible until its
  registry was seeded.
- Friction: the template assumed `build` is the package build, and a dry run on a tag always
  fails reconciliation. Both are now filed on or fixed in tosijs-coding-practices.
- Cycle: the publish-flow review blocked on version metadata, which reappeared as the consumer
  review's docs blocker in the same files. Remediated once; the re-review found 0 blockers.
