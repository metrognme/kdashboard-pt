# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-screen monochrome dashboard for a jailbroken Kindle: a native C++ renderer
draws to `/dev/fb0`, and an InsForge (Postgres BaaS) backend serves it one JSON
payload. Content is edited from a Telegram bot, not from the Kindle. Shipped as a
bring-your-own-backend kit — each owner runs their own InsForge project, bot, and
KUAL config, so nothing may hardcode this checkout's endpoints.

This is the public, shareable edition of the project. Keep it free of personal
data: no real project URLs, tokens, chat ids, calendar contents, photos
(`*.pgm` is gitignored), names or locations. Examples use `your-project` hosts
and generic sample data (`kindle/native/fixtures/dashboard-data.json`).

Docs are part of the product (the audience is non-developers installing it on
their own Kindle): `README.md` is the pitch and index, `docs/INSTALL_FOR_USERS.md`
the step-by-step guide, `docs/CONFIGURATION.md` the reference for every secret
and `config.sh` key, `docs/ARCHITECTURE.md` the design notes, `docs/BOT.md` the
bot reference. A new setting or behavior change needs to land in the matching
doc, and `docs/images/preview-*.png` should be regenerated if the layout changes
(render the fixture with `--save-pgm`, then `magick in.pgm -resize 50% -strip out.png`).

`AGENTS.md` covers the InsForge platform conventions and which InsForge skills to
reach for. Read it before touching anything backend-side.

## Commands

Backend (InsForge CLI, reads `.insforge/project.json`):

```sh
npm run kit:backend                            # apply migrations + ensure secrets + deploy all 4 functions
npm run kit:backend -- --skip-secrets           # re-deploy without touching secrets
npm run kit:backend -- --skip-deploy            # migrations/secrets only
npx @insforge/cli functions deploy <slug> --file functions/<slug>.ts --name "<Name>"
npx @insforge/cli functions code <slug>         # fetch live source — the only real way to confirm a deploy
npx @insforge/cli db query "<sql>"
npx @insforge/cli logs function.logs
```

Telegram + digest setup:

```sh
npm run telegram:chat-id -- --bot-token <token>     # find your chat id from getUpdates
npm run telegram:configure -- --bot-token <token> --chat-id <id> --base-url <url>
npm run digest:schedule -- --base-url <INSFORGE_BASE_URL>   # one-time hourly tick for the daily digest
```

Native renderer:

```sh
npm run check                          # == native:check == make -C kindle/native check
make -C kindle/native local            # host build -> build/kindle-dashboard-local
make -C kindle/native kindle           # ARM build, needs arm-linux-gnueabi-g++ (KINDLE_CXX= to override)
make -C kindle/native extension-zig ZIG=/path/to/zig   # ARM build + KUAL tarball via Zig (soft-float fallback)
make -C kindle/native extension        # same, via the GNU cross compiler
npm run native:install -- /path/to/KindleMount [--force]
npm run native:proof -- /path/to/KindleMount
```

### Verifying renderer changes

`npm run native:check` only proves the JSON parser and layout don't crash — off-device
there is no framebuffer, so it renders nothing (`render=framebuffer open_failed` is
expected and still exits 0). To actually see a change, dump a PGM and open it:

```sh
cd kindle/native && make local
./build/kindle-dashboard-local --render fixtures/dashboard-data.json --save-pgm /tmp/out.pgm
./build/kindle-dashboard-local --render fixtures/dashboard-data.json --view chores --dark --save-pgm /tmp/dark.pgm
./build/kindle-dashboard-local --render fixtures/dashboard-data.json --view grocery --title "some text" --save-pgm /tmp/title.pgm
```

The header title (`g_title`, from `--title` / `DASHBOARD_TITLE` in `config.sh`)
only appears on the full-screen list views; the main screen's header is the
weather bar. A new renderer flag has to be threaded through both launchers —
`kindle/kual/kindle-dashboard/bin/dashboard.sh` (two call sites: loop and `--once`)
and `kindle/launch-dashboard.sh` — plus `config.sh.example`, the config writer in
`scripts/install-kindle-native.mjs`, and `docs/CONFIGURATION.md`.

`--view chores|grocery` opens the full-screen list view, which is the closest thing to
running one "test case" in isolation. Edit `kindle/native/fixtures/dashboard-data.json`
to exercise a payload shape instead of hitting the live backend.

There is no test framework and no linter in this repo. **`npx tsc --noEmit` does not
pass and is not a check** — `tsconfig.json` includes `functions/**/*.ts`, but those run
on Deno (`Deno.env.get`, `npm:@insforge/sdk`), so every file errors on missing globals.
Edge functions are only really validated by deploying them; InsForge compiles on deploy.

`npm run native:proof` is macOS-only (shells out to `sips`) and both Kindle scripts
default to `/Volumes/Kindle`, so on Linux always pass the mount path explicitly.

## Architecture

```
Telegram ──▶ telegram-webhook ──▶ Postgres (planner_items)  ──▶ kindle-dashboard-data ──▶ Kindle
                   │                       │                            ▲      (5-min poll)
                   └──▶ CalDAV (agenda)    └──▶ kindle-dashboard-events ─┘ (SSE: "refetch now")
                                                Kindle tap ──▶ kindle-dashboard-toggle
```

Four Deno edge functions in `functions/`, one table-per-concern schema in `migrations/`,
one C++ file in `kindle/native/src/kindle_dashboard.cpp` (~3k lines: JSON parser,
layout, hand-rasterized glyphs, framebuffer writes, touch input). `functions/telegram-webhook.ts`
is ~3.5k lines and holds the whole bot: parsing, actions, replies, digest, export.

Each function is self-contained — there is no shared module, so helpers like
`jsonResponse`, `requiredEnv` and `corsHeaders` are duplicated per file by design
(InsForge deploys one file per function). Don't try to factor them out.

Auth is shared-secret headers, one per surface, not user accounts:
`x-telegram-bot-api-secret-token`, `x-dashboard-read-token`, `x-dashboard-toggle-token`.
Single-owner by design: no per-user scoping anywhere, and `TELEGRAM_ALLOWED_CHAT_ID`
is what makes the bot private.

`DASHBOARD_TIMEZONE` falls back to `"UTC"` in both `kindle-dashboard-data.ts` and
`telegram-webhook.ts` (`DEFAULT_TIMEZONE`); keep the two fallbacks identical.

Secrets live in **InsForge secrets** at runtime (`Deno.env.get` inside functions).
`.env` / `.env.example` only feed the local `scripts/*.mjs` and document what to set;
nothing in `functions/` ever reads a local `.env`.

### Cross-file invariants

These are the ones that break silently if you miss them:

- **`lists` order is a contract.** `kindle-dashboard-data.ts` must emit `todo`,
  `grocery`, `notes` in that order — the renderer maps array index straight to an
  on-screen tile. Reordering the query silently swaps tiles.
- **The SSE version hash must cover everything the dashboard renders.**
  `kindle-dashboard-events.ts` recomputes a version from `planner_items` and pushes
  only when it changes; any list or field the dashboard shows but the hash ignores
  will never push, and only catches up on the next 5-minute poll. Weather and agenda
  are deliberately excluded (they change on the clock, not on writes).
- **Every write that flips `done` must also move `completed_at`** (set on true, clear
  on false). The daily digest uses it to tell "finished today" from "moved lists
  today"; `updated_at` can't. Both `kindle-dashboard-toggle.ts` and the webhook's
  complete/uncomplete paths.
- **Timestamps go out with an explicit offset, never `Z`.** The renderer has no
  timezone tables and prints the digits as-is. All-day events stay date-only.
- **New migrations must be appended to `schemaMigrations` in
  `scripts/bootstrap-insforge-kit.mjs`** — there is no directory scan. The script
  applies each `.sql` through `db query`, so `insforge db migrations list` is always
  empty here; verify schema with `information_schema` queries instead.
- **Every visible region needs a touch region, even inert ones.** Unmatched taps get
  retried through seven mirrored/rotated transforms (touchscreen axes vary by Kindle
  model), so an unregistered area sends the guess somewhere else on screen. Claim it
  with `kTouchNone`.

### Telegram parsing pipeline

`parseTelegramMessage` tries a fast deterministic pass → LLM → deterministic fallback,
and the result is validated before any write. Things that are load-bearing, not
preferences:

- The LLM request uses `response_format: json_schema` with `strict: true` and an
  **array** response (one message can be several actions). A prose "one of two shapes"
  prompt makes Gemini emit both shapes nested, which fails every validator.
- Unions aren't portable across OpenAI-compatible backends, so the schema declares
  every field of both `planner` and `calendar` kinds and fills the unused half with
  empty values.
- `reasoning_effort: "low"` keeps replies at ~1s against a 12s timeout; without it
  Gemini 3.x spends 9-13s thinking.
- A 429 is an expected state on the free tier, surfaced as `"quota"` so the reply can
  point at the buttons. Only 503 is retried, once.
- `bot_parse_cache` memoizes by normalized-message hash; **calendar actions are never
  cached** (they resolve against "now"). `bot_actions` holds undo/disambiguation
  tokens, consumed on use, pruned after 24h.
- Menu button replies recover their category from the force-reply prompt text, so the
  bot keeps no session state and list adds skip the LLM entirely.

All user-facing bot strings — and the renderer's tile titles (`TAREFAS`,
`COMPRAS`, `NOTAS`, `AGENDA`) — are Brazilian Portuguese, and replies echo the item text
**as stored** so a wrong fuzzy match is visible. Match rows before writing; never fire
a blind `UPDATE ... ILIKE` and echo the request back.

## Known tooling quirk

`npx @insforge/cli functions deploy` (and therefore `npm run kit:backend`) reliably
finishes its work and then hangs instead of exiting, leaving the output buffered. If a
deploy's output stays empty for more than a minute or two, it is not stuck mid-deploy:
verify independently (`functions code <slug>` diffed against the local file, a
`db query` for a migration's column), then `kill -TERM` the `node .../insforge` child —
its `npm exec` parent exits with it. Orphans accumulate silently across sessions, so
sweep `ps aux | grep insforge` when checking on a deploy.
