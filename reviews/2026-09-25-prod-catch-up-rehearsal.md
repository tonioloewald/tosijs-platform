# Production catch-up rehearsal: loewald.com → 0.2.0-beta.4 (D19, step 1)

**Date:** 2026-09-25 · **Code:** `v0.2.0-beta.4` · **Target rehearsed:** service-compris-test (sandbox)

Production (liquid-force-425209-g2) runs functions last deployed **2026-09-18 ~20:54Z**, which is
before `v0.2.0-beta.1`. It has no `claim`/`install`/`token`/`authorize`, and none of the beta
line's fixes.

## Steps

1. **Production backup** (read-only): `bun run backup`. 858 docs (post 851, page 2, module 2,
   config 2, role 1) saved to `~/Backups/tosijs-platform/liquid-force-425209-g2/2026-09-25T19-42-06Z`.
2. **Owner role check:** production's single role document grants `owner, author, developer` and
   is keyed by **uid**, with `_created` present. So the verified-email change (M1) and #24 don't
   affect it.
3. **Clone:** `clone-to-sandbox.js --apply`, run from that backup. It wrote 37 docs: 30
   representative posts (drafts, no-date, `format`, keywords) plus pages, modules, config, and a
   generated owner role for the gcloud account. Production roles are never copied.
4. **Deploy:** `bun run use sandbox`, then build both tiers, then a **full**
   `firebase deploy -P sandbox`: all 15 functions, hosting, rules.

## Results

| Check | Result |
|---|---|
| `verify:sandbox` (public live-site) | 17/17 |
| `verify:sandbox:auth` (authorized, per-run owner) | 17/17, none skipped |
| verify-install | 27/27 |
| verify-batch | 11/11 |
| verify-sequence | 12/12 |
| verify-provenance | 7/7 |
| verify-authorize | 20/20 |
| verify-token | 17/17 |
| SSR home + a cloned post via Hosting | 200, correct `<title>` |
| Browser: post page, sidebar list via `/docs` | renders; no console errors (tracking began after load) |
| SSR cache headers | `cache-control: private`, **identical to production today**, so #27 changed nothing here |

**Not rehearsed:** signing into the editor as a human and saving a post through the UI. The
authorized suite covered writes through the API.

## Production step (owner's to run)

```
bun run use default && bun run build && (cd functions && npm run build)
CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.12 npx -y firebase-tools@latest deploy -P default --force
```

Then run `bun run verify:prod` and check the editor by hand. Rollback: redeploy from the tag
production ran before, or restore documents from the backup through `/doc`.

## Production result (2026-09-25)

Deployed by the owner. All 15 functions on liquid-force-425209-g2 were updated at ~20:30Z, including
the four new ones (`claim`, `install`, `token`, `authorize`).

- `verify:prod`: 17 pass, 0 fail. The 4 authorized checks skip by design: no token is minted
  against production.
- SSR home and post: 200, correct titles, `cache-control: private` (unchanged).
- `/doc` 404: `cache-control: no-store` (#27 live). `/docs` lists posts.
- Browser, home and a post: render fully. No console errors, only deprecation warnings
  (`elementCreator` tag/styleSpec, `<xin-slot>` → `<tosi-slot>`).

**Still owed:** the owner saving one post through the editor.
