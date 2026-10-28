# Coverage and verification

Inspected 2026-10-28. This is a working development version with authenticated community checks, not complete coverage of every itch.io feature.

| Workflow | Commands | Evidence |
| --- | --- | --- |
| Account identity | `whoami` | Live Brave session; account ID and username verified |
| Public project search | `search` | Live project results; page and limit arguments |
| Project/topic reading | `read` | Public and private topic content read |
| File listing/download | `uploads`, `download` | Downloaded an official butler archive, 10,041,882 bytes; no overwrite |
| Build upload/update | `upload` via official butler | Uploaded a 49-byte build, verified successful processing with butler status, downloaded it through the CLI and compared identical bytes; unverified-email failure classified and tested |
| Comments and replies | `comments`, `comment`, `edit-comment`, `delete-comment` | Created, edited, replied to, read back, and deleted a private test reply; parent IDs checked |
| Topics | `topics`, `topic`, `edit-topic`, `delete-topic` | Created and edited a private topic, listed it, created/deleted a second disposable topic |
| Topic movement | `move-targets`, `move-topic` | Moved the private topic into a newly created subcategory and read it there |
| Topic state | `moderate` | Lock/unlock, stick/unstick, archive/unarchive, hide/unhide submitted; persisted state and moderation log inspected |
| Community settings | `community-settings`, `forms`, `configure` | Description, rules, voting and directory type saved and read back; radios and named rich editors supported |
| Categories and tags | `categories`, `create-category`, `edit-category`, `move-category`, `delete-category`, `tag` | Created, edited, hid, reordered and deleted disposable categories; nested parent/child IDs and removal verified; added/removed a tag |
| Owner queues | `moderators`, `bans`, `reports`, `pending-posts`, `logs` | Read empty queues and populated moderation log; returns page text, tables and links |
| Add moderator | `add-moderator` | Actual native form inspected; site's rejection of adding yourself is reported as `WRITE_REJECTED`; successful addition untested |
| Pending post actions | `pending approve/dismiss` | Current frontend source inspected; no pending record available for a live write |
| Report a post | `report` | Actual report dialog inspected, including required category and optional description; no report submitted |
| Ban a post author | `ban` | Frontend source reviewed; no eligible other account in the private fixture; live action untested |
| Remove moderator/unban/report resolution | `remove-moderator`, `unban`, `resolve-report`, `ignore-report` | Runtime discovery of actual administration rows/forms; ambiguous rows rejected in offline tests; no populated live row available |
| Devlog drafts | `devlogs`, `devlog`, `edit-devlog`, `delete-devlog` | Private draft created, edited and read back as unpublished; deletion confirmed by absence from the dashboard |
| Devlog attachments | `devlog-attachments`, `devlog-attach`, `devlog-attachment` | Live file and butler build attachment, file order change, PNG transfer, video link, image/file removal; every save read back. Existing-project-image selection is source/DOM covered, with no available project screenshot for a live attachment |
| Pagination | `topics`, `comments-page`, `comments --all`, queues with `--all`/`--cursor` | Live 60 distinct public topics across pages; private comments resumed at a one-item limit; complete private comment list and moderation log read. Offline multi-page fixtures cover boundaries and cursor scope |
| Public comment | `comment`, `comments` | A user-authorized positive comment posted to a public asset pack and read back |

Publication, bans, moderator invitations/removals, report resolution and pending-post writes are not claimed as live verified. The private fixture has no other users or moderation queue items. No topic-merge control was established from the inspected site, so no guessed merge endpoint is exposed. Queue traversal is implemented; multi-page populated moderation queues remain fixture-tested because the private community has no pending records or other users. The native editor groups file/video attachments separately from images.

Live owner writes used a private Draft project with payments disabled; an anonymous browser received HTTP 404 for its community, category and topic. One test topic/category and the uploaded test build remain. Disposable topics, nested categories, devlogs (including the attachment test draft), a reply and a tag were removed. A positive comment was intentionally left on a public project as authorized. No reports, bans or third-party moderator invitations were sent. Authentication exports and private snapshots are excluded from the repository.

## Reference details

- [fbcli source](https://github.com/brokeboiflex/fbcli): flat commands, Bun/TypeScript exports, browser cookie import, JSON/compact/describe/dry-run, confirmation for writes. Stdout here always contains JSON.
- [Server-side API](https://itch.io/docs/api/serverside): does not provide the requested complete community interface. The CLI uses website forms and their current CSRF inputs.
- [Official butler upload documentation](https://itch.io/docs/butler/pushing.html): `push path user/game:channel`, optional `--userversion`.
- [Public download reference](https://itchio.itch.io/butler): upload IDs, versions, platforms and download controls.
- [Public comment/report reference](https://itch.io/t/92704/retrieve-my-comments-from-the-api): comment markup and report radio values.
- Authenticated owner forms: native comment edit/reply links, topic moderation menu and lightboxes, subcategory move buttons, Redactor fields, tag controls, and administration tabs.
- Current public `community.min.js`: pending-post form actions and defaults; ban/report lightbox dispatch. No undocumented write route is constructed by guessing an endpoint.
- [Chrome DevTools Fetch protocol](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/): response observation pauses Chromium's actual response long enough to read it before itch.io's immediate reload. It does not repeat the write or replace the browser's network transport.

## Checks

TypeScript checking and 27 Bun tests passed, including eight offline Chromium DOM tests. The fixtures reproduce observed reply nesting, moderation-event markup, radio groups, Redactor field association, form controls named `action`, nested category identity ambiguous administration rows, native attachment IDs, and lossless multi-page traversal. The upload test covers literal subprocess arguments and the email-verification error. They load no account cookies and block network access. Live checks above are separate evidence; untested writes remain explicitly marked.

- Current `dashboard.min.js`: attachment hidden fields, upload/build/image identity, image-upload completion, video links, and grouped movement controls. Live uploads used the native picker rather than fabricated multipart requests.
- Current community board markup: `a.page_link.forward_link` next-page URLs; the adapter follows the actual link and retains in-page offsets.
