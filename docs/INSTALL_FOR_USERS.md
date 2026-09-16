# Install Guide

This guide takes you from a jailbroken Kindle to a running dashboard. You will
run your own backend (InsForge), your own Telegram bot, and the KUAL package on
the Kindle. Nothing here connects to anyone else's server.

If you want a coding assistant to walk through this with you, use
[SETUP_WITH_ASSISTANT.md](SETUP_WITH_ASSISTANT.md). Every setting mentioned
below is described in [CONFIGURATION.md](CONFIGURATION.md).

**Time:** about an hour, not counting the jailbreak.

## What You Need

- A jailbroken Kindle with KUAL installed (step 0).
- A macOS or Linux computer with Node.js 20+, npm and git.
- A USB cable for the Kindle.
- An [InsForge](https://insforge.dev) account (free tier is enough).
- A Telegram account.
- Optional: a CalDAV calendar for the agenda.
- Optional: a free [Gemini API key](https://aistudio.google.com/apikey) for
  free-text and voice messages.
- To build the Kindle package: [Zig](https://ziglang.org/download/) (easiest)
  or an ARM cross compiler.

## 0. Jailbreak The Kindle And Install KUAL

This project runs as a KUAL extension, so the Kindle needs a jailbreak and
KUAL (Kindle Unified Application Launcher) first. The method depends on your
model and firmware version and changes over time, so follow the current
instructions for your device instead of a copy here:

- [kindlemodding.org](https://kindlemodding.org/) — up-to-date jailbreak and
  KUAL guides.
- [MobileRead Kindle Developer's Corner](https://www.mobileread.com/forums/forumdisplay.php?f=150)
  — the community behind most Kindle tooling.

You are ready when a **KUAL** item appears in your Kindle library and opens a
menu. Also turn off automatic firmware updates if the guide you follow says
so; an update can remove the jailbreak.

The Kindle package never stores the InsForge admin API key. It reads from public
dashboard endpoints and sends item toggles through the deployed toggle function.

## 1. Create Your Backend

Clone the repo, install dependencies, and log in to InsForge:

```sh
git clone <this-repo> kindle-dashboard
cd kindle-dashboard
npm install
npx @insforge/cli login
```

Create a fresh InsForge project, or link this checkout to an existing empty one:

```sh
npx @insforge/cli create --name kindle-dashboard --region us-east --template empty
```

Bootstrap the schema, generated secrets, and functions:

```sh
npm run kit:backend
```

The bootstrap script applies the schema migration, creates generated
`TELEGRAM_WEBHOOK_SECRET`, `DASHBOARD_READ_TOKEN`, and `DASHBOARD_TOGGLE_TOKEN`
values if missing, and deploys the dashboard functions.

## 2. Add Required Backend Secrets

Set the backend URL, API key and your time zone. These are server-side
function secrets, not Kindle-side values. Find the URL and API key in your
project on the InsForge dashboard.

```sh
npx @insforge/cli secrets add INSFORGE_BASE_URL https://your-project.insforge.app
npx @insforge/cli secrets add INSFORGE_API_KEY your-server-only-api-key
npx @insforge/cli secrets add DASHBOARD_TIMEZONE America/Sao_Paulo
```

Use your own [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
name. Without it, everything runs on UTC.

Weather (Open-Meteo, free, no key — just your location in decimal degrees;
right-click a spot in Google Maps to copy them):

```sh
npx @insforge/cli secrets add WEATHER_LAT -23.5505
npx @insforge/cli secrets add WEATHER_LON -46.6333
```

Agenda (optional — your CalDAV server; skip this block and the agenda strip
just shows as unavailable):

```sh
npx @insforge/cli secrets add CALDAV_BASE_URL https://your-caldav-host
npx @insforge/cli secrets add CALDAV_CALENDAR_PATH /calendars/user/personal/
npx @insforge/cli secrets add CALDAV_USERNAME your-caldav-username
npx @insforge/cli secrets add CALDAV_PASSWORD your-caldav-password-or-app-token
```

Optional natural-language parsing (any OpenAI-compatible endpoint; the default
is [Gemini](https://ai.google.dev/gemini-api/docs/openai), whose key you get
from [Google AI Studio](https://aistudio.google.com/apikey)):

```sh
npx @insforge/cli secrets add LLM_API_KEY your-gemini-api-key
npx @insforge/cli secrets add LLM_BASE_URL https://generativelanguage.googleapis.com/v1beta/openai
npx @insforge/cli secrets add LLM_MODEL gemini-3.5-flash-lite
npx @insforge/cli secrets add LLM_REASONING_EFFORT low
```

Two settings there are worth understanding rather than copying:

- **`LLM_MODEL`** is a quota decision. On Gemini's free tier the full flash
  models allow only about **20 requests per day**, which a single chatty
  afternoon exhausts; the flash-lite models allow far more. Check your own
  numbers at [ai.dev/rate-limit](https://ai.dev/rate-limit).
- **`LLM_REASONING_EFFORT=low`** is what keeps replies fast. Gemini 3.x thinks
  before answering by default, which turns a one-second reply into a
  nine-to-thirteen-second one for no gain on a task this small.

Repeated messages do not cost quota at all: a phrase the model has already
classified is answered from a local cache (about 5x faster, and free). Only
list actions are cached — a calendar phrase like "reunião amanhã às 14h" is
resolved against the current date, so caching it would be wrong tomorrow.

If `LLM_API_KEY` is missing — or the daily quota runs out — the Telegram
webhook uses its built-in command parser, which understands Portuguese and
English verbs. The `/menu` button flow still works fully for Tarefa, Nota and
Compras: it carries the category explicitly, so nothing has to be guessed.
Free-text list commands (add/complete/uncomplete/delete/clear) also still
work. Only scheduling a calendar event with a relative date like "amanhã"
needs the LLM; cancelling an event by name works without it. When the bot hits
the quota wall it says so and points you back at the buttons.

## 3. Connect Telegram

In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and
follow the prompts. BotFather replies with a token like
`123456789:AA...`. Open your new bot, press **Start**, and send it any
message. Then discover your chat ID:

```sh
npm run telegram:chat-id -- --bot-token 123456789:telegram-bot-token
```

Register the webhook and store your bot token/chat allowlist:

```sh
npm run telegram:configure -- \
  --bot-token 123456789:telegram-bot-token \
  --chat-id 123456789 \
  --webhook-url https://your-project.insforge.app/functions/telegram-webhook
```

Turn on the daily summary (a message every evening with what got done). This
only needs to run once:

```sh
npm run digest:schedule -- --base-url https://your-project.insforge.app
```

Send `/start` to your bot to get the button menu, or try a free-text command:

```text
comprar leite e ovos
adicionar limpar a mesa nas tarefas
anota a senha do wifi
já comprei o leite
reunião amanhã às 14h com o time
```

## Supported Telegram Messages

There are two ways to talk to the bot: the button menu (always works, no LLM
involved) and free text. If `LLM_API_KEY` is configured, free text can be
phrased naturally; if not, the built-in parser supports the patterns below.

This section is a tour. [BOT.md](BOT.md) is the complete reference: access
control, every reply the bot can send and what it means, the parsing pipeline,
limits, and day-to-day operation.

### Who can use your bot

Your bot's `@name` is public and anyone can open a chat with it — but it
answers only the chat id you registered as `TELEGRAM_ALLOWED_CHAT_ID`. Anyone
else gets **silence**: the message is dropped before it is parsed, before it
reaches the LLM, and before anything is written. Button taps are checked the
same way, so forwarding one of your confirmations to someone does not hand them
a working button.

The check is on the *chat*, not the person, so the way to share the bot with
your household is to put it in a group and allowlist that group's id — see
[BOT.md](BOT.md#sharing-it-with-the-household) for the two settings you have to
change first.

### Button Menu

Send `/start` (or `/menu`) once. The bot pins a 4-button keyboard to your
chat:

```text
📋 Tarefa      📝 Nota
🛒 Compras     📅 Agenda
```

Tap a button, the bot asks what to add, you answer. That is it — for the
three list categories nothing is classified or guessed, so this path works
identically with or without `LLM_API_KEY`. Separate several entries with
commas to add them in one message.

`📅 Agenda` is the exception: the free text you reply with still goes to the
LLM so that "reuniao amanha as 14h" can be resolved into a real date and time.

`👀 Ver listas` is the fifth button and answers immediately instead of asking
anything: it prints the agenda, then all three lists. `/listas` (or `/ver`)
does the same from the keyboard.

`/exportar` sends the same data as a file instead of a chat message — `.json`
by default, or `.yaml` if you add that word. Add a category name (`compras`,
`tarefas`, `notas`, `agenda`) to export just that one, e.g. `/exportar compras
yaml`; with no category it exports everything.

The keyboard is persistent — it stays available until you hide it — and
`/menu` brings it back if you dismiss it. `/ajuda` prints the full cheat sheet
of free-text phrasings.

### Undo

Every confirmation that actually changed something carries an `↩️ Desfazer`
button. Tapping it reverses exactly that message — re-adding deleted items with
their original done state, un-marking what it marked, deleting what it created,
or restoring a cancelled calendar event from its original ICS.

This matters because completing and deleting match item text by substring, so
the bot can hit a row you did not mean. The button is good for 24 hours and
works once; tapping it again says the action was already undone.

### When the bot is unsure, it asks

If a word matches more than one item — "já comprei o pão" with both `pão` and
`pão de forma` on the list — nothing is changed. The bot lists the candidates
as buttons and applies only the one you tap, with `⚡ Todos` available when the
sweep really was what you meant, and `✖️ Cancelar` to walk away.

The same happens when cancelling a calendar event matches several, and when a
free-text add had to guess the list because the message named none: the item is
saved right away and the bot offers to move it, so nothing is ever held hostage
waiting for a tap.

### Voice Notes

Hold to record and just say it — "comprar leite, pão e ovos". The bot replies
with what it heard followed by what it did:

```text
🎤 "comprar leite, pão e ovos"
✅ Anotei 3 itens em 🛒 Compras: leite, pão, ovos.
```

Transcription and parsing happen in a single model call, so a voice note costs
the same one request against your quota as a typed message. Limits are 5
minutes and 5 MB.

This path talks to Gemini's native endpoint rather than the OpenAI-compatible
one, because that layer only accepts `wav` and `mp3` audio while Telegram sends
OGG/Opus. It is derived from `LLM_BASE_URL` automatically; set
`LLM_AUDIO_BASE_URL` to override it. With a non-Gemini provider, voice notes
report themselves unavailable and everything else keeps working.

### Grocery / Todo / Notes Lists

Supported lists (aliases are matched in Portuguese and English, accents
optional):

- Grocery: `compras`, `comprar`, `mercado`, `supermercado`, `feira`, `grocery`, `groceries`, `shopping`, `market`
- Todo/chores: `tarefa`, `tarefas`, `afazeres`, `pendências`, `todo`, `to-do`, `task`, `tasks`, `errand`, `errands`
- Notes: `nota`, `notas`, `anotação`, `recado`, `note`, `notes`

All three appear on the Kindle screen as their own tile, and all three are
tappable to open full-screen.

Add items:

```text
comprar leite e pão
preciso de maçã, iogurte e aveia no mercado
adicionar limpar a mesa nas tarefas
anota o código do portão 4417 nas notas
add milk and eggs to groceries
```

Mark items done:

```text
já comprei o leite
feito: limpar a mesa
mark milk done
```

Mark items open again:

```text
desmarca o leite
mark clean desk not done
```

Remove items:

```text
tira os ovos das compras
apaga limpar a mesa das tarefas
remove eggs from groceries
```

Clear a list:

```text
limpa as tarefas
esvazia as compras
clear todo
```

One message can carry several different requests:

```text
anota o código do alarme 7788, adiciona regar as plantas nas tarefas
e marca os ovos como comprados
```

Each lands in its own list, the reply lists all of them, and a single
`↩️ Desfazer` takes the whole message back. Several items of the same kind
still count as one request — "comprar leite e pão" is one add with two items,
not two adds.

If a done/open/remove command does not name a list, the webhook searches across
lists for matching item text — and says so in the reply.

The bot always answers in Portuguese, naming the list it touched and the exact
item text it matched. If nothing matched, it says that too (`🤔 Não achei
"banana" em 🛒 Compras.`) rather than confirming a change that never happened.

### Agenda (Calendar)

Schedule an event — needs `LLM_API_KEY`, since resolving "amanhã" or "segunda
que vem" reliably needs an LLM:

```text
reunião amanhã às 14h com o time
consulta no dentista dia 20/09 às 10h
agendar sync do time segunda que vem das 9h às 9h30
meeting tomorrow at 2pm with Sam
```

Cancel an event (works without an LLM, matching by title):

```text
cancela a reunião do time
apaga a consulta do dentista
cancel the team sync meeting
```

If more than one upcoming event matches the title, the bot lists them with
their dates and asks you to be more specific instead of guessing which one to
delete. Title matching ignores accents, so "reuniao" finds "Reunião". A
recurring event counts once, not once per occurrence — cancelling it removes
the whole series.

The agenda always shows the **next events, whatever their date** — the Kindle
tile the next `AGENDA_MAX_EVENTS` (6 fits on screen), `/listas` the next five.
`AGENDA_LOOKAHEAD_DAYS` (default 365) only bounds the CalDAV query; lowering it
hides events rather than tidying the view.

Recurring events — yearly birthdays especially — are expanded locally, because
Google's CalDAV ignores the `<C:expand>` request and returns the original
1996-dated master event. They appear on their next occurrence.

## 4. Build And Configure The Kindle Package

Optionally, drop in the image for the dashboard's photo tile. The renderer
reads 8-bit binary PGM only, so convert whatever you have:

```sh
magick photo.jpg -colorspace Gray -resize 512x512^ -gravity center \
  -extent 512x512 -depth 8 kindle/kual/kindle-dashboard/assets/profile.pgm
```

That directory is not tracked in Git (the photo is personal), and the build
does not require it — without a `profile.pgm` the tile simply renders as an
empty framed box.

Run the local syntax/render check before packaging:

```sh
npm run native:check
```

If you have Zig installed, build a soft-float ARM KUAL package (pass
`ZIG=/path/to/zig` if `zig` is not on your `PATH`):

```sh
make -C kindle/native extension-zig
```

If you have a dedicated Kindle ARM compiler, build with:

```sh
make -C kindle/native extension
```

The GNU build expects `arm-linux-gnueabi-g++` by default. Override with
`KINDLE_CXX=/path/to/compiler` if your toolchain uses a different binary name.

The package is written to:

```text
kindle/native/build/kindle-dashboard-kual.tar.gz
```

### Copy it to the Kindle

Connect the Kindle over USB. It shows up as a drive (usually `/Volumes/Kindle`
on macOS, `/run/media/$USER/Kindle` or `/media/$USER/Kindle` on Linux). The
root of that drive is `/mnt/us` from the Kindle's point of view, and it
already has an `extensions/` folder from the KUAL install.

**Option A — installer script.** It extracts the package, copies the
launcher, writes `config.sh` from your environment, and pre-loads the
dashboard data so the first launch has something to show:

```sh
DASHBOARD_DATA_URL=https://your-project.insforge.app/functions/kindle-dashboard-data \
DASHBOARD_EVENTS_URL=https://your-project.function2.insforge.app/kindle-dashboard-events \
DASHBOARD_TOGGLE_URL=https://your-project.insforge.app/functions/kindle-dashboard-toggle \
DASHBOARD_READ_TOKEN=<read-token> \
DASHBOARD_TOGGLE_TOKEN=<toggle-token> \
DASHBOARD_TITLE="My Kindle" \
npm run native:install -- /path/to/Kindle
```

An existing `config.sh` on the device is kept as-is.

**Option B — by hand.** Extract the package on your computer and copy the
resulting `kindle-dashboard` folder into `extensions/` on the Kindle drive:

```sh
tar -C /path/to/Kindle/extensions -xzf kindle/native/build/kindle-dashboard-kual.tar.gz
cp /path/to/Kindle/extensions/kindle-dashboard/config.sh.example \
   /path/to/Kindle/extensions/kindle-dashboard/config.sh
```

Then edit `extensions/kindle-dashboard/config.sh`. It should look like this:

```sh
DASHBOARD_DATA_URL="https://your-project.insforge.app/functions/kindle-dashboard-data"
DASHBOARD_EVENTS_URL="https://your-project.function2.insforge.app/kindle-dashboard-events"
DASHBOARD_TOGGLE_URL="https://your-project.insforge.app/functions/kindle-dashboard-toggle"
DASHBOARD_READ_TOKEN="replace-with-your-generated-read-token"
DASHBOARD_TOGGLE_TOKEN="replace-with-your-generated-toggle-token"
DASHBOARD_TITLE="My Kindle"
INTERVAL="300"
DASHBOARD_KEEP_AWAKE="1"
DASHBOARD_SLEEP_WINDOW="off"
DARK_MODE="0"
```

`INTERVAL` is the polling fallback in seconds (300 = 5 minutes). List changes
normally arrive faster than that through the SSE events URL; the interval is
what refreshes weather and agenda, and what covers the case where the SSE
connection is down.

Fetch the tokens from InsForge and paste them into `config.sh`:

```sh
npx @insforge/cli secrets get DASHBOARD_READ_TOKEN --json
npx @insforge/cli secrets get DASHBOARD_TOGGLE_TOKEN --json
```

Use the direct `function2.insforge.app` host for the events URL. InsForge's
regular `/functions/...` gateway can buffer SSE responses.

Eject the Kindle safely before unplugging it.

## 5. Launch On Kindle

On the Kindle, open KUAL. Try **Refresh Once (Light)** first: if a dashboard
appears, the whole chain works. Then use **Start Dashboard** to leave it
running.

- `Kindle Dashboard -> Refresh Once (Light)` fetches and renders one update.
- `Kindle Dashboard -> Refresh Once (Dark)` same, rendered white-on-black.
- `Kindle Dashboard -> Start Dashboard (Light)` starts the always-on refresh loop.
- `Kindle Dashboard -> Start Dashboard (Dark)` same, rendered white-on-black.
- `Kindle Dashboard -> Stop Dashboard` stops the process.

The Dark entries invert the whole dashboard: black background, white text and
frames, with the photo tile still shown as a photo. It is the dashboard's own
theme and works whatever the Kindle's system theme is set to. Set
`DARK_MODE="1"` in `config.sh` to make it the default for every launch; the
menu entries override that for the launch they start.

Two caveats before leaving it on: the Kindle draws its own status bar across
the top 66 px and the dashboard deliberately does not paint over it, so a light
strip stays there; and a mostly-black screen ghosts more on e-ink than a
mostly-white one.

Useful Kindle-side files:

```text
/mnt/us/documents/kindle-dashboard-native.log
/mnt/us/documents/kindle-dashboard-diagnose.log
/mnt/us/documents/kindle-dashboard-data.json
```

The native app uses an always-on profile: auto-refresh every `INTERVAL`
seconds (5 minutes by default), live push through SSE, manual KUAL refresh on
demand, and no overnight quiet mode by default. For optional auto-open notes,
see `kindle/README.md`.

## Updating Later

When you pull a new version:

```sh
npm install
npm run kit:backend -- --skip-secrets
make -C kindle/native extension-zig
```

Then replace the installed KUAL extension files, keeping your local `config.sh`.

## Troubleshooting

Start by checking the backend from your computer. It should print JSON with
`"ok": true`:

```sh
curl -sS -H "X-Dashboard-Read-Token: <read-token>" \
  https://your-project.insforge.app/functions/kindle-dashboard-data
```

| Symptom | Check |
| --- | --- |
| KUAL shows no "Kindle Dashboard" entry | The folder must be `extensions/kindle-dashboard/` with `config.xml` directly inside it — not nested one level deeper. |
| Screen doesn't change after "Refresh Once" | Open `documents/kindle-dashboard-native.log` on the Kindle drive. `missing DASHBOARD_DATA_URL` means `config.sh` is absent or incomplete; `missing native app` means the package wasn't fully copied. |
| `CACHED/OFFLINE` under the header | The Kindle has no network. Check its Wi-Fi. |
| `401` from the curl above | `DASHBOARD_READ_TOKEN` doesn't match the backend secret. |
| Weather or agenda "unavailable" | The response has `"available": false` for that module: recheck the `WEATHER_*` or `CALDAV_*` secrets. The rest of the dashboard keeps working. |
| Event times are hours off | Set `DASHBOARD_TIMEZONE` on the backend (and in `config.sh` if the Kindle's own clock is wrong). |
| Bot doesn't answer | Re-run `npm run telegram:configure`. The bot is silent to every chat except `TELEGRAM_ALLOWED_CHAT_ID`, so double-check the chat id. |
| Bot says the quota is over | The free LLM tier's daily cap was hit. The menu buttons keep working; it resets the next day. |
| Changes take minutes to appear | `DASHBOARD_EVENTS_URL` must use the `function2.insforge.app` host. |
| Tapping items does nothing | `DASHBOARD_TOGGLE_URL` and `DASHBOARD_TOGGLE_TOKEN` in `config.sh`. |

If you have SSH access to the Kindle, `extensions/kindle-dashboard/bin/diagnose.sh`
runs one fetch-and-render and writes a detailed report to
`documents/kindle-dashboard-diagnose.log`.

## Privacy Notes

- Do not share `INSFORGE_API_KEY`, Telegram bot token, webhook secret,
  `LLM_API_KEY`, or your CalDAV password/app-token.
- Treat `DASHBOARD_READ_TOKEN` and `DASHBOARD_TOGGLE_TOKEN` as device secrets.
  The read token exposes dashboard data, while the toggle token can change
  checklist state.
- The Kindle reads dashboard data through your deployed function URLs using
  the read token.
- If `LLM_API_KEY` is set, unrecognized Telegram messages are sent to that
  LLM endpoint (default: Google's Gemini API, a third-party service) for
  parsing. Do not enable it if you don't want message text leaving your
  InsForge project — the button menu covers the three lists without it.
- The Telegram bot answers exactly one chat id and ignores every other, so a
  public bot username is not an exposure — see "Who can use your bot" above.
- This kit is single-owner by design. For a hosted multi-user service, every
  table and function would need per-user scoping and device pairing.
