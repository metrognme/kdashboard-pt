# Configuration Reference

There are two places to configure, and they never share values:

1. **Backend secrets**, stored in your InsForge project and read by the edge
   functions at runtime. Set them with
   `npx @insforge/cli secrets add <KEY> <VALUE>`.
2. **Kindle settings**, in `config.sh` inside the installed KUAL extension
   (`/mnt/us/extensions/kindle-dashboard/config.sh`).

The local `.env` file (copied from `.env.example`) is only a place to keep your
own notes and feed the helper scripts in `scripts/`. The deployed functions
never read it.

## Backend secrets

### Set for you

`npm run kit:backend` generates these if they don't exist yet. You only need
to read two of them (for `config.sh`):

| Key | Used by | Purpose |
| --- | --- | --- |
| `DASHBOARD_READ_TOKEN` | Kindle | Lets the Kindle read the dashboard. Copy into `config.sh`. |
| `DASHBOARD_TOGGLE_TOKEN` | Kindle | Lets the Kindle tick items off. Copy into `config.sh`. |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram | Proves an update really came from Telegram. |
| `DAILY_DIGEST_TOKEN` | Scheduler | Authenticates the hourly daily-summary tick. |

```sh
npx @insforge/cli secrets get DASHBOARD_READ_TOKEN --json
npx @insforge/cli secrets get DASHBOARD_TOGGLE_TOKEN --json
```

`npm run telegram:configure` sets `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ALLOWED_CHAT_ID` for you.

### Required

| Key | Example | Notes |
| --- | --- | --- |
| `INSFORGE_BASE_URL` | `https://abc123.us-east.insforge.app` | Your project's API URL (InsForge dashboard, or `npx @insforge/cli current`). |
| `INSFORGE_API_KEY` | — | Your project's server-side API key. Never put it on the Kindle. |
| `DASHBOARD_TIMEZONE` | `America/Sao_Paulo` | An [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). Without it everything runs on UTC, so event times and "amanhã" resolve wrong. |

### Weather

Uses [Open-Meteo](https://open-meteo.com): free, no account, no key. Without
these the weather bar shows as unavailable and everything else keeps working.

| Key | Example | Notes |
| --- | --- | --- |
| `WEATHER_LAT` | `-23.5505` | Latitude in decimal degrees. Right-click a spot in Google Maps to copy it. |
| `WEATHER_LON` | `-46.6333` | Longitude in decimal degrees. |

### Agenda (CalDAV)

Without these the agenda strip shows as unavailable and everything else keeps
working.

| Key | Example | Notes |
| --- | --- | --- |
| `CALDAV_BASE_URL` | `https://caldav.example.com` | Server origin, no path. |
| `CALDAV_CALENDAR_PATH` | `/calendars/you/personal/` | Path of the one calendar to show, with trailing slash. |
| `CALDAV_USERNAME` | — | |
| `CALDAV_PASSWORD` | — | Use an app-specific password where your provider supports one. |
| `AGENDA_MAX_EVENTS` | `6` | How many upcoming events to show (code default 8; 6 is what fits on screen). |
| `AGENDA_LOOKAHEAD_DAYS` | `365` | How far ahead to search. This is *not* a "show only the next N days" filter: lowering it just hides events. |

Scheduling events from Telegram writes to this same calendar.

### Natural language and voice (LLM)

Optional. Without `LLM_API_KEY`, the button menu and simple commands still
work; free text is handled by a built-in rule-based parser, and scheduling an
event with a relative date ("amanhã às 14h") is unavailable.

| Key | Default | Notes |
| --- | --- | --- |
| `LLM_API_KEY` | — | Any OpenAI-compatible provider. A free [Gemini key](https://aistudio.google.com/apikey) works. |
| `LLM_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compatible endpoint. |
| `LLM_MODEL` | `gemini-3.5-flash-lite` | On Gemini's free tier the full flash models allow only ~20 requests per day; flash-lite allows far more. |
| `LLM_REASONING_EFFORT` | `low` | Keeps replies at ~1s instead of 9–13s. |
| `LLM_AUDIO_BASE_URL` | derived from `LLM_BASE_URL` | Voice notes only; they need Gemini's native endpoint. With another provider, voice notes report themselves unavailable. |

When the LLM key is set, message text that the rule-based parser can't handle
is sent to that provider.

## Kindle `config.sh`

Start from `config.sh.example` in the extension folder. Values are shell
variables, so keep the double quotes.

| Key | Default | Notes |
| --- | --- | --- |
| `DASHBOARD_DATA_URL` | — | **Required.** `https://<project>.insforge.app/functions/kindle-dashboard-data` |
| `DASHBOARD_EVENTS_URL` | — | `https://<project>.function2.insforge.app/kindle-dashboard-events`. Note the different host: the regular `/functions/` gateway buffers live events. Without it, updates only arrive every `INTERVAL`. |
| `DASHBOARD_TOGGLE_URL` | — | `https://<project>.insforge.app/functions/kindle-dashboard-toggle`. Without it, tapping items does nothing. |
| `DASHBOARD_READ_TOKEN` | — | **Required.** From the backend secrets above. |
| `DASHBOARD_TOGGLE_TOKEN` | — | From the backend secrets above. |
| `DASHBOARD_TITLE` | `Kindle Dashboard` | Header text, rendered in uppercase. Shown on the full-screen list views. |
| `INTERVAL` | `300` | Seconds between full refreshes. Weather and agenda update on this clock; list changes arrive immediately through the events URL. |
| `DARK_MODE` | `0` | `1` for white-on-black. The KUAL Light/Dark entries override it per launch. |
| `DASHBOARD_KEEP_AWAKE` | `1` | `0` lets the Kindle go to sleep as usual. |
| `DASHBOARD_SLEEP_WINDOW` | `off` | `HH:MM-HH:MM` pauses refreshing overnight, e.g. `23:00-07:00`. |
| `DASHBOARD_TIMEZONE` | Kindle's own | Set it (e.g. `America/Sao_Paulo`) if the Kindle's clock shows the wrong zone. |

### Photo tile

The top-left tile shows
`/mnt/us/extensions/kindle-dashboard/assets/profile.pgm` — an 8-bit greyscale
PGM image. Convert any picture with ImageMagick:

```sh
magick photo.jpg -colorspace Gray -resize 512x512^ -gravity center \
  -extent 512x512 -depth 8 profile.pgm
```

Copy it to `extensions/kindle-dashboard/assets/` on the Kindle, or place it at
`kindle/kual/kindle-dashboard/assets/profile.pgm` before building and the
package will include it. That folder is ignored by Git, so your picture never
gets committed. Without the file, the tile is drawn as an empty frame.

## Bot settings

Two settings live in the database and are changed from Telegram, not here:

- `/resumo_hora <0-23>` — the local hour the daily summary is sent (default 22).
- The daily summary only runs after `npm run digest:schedule` has been run once.

See [BOT.md](BOT.md).
