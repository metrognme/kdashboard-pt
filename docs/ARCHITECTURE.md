# Architecture

How the pieces fit together, and the non-obvious decisions behind them. For
setup, see [INSTALL_FOR_USERS.md](INSTALL_FOR_USERS.md).

## Overview

```text
Telegram ──▶ telegram-webhook ──▶ Postgres (planner_items) ──▶ kindle-dashboard-data ──▶ Kindle
                  │                        │                            ▲    (5-min poll)
                  └──▶ CalDAV (agenda)     └──▶ kindle-dashboard-events ─┘ (SSE: "refetch now")
                                                Kindle tap ──▶ kindle-dashboard-toggle
```

Content is never edited on the Kindle itself: you talk to a Telegram bot, the
bot writes to your database (or your calendar), and the Kindle is told to
re-fetch one small JSON payload and redraw.

## The Stack

**Renderer:** Native C++ app

**Backend:** InsForge

**Inputs:** Telegram bot, Open-Meteo (weather), CalDAV (agenda)

Code entry points:

- Native app: [`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)
- Backend functions: [`functions/`](../functions/)
- Owner config template:
  [`kindle/kual/kindle-dashboard/config.sh.example`](../kindle/kual/kindle-dashboard/config.sh.example)

## Backend Spine

InsForge handles the cloud layer:

**Postgres Database:** grocery, chore (todo), and note items in one
`planner_items` table, separated by `list_key`

**Edge functions:** read dashboard data (weather + agenda + lists), parse
Telegram updates, toggle Kindle tasks, SSE live events

Relevant files:

- Schema:
  [`migrations/001_planner_items.sql`](../migrations/001_planner_items.sql),
  [`migrations/002_enable_rls_private_tables.sql`](../migrations/002_enable_rls_private_tables.sql)
- Dashboard read endpoint:
  [`functions/kindle-dashboard-data.ts`](../functions/kindle-dashboard-data.ts)
- Toggle endpoint:
  [`functions/kindle-dashboard-toggle.ts`](../functions/kindle-dashboard-toggle.ts)
- Live event endpoint:
  [`functions/kindle-dashboard-events.ts`](../functions/kindle-dashboard-events.ts)
- Telegram webhook:
  [`functions/telegram-webhook.ts`](../functions/telegram-webhook.ts)

The dashboard read endpoint builds a compact payload and hashes the visible
state into a version:

```ts
const payload = {
  ...payloadWithoutVersion,
  version: hashText(JSON.stringify({
    weather: payloadWithoutVersion.weather,
    agenda: payloadWithoutVersion.agenda,
    lists: payloadWithoutVersion.lists
  }))
};
```

Weather and agenda are fetched live on every request (Open-Meteo and CalDAV
are both cheap to call at the Kindle's poll interval, 5 minutes by default)
and never throw — a failed upstream just marks that module `available: false`
so a Wi-Fi hiccup on one module never takes down the whole payload:

```ts
const [itemsResult, weather, agenda] = await Promise.all([
  admin.database.from("planner_items").select(/* ... */),
  fetchWeather(lat, lon),   // never rejects; returns { available: false, ... } on error
  fetchAgenda(/* ... */)    // never rejects; returns { available: false, events: [] } on error
]);
```

## Telegram Bot

`comprar leite`

Telegram sends a webhook to InsForge.

The webhook checks:
secret header + allowed chat ID

Code:
[`functions/telegram-webhook.ts`](../functions/telegram-webhook.ts)

Then it parses the message into a strict action (see "Message Parsing" below):

```json
{
  "kind": "planner",
  "action": "add",
  "list_key": "grocery",
  "items": ["milk"],
  "all_lists": false
}
```

Or, for a calendar update:

```json
{
  "kind": "calendar",
  "action": "create",
  "title": "Team sync",
  "start": "2026-09-12T14:00:00+05:30",
  "end": "2026-09-12T15:00:00+05:30",
  "all_day": false,
  "location": null
}
```

The webhook gate is deliberately small:

```ts
const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token");
if (receivedSecret !== configuredSecret) {
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
}

if (chatId !== allowedChatId) {
  return jsonResponse({ ok: true, ignored: true, reason: "chat_not_allowed" });
}
```

A bot username is public, so the second check is what makes the bot yours: a
stranger who finds it and writes to it gets no reply at all, and their text is
never parsed, never sent to the LLM, and never stored. Button taps arrive as
`callback_query` — a different update shape with no `update.message` — so they
are checked separately against the chat that owns the message.

[BOT.md](BOT.md) covers the access model in full, including how to
hand the bot to a household through a group chat and what that gives up.

The backend updates the database (grocery/todo) or the CalDAV calendar
(agenda), then sends a confirmation back.

Every reply is in Brazilian Portuguese, names the list it touched, and echoes
the item text as stored — so a fuzzy match that hit the wrong row is visible
immediately:

`✅ Anotei em 🛒 Compras: leite.`
`✅ Concluí em 🛒 Compras: Café.`
`🤔 Não achei "banana" em 🛒 Compras.`
`📅 Agendado: Reunião com o time`
`amanhã às 14:00 · sala 2`

The "not found" case is the point: complete/delete/uncomplete match by
substring, so the webhook resolves the matching rows *before* writing and
reports what it actually changed. Firing a blind `UPDATE ... ILIKE` and
echoing the requested words back confirms changes that never happened.

## Message Parsing

**AI Parsing**

The Telegram message is sent to an OpenAI-compatible LLM endpoint (default:
[Gemini](https://ai.google.dev/gemini-api/docs/openai), model
`gemini-3.5-flash-lite`) with a strict instruction: convert this message into
one JSON action, resolving relative dates ("amanhã às 14h") against the current
timestamp — which is supplied carrying the user's real UTC offset, not `Z`.

The prompt also pins the output language: item and event titles come back in
the user's own words, never translated into English.

Code:
[`parseTelegramMessage`](../functions/telegram-webhook.ts) in
[`functions/telegram-webhook.ts`](../functions/telegram-webhook.ts)

**Deterministic parsing**

If `LLM_API_KEY` is missing, the LLM call fails, or it returns invalid JSON,
the backend uses handwritten rules in the code.

Deterministic parsing follows hardcoded rules — note that relative-date
resolution for calendar events is deliberately *not* covered by the
heuristic fallback (only trivial cases like "cancela a reunião X" are), since
reliably parsing "segunda que vem" without an LLM is out of scope for a regex.

Either way, the backend validates the result before any database or CalDAV
write.

The parser tries a fast deterministic pass, then the LLM, then a
deterministic fallback:

```ts
async function parseTelegramMessage(message: string): Promise<ParseOutcome> {
  const fastAction = parseFastHeuristicMessage(message);
  if (fastAction) return { action: fastAction };

  const config = llmConfig();
  if (!config) return { action: parseMessageHeuristically(message) };

  const result = await callLlm(config, buildSystemPrompt(), message);
  // LLM response is parsed and validated before any database/CalDAV write.
}
```

**One message, several actions**

The response schema is an array. "anota o código do alarme, adiciona regar as
plantas nas tarefas e marca os ovos como comprados" is three requests, and a
single-object schema forced the model to drop two of them. The prompt is
explicit about not over-splitting: "comprar leite e pão" stays one add with two
items.

The deterministic fast path therefore refuses any message using verbs from more
than one action family — two families means two requests, which a regex cannot
split.

**Structured output is required, not optional**

The request sends `response_format: { type: "json_schema" }` with a single
flat schema covering both action kinds. This is not a refinement over
`json_object` — it is what makes the integration work at all. Asked for "one
of these two shapes" in prose, Gemini reliably answers with *both* shapes
nested under their kind:

```json
{ "planner": { "action": "add", "list_key": "grocery", "items": ["leite"] },
  "calendar": { "action": "", "title": "" } }
```

That object fails every validator, so each reply was silently discarded and
the English-only heuristic answered instead. `unwrapAction` also flattens the
nested shape defensively, for a backend that ignores the schema.

Unions are not portable across OpenAI-compatible backends, so the schema
declares every field of both kinds and fills the unused half with empty
values; `strict: true` additionally requires that `required` list every
declared property.

**Latency and quota**

`reasoning_effort: "low"` is load-bearing: Gemini 3.x thinks before answering
by default, which costs 9-13s on a classification this small — against a 12s
timeout. With it, end-to-end replies land at ~1s.

Model choice is a quota decision. On Gemini's free tier the full flash models
allow about 20 requests *per day*; the flash-lite models allow far more, which
is why `LLM_MODEL` defaults to `gemini-3.5-flash-lite`. A 429 is therefore an
expected state, not an anomaly: `callLlm` reports it as `"quota"` so the chat
can say "use the buttons, they always work" instead of "I did not understand".
Only 503 is retried (once); retrying a daily cap just burns it further.

**Interactive replies**

Confirmations carry an `↩️ Desfazer` button, and an ambiguous match asks with
buttons instead of sweeping every row a substring happened to hit. Telegram
caps `callback_data` at 64 bytes, so the button carries a 16-hex-character id
and the payload lives in `bot_actions`; tokens are consumed on use so a double
tap cannot apply twice, and pruned after 24h.

Every apply returns `{summary, undo, choices}` — the inverse operation
alongside the result — which is what lets a three-action message be taken back
by one tap.

**Voice notes**

Audio bypasses the OpenAI compatibility layer: it only accepts `input_audio`
formats `[wav, mp3]`, and Telegram sends OGG/Opus. Gemini's native endpoint
takes `audio/ogg` as `inline_data`, so `parseVoiceMessage` talks to it directly
while text keeps using the portable layer. Transcription and parsing are one
request — the model that hears the audio emits the action — so a voice note
costs the same single unit of quota as a typed message.

**Parse cache**

`bot_parse_cache` memoizes classifier results by a hash of the normalized
message, because the free tier meters requests rather than tokens. Calendar
actions are never cached: they resolve against "now", so a stored "reunião
amanhã às 14h" would be wrong tomorrow.

List names have hardcoded aliases, in English and Portuguese. Detection folds
accents, so the table itself stays plain ASCII and still matches "pendências":

```ts
const LIST_ALIASES = {
  grocery: ["grocery", "groceries", "shopping", "market", "comprar", "compra", "compras", "mercado", "supermercado", "feira"],
  todo: ["todo", "to-do", "task", "tasks", "errand", "errands", "tarefa", "tarefas", "afazer", "afazeres", "pendencia", "pendencias"],
  notes: ["note", "notes", "nota", "notas", "anotacao", "anotacoes", "recado", "recados"]
};
```

Action verbs are matched the same way, and cover Portuguese first: without a
key — and, on the free tier, for the rest of the day once the cap is hit —
this parser is the only thing between the user and a blank reply.

**Menu keyboard (no NLP needed)**

`/start` or `/menu` shows a persistent 4-button keyboard — 📋 Tarefa,
📝 Nota, 🛒 Compras, 📅 Agenda. Tapping a button answers with a
force-reply prompt whose exact text encodes the category; Telegram echoes
that prompt back as `reply_to_message` on the next message, so the backend
recovers the category with no server-side session state:

```ts
const repliedCategory = repliedPromptText
  ? MENU_CATEGORIES.find((category) => category.prompt === repliedPromptText)
  : undefined;

if (repliedCategory?.listKey) {
  action = buildPlannerAddAction(repliedCategory.listKey, text);  // no classification at all
}
```

List adds picked from the menu skip parsing entirely. Only 📅 Agenda still
goes through the LLM, to resolve relative dates out of free text.

## Weather

The dashboard read endpoint calls Open-Meteo's free, keyless forecast API
for a fixed latitude/longitude (single-tenant, configured via
`WEATHER_LAT`/`WEATHER_LON`), and maps its WMO weather code to a short
label the native renderer can print with its bitmap font:

Code:
[`fetchWeather`](../functions/kindle-dashboard-data.ts) in
[`functions/kindle-dashboard-data.ts`](../functions/kindle-dashboard-data.ts)

## Agenda

The dashboard read endpoint and the Telegram webhook both speak CalDAV
directly over `fetch` — no library dependency, consistent with the rest of
the codebase's "no external deps" style. Reading uses a `REPORT`
`calendar-query` with a time-range filter; creating an event `PUT`s a
minimal `VEVENT` ICS document; deleting looks up matching events by title
and issues a `DELETE` on the matched resource.

The tile shows the **next `AGENDA_MAX_EVENTS` events, whatever their date**.
`AGENDA_LOOKAHEAD_DAYS` (default 365) only bounds the query and the recurrence
walk — it is not a "within N days" filter. That distinction was originally the
other way round, with a 36-hour window, and a calendar whose next appointment
was ten days out rendered an empty agenda.

Two things the CalDAV layer has to do itself:

- **Expand recurrence.** A `calendar-query` can ask the server to expand a rule
  with `<C:expand>`, but Google's implementation ignores it and returns the
  master `VEVENT` — so a yearly birthday arrives dated 1996 and is invisible to
  anything filtering for upcoming events. `expandRecurrence` walks `RRULE`
  forward instead (`FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, weekly `BYDAY`,
  `EXDATE`), fast-forwarding to the window so a 1996 daily rule does not cost
  11,000 iterations. A rule it cannot model exactly returns the master start
  untouched rather than an invented date.
- **Resolve `TZID` itself.** `DTSTART;TZID=America/Sao_Paulo:20260913T120000`
  is noon *there*. Reading it with `new Date("2026-09-13T12:00:00")` resolves
  the wall clock against the runtime's zone — UTC on the edge host — which
  shifted every event by the calendar's own offset. `wallClockToUtc` derives
  the offset the zone was actually at on that instant, so it stays correct
  across DST.

Code:
[`fetchAgenda`](../functions/kindle-dashboard-data.ts) in
[`functions/kindle-dashboard-data.ts`](../functions/kindle-dashboard-data.ts),
[`applyCalendarAction`](../functions/telegram-webhook.ts) in
[`functions/telegram-webhook.ts`](../functions/telegram-webhook.ts)

## Kindle Dashboard Update

The Kindle fetches one compact JSON payload from an InsForge data endpoint.

It renders the dashboard locally and caches the payload for offline use.

Relevant files:

- Endpoint:
  [`functions/kindle-dashboard-data.ts`](../functions/kindle-dashboard-data.ts)
- Native fetch/cache/render loop:
  [`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)
- KUAL launcher:
  [`kindle/kual/kindle-dashboard/bin/dashboard.sh`](../kindle/kual/kindle-dashboard/bin/dashboard.sh)

Example response:

```json
{
  "ok": true,
  "generated_at": "2026-09-11T12:00:00.000Z",
  "weather": {
    "available": true,
    "temperature_c": 27,
    "feels_like_c": 29,
    "condition_label": "CLOUDY",
    "precipitation_probability": 40,
    "high_c": 30,
    "low_c": 22,
    "wind_kph": 12
  },
  "agenda": {
    "available": true,
    "events": [
      { "uid": "abc", "title": "TEAM SYNC", "start": "2026-09-11T14:00:00-03:00", "end": "2026-09-11T15:00:00-03:00", "all_day": false, "location": null }
    ]
  },
  "lists": [
    { "key": "todo",    "title": "Chores",  "items": [{ "id": "item-1", "text": "CLEAN DESK", "done": false }] },
    { "key": "grocery", "title": "Grocery", "items": [{ "id": "item-2", "text": "MILK", "done": false }] },
    { "key": "notes",   "title": "Notes",   "items": [{ "id": "item-3", "text": "WIFI PASSWORD IS ON THE ROUTER", "done": false }] }
  ],
  "version": "a13f9c"
}
```

Two contract details the renderer depends on:

- `lists` is always emitted in the fixed order `todo`, `grocery`, `notes`.
  The native renderer maps array position straight to an on-screen tile, so
  the backend must not reorder it.
- Timed agenda events are converted to the dashboard's local wall clock with
  an explicit offset (`-03:00` above) rather than UTC `Z`. The renderer has
  no timezone tables and prints the date/hour digits as-is. All-day events
  keep their original date-only value.

The native app fetches to a cache file first, then renders the cache:

```cpp
const int fetched = fetchToCache(dashboard_url, options.read_token, options.cache);
renderCachedPayload(&options, fetched ? "live" : "cached/offline");
```

## Native Rendering

The Kindle runs a native C++ renderer.

It draws text, boxes, and hand-rasterized icons onto a monochrome canvas
sized for the e-ink display. There is no icon font and no image asset for
the weather glyphs — sun, cloud, rain, snow, storm and fog are composed at
draw time from `fillCircle`, `fillTriangle`, `fillRect` and `line`, the same
primitives used for everything else:

```cpp
fillCircle(canvas, cx - r * 3 / 8, cloud_cy, r * 3 / 8, 0);
fillCircle(canvas, cx + r / 8, cloud_cy - r / 6, r / 2, 0);
fillCircle(canvas, cx + r * 5 / 8, cloud_cy, r * 3 / 8, 0);
```

The layout is a single screen, not a 2x2 grid. Tile titles are Portuguese
(`TAREFAS`, `COMPRAS`, `NOTAS`, `AGENDA`), and the header text comes from
`DASHBOARD_TITLE` in `config.sh` (passed to the binary as `--title`):

```text
+--------------------------------------------------+
| [icon] 27C  CLOUDY   ^30 v22  (o)40%      [EXIT]  |  weather bar
| KINDLE DASHBOARD / updated ...                    |
+---------------------+----------------------------+
|  photo tile         |  CHORES                    |
+---------------------+                            |
|  GROCERY            +----------------------------+
|                     |  NOTES                     |
+---------------------+----------------------------+
|  AGENDA (full width)                              |
+--------------------------------------------------+
```

High/low temperature and rain probability are labelled with drawn arrow and
droplet glyphs instead of bare letters, since the 5x7 bitmap font has no room
for words at that size.

Then it writes those pixels directly to the Kindle framebuffer.

Code:
[`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)

The renderer parses JSON into a fixed dashboard struct, scoping weather and
agenda field lookups to their own object in the payload (rather than
searching the whole document) so field names can't collide across modules:

```cpp
const char* weather_start = findKeyInRange(json, NULL, "weather");
const char* weather_end = matchingClose(weather_start, '}');
dashboard->weather.temperature_c = extractInt(weather_start, weather_end, "temperature_c", 0);
```

Then it draws into a canvas and writes to `/dev/fb0` when available:

```cpp
int fd = open("/dev/fb0", O_RDWR);
unsigned char* fb = static_cast<unsigned char*>(
  mmap(0, screensize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
);
```

## Chrome

Panels are framed as HUD brackets rather than plain rectangles: a hairline
border, heavy L-corners, and the top-right corner cut off at 45 degrees.
Titles sit in a filled tab reversed out of the ink, and the rule under each
one runs solid then dashed, with a tick at both ends.

`hudFrame()` keeps the exact bounding rect it is given, which is what makes
this a restyle and not a relayout — the touch regions are computed from the
same numbers.

It is all still two-tone on purpose. The obvious way to sell the look would be
grey glows and gradients, but e-ink renders greys by dithering and pays for
them with a slower, ghost-prone refresh. Geometry is free on this display;
shading is not.

## Dark Mode

`--dark` (the KUAL `Dark` menu entries, or `DARK_MODE="1"` in `config.sh`)
renders the dashboard white-on-black.

Every draw call still works in the light palette, and the finished canvas is
inverted once, in `drawCurrentDashboard()`:

```cpp
if (g_dark_mode) invertCanvas(canvas);
```

Threading an ink/paper colour through every call site instead would produce
the same pixels for a two-tone design, but a single inversion cannot miss one
the way a hand-swapped palette can, and a new screen cannot forget to be dark.
The photo tile is the exception: it is pre-inverted on the way in, so the flip
at the end lands it back the right way round instead of leaving a negative.

The Kindle's own status bar occupies the top 66 px and the renderer
deliberately never writes there, so dark mode leaves that strip light.

## Photo Tile

The tile above Grocery renders an owner-supplied bitmap. The renderer reads
a plain 8-bit binary PGM (`P5`) — the same format its own `--dump-pgm` writes
— and scales it to fill the tile with a centered crop, so the source image
does not need to match the tile's aspect ratio or the device resolution:

```cpp
if (sw * h > sh * w) crop_w = sh * w / h; else crop_h = sw * h / w;
```

Convert any image with ImageMagick:

```sh
magick photo.jpg -colorspace Gray -resize 512x512^ -gravity center \
  -extent 512x512 -depth 8 kindle/kual/kindle-dashboard/assets/profile.pgm
```

The default path is
`/mnt/us/extensions/kindle-dashboard/assets/profile.pgm`; override it with
`--photo /path/to/file.pgm`. A missing or unreadable file is not fatal — the
tile is drawn as an empty framed box and the reason is logged.

`assets/` is deliberately untracked (`.gitignore`), because the photo is
personal to each owner. The `extension` / `extension-zig` Make targets copy
it into the KUAL package, so add your own file before packaging.

## Interactivity

There is no button framework.

Touch is manual:
tap coordinates -> rectangle -> dashboard action

Each tappable area is registered as a region, so a tap on the Chores,
Grocery or Notes tile opens that list full-screen, and a tap on a list item
marks it done.

The Agenda strip and the photo tile are informational, but they still
register a region — with the no-op action `kTouchNone`:

```cpp
addTouchRegion(tile_rect, kTouchNone, -1, -1, "", 0);
```

That is not redundant. When a tap misses every region, the handler retries it
through seven mirrored/rotated coordinate transforms, because the
touchscreen's axis orientation varies by Kindle model. Leaving a large area
unregistered means those guesses land somewhere else on screen — in practice,
tapping Agenda opened Chores and tapping the photo opened Grocery. Claiming
the area with a no-op consumes the tap before the fallback runs.

Code:
[`handlePendingTouch`](../kindle/native/src/kindle_dashboard.cpp) and
[`postToggleItemAsync`](../kindle/native/src/kindle_dashboard.cpp) in
[`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)

Task toggles update the offline cache optimistically and post to InsForge:

```cpp
if (action == kTouchToggleItem) {
  const int next_done = g_pending_item_done ? 0 : 1;
  patchCachedItemDone(options->cache, g_pending_item_id, next_done);
  postToggleItemAsync(options->toggle_url, options->toggle_token, g_pending_item_id, next_done);
  return 1;
}
```

The matching backend endpoint updates `planner_items`:

```ts
await admin.database
  .from("planner_items")
  .update({ done: body.done, updated_at: new Date().toISOString() })
  .eq("id", id);
```

## Screen Lock

A padlock button sits to EXIT's left in both headers. Tapping it sets
`g_screen_locked` and redraws immediately, open padlock to closed — for
carrying the Kindle around, or wiping the screen, without an incidental tap
opening a list or exiting to the Kindle home screen.

Locking is a touch. Unlocking deliberately is not. If the same tap that
locked the screen could also unlock it, that one spot would still be "live" —
a cloth wiping the glass, or the Kindle brushing against something in a bag,
could land on those exact pixels and undo the lock without anyone meaning to.
So while locked, every touch is inert, the lock button included:

```cpp
if (g_screen_locked) {
  fprintf(stderr, "input=locked x=%d y=%d\n", x, y);
  return 0;
}
```

The only way out is the Kindle's own power button — physical hardware, not a
point on the touchscreen. `initTouchInput()` looks for an input device that
reports `KEY_POWER` (the same `EVIOCGBIT` capability query used for the
touchscreen's axis ranges) and opens it read-only, *without* `EVIOCGRAB`: it's
a second, passive reader alongside whatever the Kindle's own `powerd` already
has open, so the button's normal sleep/wake behaviour is completely
unaffected by this also watching for the same press.

```cpp
if (event.type == EV_KEY && event.code == KEY_POWER && event.value == 1 && g_screen_locked) {
  g_pending_action = kTouchHardwareUnlock;
}
```

`kTouchHardwareUnlock` rides the same `g_pending_action` → `handlePendingTouch()`
→ redraw plumbing every touch action already uses; it just never originates
from the touchscreen. Always starts unlocked: the flag is a plain global,
reset by every relaunch.

## Change Detection

An InsForge SSE edge function checks for planner changes.

Every few seconds, it computes a version from the planner items.

Same data = same version.
Changed data = new version.

Weather and agenda are deliberately **not** part of this fast-polling SSE
version — they change on the clock, not on user writes, so the Kindle's
normal refresh interval is enough; polling Open-Meteo/CalDAV every couple of
seconds from the SSE function would just waste upstream requests.

The list filter here must stay in sync with `kindle-dashboard-data.ts`: any
list the dashboard renders has to be part of this hash, or writes to it never
push an update and the tile only catches up on the next scheduled poll.

Code:
[`functions/kindle-dashboard-events.ts`](../functions/kindle-dashboard-events.ts)

```ts
const data = await loadDashboardData();
const version = getDashboardVersion(data);
if (!force && version === lastVersion) {
  controller.enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
  return;
}
```

## Live Events

When the version changes, InsForge emits a small SSE event.

The event does not contain the whole dashboard.

It only tells the Kindle: fetch the latest JSON payload.

The event body is just the version string:

```ts
lastVersion = version;
controller.enqueue(encoder.encode(`event: planner\n`));
controller.enqueue(encoder.encode(`data: ${version}\n\n`));
```

The native watcher listens with `curl` and flips a refresh flag:

```cpp
if (strncmp(line_buffer, "event: planner", 14) == 0) {
  g_event_refresh = 1;
}
```

## Re-rendering

The Kindle treats the SSE event as a refresh signal.

It fetches the latest JSON payload, saves it to the offline cache, and
re-renders the dashboard.

If the network fails, it keeps rendering from the cached payload — and
because the backend never fails the whole request just because Weather or
Agenda is unreachable, "cached/offline" only shows up when the Kindle
itself has no connectivity, not when one upstream API is flaky.

Code:
[`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)

```cpp
const int fetched = fetchToCache(dashboard_url, options.read_token, options.cache);
if (!renderCachedPayload(&options, fetched ? "live" : "cached/offline")) {
  addCardText(lines, &count, " Dashboard unavailable");
  addCardText(lines, &count, " Check Wi-Fi or refresh later");
  renderToEips(lines, count);
}
```
