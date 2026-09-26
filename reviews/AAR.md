# After-action reports

Newest first. Facts, not analysis (tosijs-coding-practices releasing.md step 10).

## 0.2.1 — 2026-09-26

- Went well: both virta-reported fixes landed with live evidence. A 5-way same-id race gave
  exactly one 200, one `_seq`, and a 409 on a changed rewrite. The provenance ceremony caught an
  inconsistency the first fix introduced, where a human and their agent were named differently.
  Staged to served in about 3 minutes.
- Didn't: the #28 fix took three reviews. The first found that `derive:principal` still used
  `userIds[0]`, and that the name could fall back to an email. The second found that `/claim` named
  owners' role documents after their email, so "curated when owned" published it. The third had 0
  blockers.
- Surprised: the email exposure predates 0.2.1 (0.2.0 already published a claimed owner's email),
  and the audit found one email-named role document on virta.
- Friction: the owner's `_by.name` decision was needed mid-release, since no default was safe.
- Cycle: correctness/security B2 → the remediation was incomplete (it missed /claim) → the fix
  was moved to where `_by` is produced → cleared.

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
