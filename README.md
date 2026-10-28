# itchiocli

A Bun CLI and importable TypeScript API following [fbcli](https://github.com/brokeboiflex/fbcli)'s flat commands, browser-session authentication, JSON output, offline `describe`, and `--dry-run` conventions.

**Development version.** Core topic, comment, moderation-state, category, tag, and settings workflows have been exercised in a private authenticated community. Build upload/download, devlog drafts, nested category editing/reordering/deletion, and a public comment also have live verification. Actions on other users and populated moderation queues remain unverified. See [tested workflows and remaining work](docs/coverage.md).

## Run

Requires Bun and a Chromium-family browser.

```sh
bun install --frozen-lockfile
bun itchiocli.ts --help
bun itchiocli.ts describe --compact
```

Use your Brave default profile on macOS:

```sh
export ITCHIOCLI_BROWSER="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
bun itchiocli.ts whoami --cookies brave
```

`--cookies brave:Default` is equivalent. Other Chromium profiles use `--cookies 'brave:Profile 1'`. Cookie import is opt-in and restricted to this service's domains. macOS may request Keychain access. Linux supports basic Chromium storage; keyring-backed profiles and Windows need an exported cookie/storage-state file.

Alternatively, run `login --browser-path /path/to/browser` in an interactive terminal, finish login manually, and press Enter. The session is stored with mode 0600 under `$XDG_CONFIG_HOME/itchiocli/session.json`, defaulting to `~/.config/itchiocli/session.json`. Later commands use it automatically. `--cookies` takes precedence over the `ITCHIOCLI_COOKIES` environment variable and saved session. Accepted files: Playwright storage state, JSON cookie arrays/maps, and Netscape exports. Never commit or share these files.

Browser selection: `--browser-path` / `ITCHIOCLI_BROWSER`, then `--channel` / `ITCHIOCLI_BROWSER_CHANNEL`, then Playwright's installed Chromium. Use `--headed` if the service requires normal browser verification. The CLI does not bypass verification, log in with your password, or change your existing Brave profile.

## Command contract

- `describe [command]` gives the command schema without browser or network access.
- `--dry-run` validates arguments and prints a plan without browser or network access. It cannot validate account permissions or current UI availability.
- Remote writes prompt in a terminal and require `--yes` in noninteractive use.
- `--body-file file.txt` reads a UTF-8 body instead of a positional text argument.
- Output is one JSON result on stdout; `--compact` emits one line. `--json` is accepted for consistency with fbcli. Diagnostics/errors go to stderr.
- Exit 0 means the command returned its stated result, 1 means an operational failure, 2 means invalid usage. A write result with `status: submitted` records an accepted response, not independent persisted-state verification.
- `WRITE_UNCERTAIN` means inspect the destination before retrying. Writes are never automatically retried. A multi-step command can leave a saved draft or partial change when a later step fails.
- Library functions execute directly; CLI confirmation and dry-run handling are not applied to API calls.

## Examples

```sh
bun itchiocli.ts search "pixel art" --limit 10
bun itchiocli.ts read itchio/butler
bun itchiocli.ts uploads itchio/butler
bun itchiocli.ts download itchio/butler UPLOAD_ID ./butler.zip
bun itchiocli.ts upload ./build creator/game:windows --userversion 1.2.0 --yes
bun itchiocli.ts comments https://itch.io/t/TOPIC_ID/topic --cookies brave
bun itchiocli.ts comment https://itch.io/t/TOPIC_ID/topic "Thanks!" --reply-to COMMENT_ID --cookies brave --dry-run
bun itchiocli.ts topic https://itch.io/board/BOARD_ID/board "Release notes" --body-file release.txt --cookies brave --yes
bun itchiocli.ts moderate https://itch.io/t/TOPIC_ID/topic lock --reason "Resolved" --cookies brave --yes
```

Uploads delegate to official [butler](https://itch.io/docs/butler/pushing.html). Install its complete distribution, then `butler login`. Use `--butler /path/to/butler` or `ITCHIOCLI_BUTLER` to select it. Browser cookies do not authenticate butler. The upload target is `user/game:channel`; an existing channel is updated. Build processing may continue after upload. An unverified itch.io email produces `EMAIL_VERIFICATION_REQUIRED`; verify the account email before retrying. Other upload failures produce `UPLOAD_FAILED`.

Downloads require a specific upload ID from `uploads` and a new output path. Existing files are never overwritten. The CLI does not purchase access, install, or execute downloaded games. Paid/restricted files require an already-authorized browser session.

Community commands include `comments`, `comment --reply-to`, `edit-comment`, `delete-comment`, `topics`, `topic`, `edit-topic`, `delete-topic`, `move-targets`, `move-topic`, `moderate`, `report`, and `ban`. Moderation states are `lock`, `unlock`, `stick`, `unstick`, `archive`, `unarchive`, `hide`, and `unhide`. Reports accept `--category off_topic|spam|offensive|other`; they do not also block the author. Use full community URLs for boards/topics. `forms URL` exposes editable form field names on an administration page. `configure URL fields.json --form 0 --yes` submits the selected form using its real CSRF fields; the JSON maps field names to strings or checkbox booleans. It is a low-level form helper, not proof that every admin workflow is supported. Hidden fields, passwords, and file uploads cannot be set with it.

Owner commands: `moderators`, `bans`, `reports`, `pending-posts`, `logs`, `add-moderator`, `remove-moderator`, `unban`, `resolve-report`, `ignore-report`, `pending`, `categories`, `create-category`, `edit-category`, `move-category`, `delete-category`, `tag`, and `community-settings`. Start with the full project community URL or an administration URL. `describe COMMAND` lists each command's arguments. Queue reads return text, tables, and links from the loaded page.

```sh
bun itchiocli.ts reports https://creator.itch.io/game/community --cookies brave
bun itchiocli.ts move-targets https://itch.io/t/TOPIC_ID/topic --cookies brave
bun itchiocli.ts move-topic https://itch.io/t/TOPIC_ID/topic CATEGORY_ID --cookies brave --yes
bun itchiocli.ts tag https://creator.itch.io/game/community announcements --cookies brave --yes
bun itchiocli.ts tag https://creator.itch.io/game/community announcements --remove --cookies brave --yes
bun itchiocli.ts community-settings https://creator.itch.io/game/community settings.json --cookies brave --yes
```

Example `settings.json`:

```json
{
  "category[description]": "Community discussion",
  "category[rules]": "Keep discussion relevant and respectful.",
  "category[voting_type]": "up_down"
}
```

Text values are plain text. `category[type]` accepts the actual radio values `post_list` or `directory`; directories need a subcategory before new topics can be created. Use `create-category` on a directory community. `pending ... approve|dismiss` never implicitly reports spam or bans an author. `delete-comment` refuses a topic's first post; deleting the whole topic requires `delete-topic`.

Category IDs are returned by `categories` and `create-category`. `create-category --parent CATEGORY_ID` creates a nested category. `edit-category URL CATEGORY_ID fields.json` accepts `title`, `description`, `archived`, `hidden`, and `directory`; unrelated fields are preserved. `move-category URL CATEGORY_ID up|down` reorders siblings. Deleting a category uses the site's native removal control.

`remove-moderator` and `unban` take the username or record ID shown on the admin page. `resolve-report` and `ignore-report` take a report ID. These commands find a unique matching row and use its actual action and CSRF fields; they fail if the page is ambiguous or changes. Populated rows still require live verification.

Devlog commands use the dashboard game ID:

```sh
bun itchiocli.ts devlogs GAME_ID
bun itchiocli.ts devlog GAME_ID "Update" --body-file update.txt --yes
bun itchiocli.ts edit-devlog https://itch.io/dashboard/post/POST_ID/edit --title "Revised update" --yes
bun itchiocli.ts delete-devlog POST_ID --yes
```

New devlogs default to drafts. Use `--published on` to publish, `--comments on|off` to control comments, and `--type` to select one of the site's eight post classifications. `devlogs` returns editor links. Devlog text is plain text; image/video attachment composition is not included.

## TypeScript API

```ts
import { Browser, search, comments, upload } from "./src/index.ts";

await using browser = await Browser.start("brave", {
  executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
});
console.log(await search(browser, "pixel art", 10));
console.log(await comments(browser, "https://itch.io/t/92704/retrieve-my-comments-from-the-api", 5));
// Explicit write when you intend to upload:
// await upload("./build", "creator/game:linux", { version: "1.2.0" });
```

## Development and provenance

```sh
bun run typecheck
bun test
# Also run offline DOM regressions in your installed Chromium:
ITCHIOCLI_BROWSER=/path/to/browser bun test
```

Without `ITCHIOCLI_BROWSER`, the six DOM tests are skipped. They never load your account cookies or make network requests.

The argument parser and browser-cookie reader were adapted from MIT-licensed [brokeboiflex/fbcli](https://github.com/brokeboiflex/fbcli); its copyright notice is retained in LICENSE. Website adapters are separate code based on the referenced services' current UI/source. No account cookies, private page snapshots, or access tokens are included in either package.
