# Client inventory — what leaves this repo, and where it goes

**Board:** tosijs-platform #1164 (feeds #1282, then Phase 2 #1261 and Phase 3 #1262).
**Date:** 2026-09-26. **Basis:** a read of every client file, checked against the tosijs-ui
checkout (1.15.5); the surprising claims below were spot-verified by hand.

## Where each piece goes (#1282, decided 2026-09-28)

| Destination | What |
|---|---|
| **`tosijs-blog`** (web components) | Post view, blog shell and sidenav, recent posts, search and the full index, drafts toggle, post editor (markdown / preview / metadata), save and reconcile, publish/unpublish, the proofread **UI**, copy-as-markdown, `blog-pure.ts`. Routing should move to tosijs-ui's `router.ts`, not travel with it. |
| **`tosijs-assets`** (web components) | Asset manager: list, upload (with WebP), rename, delete, insert snippet, `dimensions.ts`. **Blocked on** the platform blob capability (#1136, with #1139) and an insert-into-editor contract to replace `querySelector('xin-post-editor tosi-code')`. |
| **Upstream to tosijs-ui** | Line annotations on `tosi-code` (blocked on tosijs-ui#131); caret colour that follows the theme; per-hunk diff resolutions from `diffResolvable`; a persisted light/dark/system theme-mode store; possibly an ESM-module-loader element. |
| **This repo, server side** (rules and procs) | Draft visibility (already list access); unique/validate/afterWrite (already config plus the hook); the blog cache and `prefetch.ts` → a cached-HTML page server; the proofread/summary **prompts**, if they become stored procs (open decision below); a REST DocStore client (`RestStore`, ROADMAP decision 5). |
| **Admin suite** (owner, 2026-09-28) | `role-manager.ts` → an exported, extensible role manager; a new schema-aware data manager and a rules manager; the asset manager joins them. |
| **Upstream to tosijs-ui: the schema editor** | `schema-editor.ts` → a tosijs-ui schema editor that writes `x-tosi` UI annotations `tosiSchemaForm` honours (tosijs-ui #2454). |
| **Delete** | `src/page-editor.ts` (0 bytes); `src/youtube.ts` (imported nowhere); the dead direct-Firestore helpers in `firebase.ts` (no callers); `page.ts`, the app shell and `sitemap.ts` → the tosijs-ui build. |

**The owner's decisions (2026-09-28):**
1. **AI prompts are stored in a collection, owned or shared**, like any other document. They
   are not hard-coded in the client and not tosijs-blog config. `gen` should run a prompt by
   reference, under the caller's access to that prompt.
2. **RSS: yes.** An RSS feed with enclosures also gives podcasts, so feed items should carry
   media enclosures, not only posts.
3. **The role manager becomes an exported component**, like the asset manager. It works on the
   platform's built-in roles and is designed to be extended.
4. **Direction: an admin suite.** Data, roles, rules and assets are what every host needs and
   what most platforms do half-heartedly. Firebase's console is a standing annoyance:
   - a **data manager**: general-purpose, schema-aware CRUD (tosijs-ui `tosiCrud` +
     `tosiSchemaForm` are the base);
   - a **rules manager**: create collections, manage their schemas and access rules. It pairs
     naturally with the data manager;
   - **the schema editor goes upstream to tosijs-ui** (owner, 2026-09-28; tosijs-ui #2454),
     together with `x-tosi` annotations it writes and `tosiSchemaForm` reads (hide, order,
     collapse into a details panel, choose a widget). Measured: tosijs-schema treats `x-`
     keywords as annotations, so the platform's manifest validator accepts them, while the
     `ui:*` style other libraries use is refused. The rules manager builds on the upstream
     component;
   - the **role manager** and the **asset manager** alongside them.

   Where the suite lives, and what it is called, is still open.

**Two seams make Phase 2 tractable:**
- **`getPrefetchedDoc` / `getPrefetched`** (`src/prefetched.ts:56-83`) is the single read seam for
  SSR data. Replace it and every `window.prefetched` dependency goes with it.
- **Storage** is used only by the asset manager, and it is the only reason `storage.rules` and the
  custom-claims sync still exist. Moving it onto the blob capability retires both.

---

# Client inventory for the blog extraction (board #1164)

Everything below is read-only. The tosijs-ui sibling checkout exists at `../tosijs-ui` (v1.15.5) and I used it to check which primitives already exist.

Four things change the scope before the table:
- **`src/page-editor.ts` is 0 bytes.** There is no page-editor UI anywhere, so there is nothing to extract from it.
- **`src/youtube.ts` is never imported** (grep finds no `./youtube`). `docs/PAGE_COMPONENT.md:101` mentions a different tag, `<xin-youtube>`, which doesn't exist.
- **Most of `src/firebase.ts` is dead:** the direct-Firestore helpers `getRecords`, `listenRecords`, `syncRecords`, `setRecord`, `getVersions`, `deleteRecord` and friends (`firebase.ts:233-657`), plus `pathToUrl`, `getFileMetadata`, `logEvent` and `analytics`. Nothing outside the file uses them. The SDK is still live for Auth (sign-in plus the ID token on every request) and for Storage (the asset manager).
- **Page components are placed by stored content, not code.** `<xin-blog>` and `<tosi-esm>` appear inside `page.source` (`initial_state/firestore/page.json:22,34`), and `xin-page` renders that source with `innerHTML` (`src/page.ts:33-42`).

## Feature table

| # | Feature | Where | Depends on | Bucket | Blockers / coupling |
|---|---|---|---|---|---|
| 1 | Show one post (title, markdown body, author, date; runs LiveExample code blocks in posts) | `blog.ts:429-492` | tosi-markdown-viewer, `LiveExample.insertExamples` with tosijs/tosijsui injected (`:463`); `formatBlogDate` (blog-pure) | (a) tosijs-blog | Theme vars `--xin-blog-pad` / `--xin-blog-body-bg` (`:663-670`) |
| 2 | Blog shell: sidenav with post, recent posts and search; the chevron shows the nav on narrow screens | `blog.ts:544-688` | tosi-sidenav, icons, popMenu | (a) | Author menu is hidden with `bindVisibleIfAuthor: app.user` (`:646`); a `popstate` listener is added on every connect (`:598`) and never removed |
| 3 | Post routing and permalinks: `/blog/Y/M/D/slug`, `?p=id`, fallback to the latest post, history push, back/forward | `blog.ts:164-170, 227-259, 598`; server 301 for legacy `/YYYY/MM/DD/slug` at `functions/src/prefetch.ts:118-124` | window.history, `document.querySelector('xin-blog')` | (a) for the client; the redirect goes to hosting/routing config | Globals. tosijs-ui already has `router.ts` (`defineRoutes` / `navigate`), which should replace this |
| 4 | Recent-posts list (thumbnail from the first image in the content, summary, "Read the post…", current post hidden) | `blog.ts:376-423, 494-542, 122-128`; data from `initBlog` `:322-355` | `service.docs.get` p=post; prefetched `latestPosts` / `post/path=` | (a) | `window.prefetched`; the bindings (`date`, `image`, `blogLink`, `hideCurrentPost`, `visibleIfAuthor`) are registered on the **global** `bindings` registry |
| 5 | Search recent posts, plus a "download full index" button (2000 refs, cached in localStorage `blog-index-cache`) | `blog.ts:141-163, 171-196, 690-799` | `service.docs.get` p=post, f=title,date,summary,keywords,path, o=`date(desc)` unless author/editor (`:176-178`); prefetched `recentPosts` | (a) | Reads `app.user.roles`; localStorage |
| 6 | Published/drafts toggle (authors only) | `blog.ts:759-772, 145-148` | tosi-segmented; `isPublished` (`functions/shared/post`) | (a). The filtering itself is server-side list access (`functions/src/blog.ts:191-205`), i.e. (b) | Relies on the server returning drafts to authors |
| 7 | Blog menu: New Post / Reopen Draft (localStorage `xin-blog-editor-post`) / Edit Post / Asset Manager | `blog.ts:559-593, 108-120, 284-318` | popMenu | (a) | The asset-manager toggle uses `document.querySelector('asset-manager')` and `document.body.append`, which couples tosijs-blog to tosijs-assets |
| 8 | Post editor: markdown CodeMirror + Preview + Metadata tabs (path, date, summary), full-screen overlay | `blog.ts:815-1128, 1350-1558` | tosi-tab-selector, tosi-code, the xin-blog-post preview | (a) | The global `blog.editorPost` proxy; layout hacks with `minHeight:0` |
| 9 | Save post: slug resolution, create vs update, unique-title/path errors, re-read and reconcile, prefetch eviction | `blog.ts:1030-1128`; `resolvePostPath` at `blog-pure.ts:55` | `service.doc.post/put/get` p=`post/<id>`; server `COLLECTIONS.post` unique, validate and `afterWrite` (`functions/src/blog.ts:171-190`) | (a) client; unique/validate/afterWrite are (b) | **Deletes keys from `window.prefetched` (`:1089-1094`)**. Server and client slugify differently (`:1106-1110` vs `functions/src/blog.ts:175`) |
| 10 | Publish now / Unpublish | `blog.ts:1130-1132, 1291-1293` | `UNPUBLISHED_DATE` (shared/post) | (a) | none |
| 11 | AI proofread and fact-check: resolvable diff (Yours / Proofread), Apply/Cancel bar, data-loss guard | `blog.ts:1134-1245, 839-850`; `blog-pure.ts:116-164` | `service.gen.post` modelId `gemini-2.5-pro`, prompt built in the client; tosi-code `diffResolvable` / `showDiff` | (a) UI; the prompt and model choice belong in a (b) stored proc | The prompt is hard-coded client-side, and the endpoint is `gen`, not `doc` |
| 12 | Proofreader margin notes (accepted ✓ / rejected ✗ on each line) | `blog.ts:857-945, 1247-1269`; `blog-pure.ts:73-108` | CodeMirror's EditorView `coordsAtPos` via `tosi-code.editor`; tosijs-ui/diff | (c) | tosijs-ui has no line-annotation or gutter API. The workaround is a DOM overlay because of the duplicate-@codemirror problem, **tosijs-ui#131** |
| 13 | Caret colour fix in dark mode | `blog.ts:947-965` | Injects a style into tosi-code's shadow root | (c): tosi-code should theme its caret | Pokes into shadow DOM with timers |
| 14 | AI summary generation | `blog.ts:1271-1283` | `service.gen.post` | (a) + (b) (prompt as a proc) | The result isn't checked for an Error |
| 15 | Copy as Markdown; HTML→Markdown conversion of legacy HTML posts | `blog.ts:63-84, 1285-1318, 306-309` | turndown (bundled) | (a) | none |
| 16 | Asset manager: floating, draggable, resizable panel; list and filter the `blog` / `public` folders | `asset-manager.ts:68-91, 309-508` | **Storage SDK `listAll`** (`firebase.ts:983`); tosi-float, tosi-sizer, tosi-select | (a) tosijs-assets | Direct SDK use; folder list hard-coded to `'blog,public'` (`:365`) |
| 17 | Upload asset with optional client-side WebP conversion | `asset-manager.ts:264-307`; `firebase.ts:846-936` | **Storage SDK `uploadBytes`**; canvas `toBlob` | (a); the storage side needs a blob capability, (b) | Write authorization lives in **storage.rules + custom claims** |
| 18 | Rename / delete asset | `asset-manager.ts:193-259`; `firebase.ts:943-981` | **Storage SDK** `getMetadata` + download + `uploadBytes` + `deleteObject` (rename = copy then delete, not atomic); TosiDialog | (a) + (b) | Same as #17 |
| 19 | Insert or copy an asset snippet (md / img / video / audio with aspect-ratio), copy URL, view | `asset-manager.ts:102-192`; `dimensions.ts` | `pathToStoredUrl` → `/stored/…` (`functions/src/stored.ts`, a signed-URL redirect) | (a) | **Reaches into `document.querySelector('xin-post-editor tosi-code')`** (`:105`), a hard coupling between the assets and blog packages. Needs an insert-target event or contract |
| 20 | Role manager: floating CRUD over the `role` collection | `role-manager.ts:1-454`; menu entry `index.ts:127-142` | `service.docs.get` / `doc.post` / `doc.put` / `doc.delete` p=role; `RoleSchema` bundled from `functions/shared/role` | (a) as an admin-tools component, but it is really **tosiCrud + tosiSchemaForm** (both exist in tosijs-ui) → closer to (d), replaced by tosiCrud | The admin check is on the client only (`index.ts:13-20`); the schema is compiled in rather than fetched |
| 21 | Schema editor (JSON Schema form) | `schema-editor.ts:1-593` | tosi-select, popMenu, `isSystemField` | **(d), replaced by tosijs-ui `tosiSchemaForm`** (`../tosijs-ui/src/schema-form.ts:871`) | Only role-manager uses it |
| 22 | Page renderer: markdown or raw HTML page source hosting embedded components | `page.ts:1-48` | tosi-markdown-viewer | (d), replaced by the tosijs-ui build / doc-system | `innerHTML` of stored HTML |
| 23 | App shell: header, title/subtitle, page menu of visible pages, footer, hidden "π" sign-in reveal | `index.ts:46-201`; `app.ts` | prefetched `appConfig` / `page` / `visiblePages` (`functions/src/page.ts:20-70`) | (d), replaced by the tosijs-ui build | Globals `window.app/blog/fb/tosi` (`index.ts:24-36`); `app` proxy with `fb` inside it |
| 24 | Theme menu (Light / Dark / System, persisted as localStorage `ui-theme`) and site style | `style.ts:21-53, 115-160`; `index.ts:97-126` | tosijs `invertLuminance` | (c) | tosijs-ui `theme.ts` has dark-mode variables but **no persisted light/dark/system mode store** (no localStorage in `theme.ts`). Brand colours stay site config |
| 25 | Google sign-in/out, auth state, bearer token with retry-on-stale-token | `firebase.ts:160-231, 727-825, 1008-1025`; `app.ts:48-50` (`service.user.get`) | **Firebase Auth SDK**; `/user` also triggers claims sync (`functions/src/utilities.ts:250-262, 434`) | (c): a generic authed REST/DocStore client in tosijs-ui (its `CrudStore` / DocStore seam, `crud.ts:319`); the auth provider is site-specific | `firebase.ts` injects a `#firebase-signin` div into `body` at import time (`:196-204`); emulator auto-connect |
| 26 | SSR prefetch: data injection (`var prefetched`), OG/meta tags, client fallback fetch | `prefetched.ts`; `functions/src/prefetch.ts:37-183`; handlers in `functions/src/blog.ts:50-157` and `functions/src/page.ts:20-70` | `service.prefetchData.get`, `service.doc.get`; `config/blog-cache` doc | (b): becomes a cached-HTML server / stored proc (per ROADMAP) | Fed by the blog cache plus the `afterWrite` cache clear |
| 27 | Blog cache (`config/blog-cache`, 24h, cleared after a post write) | `functions/src/blog.ts:37-48, 73-106, 160-190` | Firestore | (b) | The `PLATFORM_HOOKS.post` name-attached hook |
| 28 | Sitemap (published posts only) | `functions/src/sitemap.ts` | Firestore stream | (d), replaced by the sitemap.xml the tosijs-ui build emits | none |
| 29 | RSS feed | none | none | Absent: there is no RSS in the repo | If wanted, it's (c): tosijs-ui doc-system emits feeds |
| 30 | `<tosi-esm>` dynamic module loader | `tosi-esm.ts`; `/esm` at `functions/src/esm.ts` | `import('/esm/name@ver')`; `module` collection | Component: (c), a generic "load module and call method" primitive (tosijs-ui has none; `via-tag.ts` is different). Endpoint: (b) | Cross-credential cache issue (`reviews/0.2.0-beta.4-cdn-cache.md:35`) |
| 31 | `<youtube-player>` embed | `youtube.ts` | iframe | (d): dead, never imported | none |
| 32 | Loading-state binding on `<main>` | `index.ts:38-50` | global `bindings.loading` | (d), goes with the app shell | none |

## Features that block deleting `prefetch.ts` / `window.prefetched`

- **#1 and #3** (`getPost` / `loadPost` / `postPathFromLocation` read `latestPosts` and `post/path=…`)
- **#4** (`getLatest`)
- **#5** (`getIndex` reads `recentPosts`)
- **#9** (save evicts entries from `window.prefetched`, `blog.ts:1089-1094`)
- **#23** (`app.ts:30-46`: `appConfig`, `page`, `visiblePages`)
- **#26** (the OG/SEO meta tags themselves)

Every read goes through `getPrefetchedDoc` / `getPrefetched` (`prefetched.ts:56-83`). That makes it the single seam to replace with a DocStore read, or with data embedded in the cached HTML.

## Features that block deleting `storage.rules` / custom-claims sync

These all use the Storage client SDK:
- **#16** list (`listAll`)
- **#17** upload (`uploadBytes`)
- **#18** rename/delete (`getMetadata`, `uploadBytes`, `deleteObject`)

`storage.rules` authorizes writes to `blog/` for author and above and to `public/` for admin and above, using `request.auth.token.roles`. Those claims only exist after `syncRolesToCustomClaims` (`functions/src/utilities.ts:250-262`) has run on some authenticated request (`:434`). That is also why a newly promoted author can't upload until they've hit an API endpoint. Nothing else on the client uses Storage or claims.

`/stored` (`functions/src/stored.ts`) is read-only through the Admin SDK and doesn't depend on the rules.

## What the asset manager needs from a platform blob capability (#1136)

1. **list(prefix)** returning name and path, replacing `listAll` (`firebase.ts:983-990`).
2. **put(path, bytes, contentType)** with RBAC per prefix (blog = author+, public = admin+), replacing `uploadBytes` plus `storage.rules`. WebP conversion can stay client-side, or become an optional server transform.
3. **delete(path)**.
4. **move/rename(old, new)**, done atomically on the server, replacing the non-atomic copy-then-delete in the browser (`firebase.ts:953-981`).
5. A **stable public read URL** (the existing `/stored/<path>` redirect).
6. Optionally **metadata** (content type, and width/height so `dimensions.ts` doesn't need to load the media in the browser).
7. **Which folders exist:** today `'blog,public'` is hard-coded (`asset-manager.ts:365`), and this should come from capability config.

Beyond the capability, extraction also needs an **insert-into-editor contract** (for example a custom event, or an editor registry) in place of `querySelector('xin-post-editor tosi-code')` (`asset-manager.ts:105`).

## Generic pieces to upstream to tosijs-ui

| Candidate | Evidence | Already in tosijs-ui? |
|---|---|---|
| JSON-Schema form | `schema-editor.ts` | **Yes**: `tosiSchemaForm` (`schema-form.ts:871`). Delete ours |
| Collection CRUD (the role manager) | `role-manager.ts` | **Yes**: `tosiCrud` + the `CrudStore` seam (`crud.ts:319,376`) |
| Client-side routing | `blog.ts:227-259` | **Yes**: `router.ts` (`defineRoutes`, `navigate`, `tosiRouteView`) |
| Line annotations / gutter markers on tosi-code | `blog.ts:857-945` | **No**. Blocked on tosijs-ui#131 (@codemirror as a peer dependency) |
| Caret colour following the theme in tosi-code | `blog.ts:947-965` | **No** (a bug to report upstream) |
| Reporting diff resolutions from tosi-code | `inferResolutions` (`blog-pure.ts:116`) reverse-engineers the choices | **No**. `diffResolvable` exists but doesn't expose per-hunk choices (`code-editor.ts:27-63`) |
| Persisted light/dark/system theme-mode store | `style.ts:21-53` | **No** (tosijs-ui `theme.ts` only has the variables and the invert) |
| ESM-module-loader element | `tosi-esm.ts` | **No** |
| Authed REST/DocStore client with token refresh-and-retry | `firebase.ts:727-825` | The contract is there (`CrudStore` / DocStore); a REST implementation belongs in this repo (`RestStore`, ROADMAP decision 5) |
| Media-dimensions → aspect-ratio helper | `dimensions.ts` | **No**, but it's small; keep it in tosijs-assets unless another package needs it |
| Floating tool panel | asset-manager, role-manager | **Yes**: `tosiFloat` + `tosiSizer` (already used) |

**Unsure:** proofread and summary (#11, #14). The UI is clearly (a), but whether the prompt and model belong in a stored proc (b) or in tosijs-blog config is a product decision. Right now the client can send any prompt to `gen`.