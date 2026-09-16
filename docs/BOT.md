# The Telegram Bot

Complete reference for `functions/telegram-webhook.ts`: who is allowed to use
the bot, everything it understands, everything it can answer, and how to
operate it.

For first-time setup see [INSTALL_FOR_USERS.md](INSTALL_FOR_USERS.md); this
document assumes the bot is already connected.

---

## Who Can Use It

**Only you.** A Telegram bot username is public and anybody can open a chat
with it, but this one answers exactly one chat and ignores every other.

Two independent gates, both in the first 25 lines of the handler:

| Gate | Checks | Fails with |
| --- | --- | --- |
| Webhook secret | `x-telegram-bot-api-secret-token` equals `TELEGRAM_WEBHOOK_SECRET` | `401 Unauthorized` |
| Chat allowlist | `message.chat.id` (or `callback_query.message.chat.id`) equals `TELEGRAM_ALLOWED_CHAT_ID` | `200 {ok:true, ignored:true, reason:"chat_not_allowed"}` |

The secret gate stops anyone who found your function URL from injecting fake
updates — only Telegram knows the secret, because you registered it with
`setWebhook`. The allowlist gate stops anyone who found your bot's `@name`.

What a stranger experiences: they send a message, Telegram delivers it to the
webhook, the webhook drops it and replies to *Telegram* (not to them) that it
was ignored. **They get no reply at all** — no error, no "not authorized", just
silence. Their text is never parsed, never sent to the LLM, and never written
to the database.

Button taps are checked separately, on their own chat id, because a
`callback_query` is a different update type that does not carry
`update.message`. Forwarding one of your confirmation messages to someone else
does not give them a working button: their tap arrives from their chat and is
dropped.

### Sharing it with the household

The check is on the **chat** id, not the sender id. So there are two ways to
let a second person in, and the difference matters:

- **A group chat.** Put the bot in a group, find the group's chat id (a
  negative number), and point `TELEGRAM_ALLOWED_CHAT_ID` at it. Everyone in
  that group can then drive the bot, and all confirmations land there. This is
  usually what a couple or a family wants.
- **Nothing else.** There is no second-chat allowlist. The comparison is a
  single string equality against one value.

Two things to know before doing the group route:

1. Bots in groups run in **privacy mode** by default, which means they only
   receive messages that start with `/` or that mention the bot — free text
   like "comprar leite" would never reach the webhook. Turn it off in
   BotFather: `/setprivacy` → select the bot → `Disable`.
2. Everyone in that group can read and change every list, and undo anything
   anyone else did. There is no per-person scoping anywhere in the schema.

To move the bot to a different chat, re-run the configure script with the new
id — it updates the stored secret in place:

```sh
npm run telegram:configure -- \
  --bot-token 123456789:telegram-bot-token \
  --chat-id -1001234567890 \
  --webhook-url https://your-project.insforge.app/functions/telegram-webhook
```

### If you think the bot was compromised

Rotating the bot token with BotFather (`/revoke`) kills the old token
immediately, but the webhook registration goes with it — re-run
`npm run telegram:configure` with the new token to store it and register the
webhook again.

The webhook secret rotates independently: change `TELEGRAM_WEBHOOK_SECRET` in
InsForge, then re-run the same script so Telegram is told the new value. The
two sides are compared on every update, so while they disagree the bot is
silent and every update is rejected with `401`.

---

## Commands

| Command | Also | Does |
| --- | --- | --- |
| `/start` | `/menu` | Shows the welcome text and pins the button keyboard |
| `/ajuda` | `/help` | Prints the full cheat sheet of free-text phrasings |
| `/listas` | `/lista`, `/ver`, the `👀 Ver listas` button | Prints the agenda, then the three lists (tarefas, notas, compras) |
| `/exportar [scope] [format]` | `/export` | Sends a `.json` (default) or `.yaml` file with the same data — one scope (`compras`, `tarefas`, `notas`, `agenda`) or `tudo` (default) |
| `/resumo [fechar]` | | Posts today's Markdown digest (see below). Preview only, unless `fechar` is added |
| `/resumo_hora [0-23]` | `/resumohora` | Shows or sets the local hour the automatic digest closes the day at (default 22) |

Commands are matched on the first token and are case-insensitive, so
`/Listas@meubot` works. `/exportar`'s two arguments are order-independent
(`/exportar yaml agenda` and `/exportar agenda yaml` are the same request).

The keyboard is persistent — it stays in the chat until dismissed, and `/menu`
brings it back:

```text
📋 Tarefa      📝 Nota
🛒 Compras     📅 Agenda
       👀 Ver listas
```

Tapping a category sends a force-reply prompt; your answer is attached to that
category. The category is recovered from the prompt text itself, so the bot
holds no session state and a reply still works days later, or after a redeploy.

`/listas`, `/exportar`, `/resumo`, `/resumo_hora` and the three list categories
never call the LLM. Only `📅 Agenda` does, because resolving "amanhã às 14h"
into an absolute timestamp needs one.

---

## Daily Digest

Once a day, at a locally-configured hour (`/resumo_hora`, default 22h,
timezone from `DASHBOARD_TIMEZONE`), the bot posts a Markdown message meant to
be pasted straight into a note-taking app (Obsidian, etc.):

```markdown
# 📆 Resumo do dia — 12/09

Janela: 11/09 22:00 → 12/09 22:00

## ✅ Concluído (2)
- [x] 🛒 Leite
- [x] 📋 Ligar pro dentista

## ➕ Adicionado (3)
- 🛒 Leite
- 🛒 Pão
- 📋 Ligar pro dentista
```

Two independent questions, not a partition of one list: an item added and
finished in the same window appears in both sections (like `Leite` above).
Once the message is sent, every item that showed up under **Concluído** is
deleted from the lists — the message itself becomes the permanent record,
and the table only ever holds what is still open.

The automatic run is driven by an hourly cron (`scripts/schedule-daily-
digest.mjs`) hitting `telegram-webhook` with a dedicated `DAILY_DIGEST_TOKEN`
header — InsForge schedules carry no timezone, so instead of keeping a cron
expression in sync with a local hour, the tick fires every hour and the
function itself decides whether the current hour (converted to
`DASHBOARD_TIMEZONE`) matches the configured one. Whether today's close has
already happened is an atomic claim in `bot_settings` (an `INSERT` against a
primary key, not a read-then-write flag), so a tick that lands twice in the
same hour never double-sends. The window itself starts at the last successful
close, not a flat "24 hours ago" — if one tick is ever missed (a platform
hiccup), the next one's window simply stretches back to cover the gap instead
of silently losing it.

`/resumo` runs the same report on demand, for the last 24 hours from *now* —
useful any time, and it never deletes anything or marks the day as closed, so
it can't steal or duplicate the automatic close-out. Add `fechar`
(`/resumo fechar`) to force that close-out immediately instead of waiting for
the configured hour — e.g. when going to bed earlier than usual; it uses the
same since-last-close window as the automatic run, and marks the day closed
so the schedule doesn't also close it again later.

Every write that flips an item's `done` — from Telegram, from the Kindle's own
touch checkbox (`kindle-dashboard-toggle.ts`), and undo — sets `completed_at`
alongside it, since that timestamp (not `updated_at`, which also moves on a
plain list-to-list move) is the digest's only way to know an item finished
inside the window versus just being edited during it.

Setup, once per backend: `npm run kit:backend` applies the migration and
generates `DAILY_DIGEST_TOKEN`; then `npm run digest:schedule -- --base-url
<INSFORGE_BASE_URL>` creates the hourly schedule.

---

## What It Understands

Free text, voice, or button — all three end at the same action dispatcher.
Lists are matched by alias, accents optional, Portuguese and English:

| List | Aliases |
| --- | --- |
| 🛒 Compras | `compras`, `comprar`, `mercado`, `supermercado`, `feira`, `grocery`, `groceries`, `shopping`, `market` |
| 📋 Tarefas | `tarefa(s)`, `afazeres`, `pendências`, `todo`, `to-do`, `task(s)`, `errand(s)` |
| 📝 Notas | `nota(s)`, `anotação`, `recado`, `note(s)` |

| Intent | Examples |
| --- | --- |
| add | `comprar leite e pão` · `adicionar limpar a mesa nas tarefas` · `anota o código do portão 4417` |
| complete | `já comprei o leite` · `feito: limpar a mesa` · `mark milk done` |
| uncomplete | `desmarca o leite` · `mark clean desk not done` |
| delete | `tira os ovos das compras` · `apaga limpar a mesa das tarefas` |
| clear | `limpa as tarefas` · `esvazia as compras` |
| edit | `mude o texto do item 3 da lista de compras para leite integral` |
| important / unimportant | `marca a tarefa 6 como importante` · `tira a importância do item 2` |
| schedule | `reunião amanhã às 14h com o time` · `consulta dia 20/09 às 10h` |
| cancel | `cancela a reunião do time` · `cancela o evento 1` |

One message can carry several different intents; each is applied to its own
list and a single `↩️ Desfazer` takes the whole message back. Several items of
the same intent are one action — "comprar leite e pão" is one add with two
items, not two adds.

If a complete/uncomplete/delete does not name a list, the bot searches all
three and says which one it hit.

### Numbered items and importance

`/listas` numbers every row in a list (`3. comprar leite`) and every upcoming
event in the agenda block (`1. 14:00 — Reunião`). That number is a live
position — open items first, important ones ahead of the rest, done items
last (see `orderForNumbering` in `telegram-webhook.ts`) — recomputed on every
render and every reference, never stored. Refer to a row by that number
instead of retyping its text: `conclua a tarefa 3`, `exclua o item 2 da lista
de compras`, `cancela o evento 1`. A number always addresses exactly one row,
so unlike a text needle it never triggers the disambiguation flow below.

Marking an item `important` (`marca a tarefa 6 como importante`) makes it sort
ahead of the rest of its open/done group and prefixes its number with `!`
(`!6. cortar cabelo`) in `/listas`; `/exportar` carries the same flag as an
`important` field per item. `unimportant` clears it. Both are number- or
text-addressed like complete/delete, and both carry an undo. There is no way
to set importance while adding an item in the same breath — mark it
afterward, same message or a follow-up.

**Voice notes**: hold to record and speak. Transcription and parsing happen in
one model call, so a voice note costs the same single request as typed text.
Limits: 5 minutes, 5 MB. Requires a Gemini `LLM_API_KEY` — with another
provider, voice reports itself unavailable and everything else keeps working.

---

## What It Answers

Every reply names the list it touched and echoes the item text **as stored**,
not as you typed it, so a fuzzy match that hit the wrong row is visible
immediately.

| Reply | Means |
| --- | --- |
| `✅ Anotei em 🛒 Compras: leite.` | Added |
| `✅ Concluí em 🛒 Compras: Café.` | Marked done — note the stored casing |
| `↩️ Reabri em 📋 Tarefas: regar as plantas.` | Marked open again |
| `🗑 Removi de 🛒 Compras: ovos.` | Deleted |
| `✏️ Editei em 🛒 Compras: leite → leite integral.` | Text replaced |
| `⭐ Marquei como importante em 📋 Tarefas: cortar cabelo.` | Importance set (or cleared) |
| `🤔 Não achei "banana" em 🛒 Compras.` | Nothing matched — **nothing was changed** |
| `🤔 Não achei "item 5" em 📋 Tarefas.` | That number does not exist in that list right now |
| `📅 Agendado: Reunião com o time` / `amanhã às 14:00 · sala 2` | Calendar event created |
| `🎤 "comprar leite, pão e ovos"` | What the bot heard, before what it did |
| `🤔 Não entendi.` | Parsed to nothing; use the buttons |
| `🤔 Não peguei a data/hora.` | Calendar intent recognised, timestamp not resolvable |
| `⏳ Meu interpretador de texto livre bateu o limite do dia.` | LLM quota (HTTP 429) — buttons still work |
| `⏳ A IA não respondeu agora.` | LLM timeout or 5xx after one retry |
| `🎤 Esse áudio é longo demais.` | Over 5 min or 5 MB |
| `⚠️ Não consegui salvar agora.` | Database write failed |
| `⚠️ Não consegui falar com o servidor da agenda.` | CalDAV unreachable or timed out |
| `⚠️ A agenda ainda não está configurada no servidor.` | `CALDAV_*` secrets missing |

The "not found" reply is the important one. Complete, uncomplete and delete
match item text by substring, so the webhook resolves the matching rows
*before* writing and reports what it actually changed. A blind
`UPDATE ... ILIKE` would confirm changes that never happened.

### Undo

Every confirmation that actually changed something carries an `↩️ Desfazer`
button, good for **24 hours** and usable **once**. It reverses exactly that
message: re-adding deleted items with their original done state, un-marking
what it marked, deleting what it created, restoring a cancelled calendar event
from its original ICS. Tapping a spent button says so rather than applying
twice — the token is consumed before the operation replays, so a double tap or
a Telegram retry cannot double-apply.

### Disambiguation

If a word matches more than one item — "já comprei o pão" with both `pão` and
`pão de forma` on the list — **nothing is changed**. The bot lists the
candidates as buttons and applies only the one you tap, with `⚡ Todos` when the
sweep really was what you meant and `✖️ Cancelar` to walk away. An invalid or
expired choice does not burn the question.

The same happens when a cancellation matches several events, and when a
free-text add had to guess the list because the message named none — there the
item is saved immediately and the bot offers to move it, so nothing is held
hostage waiting for a tap.

---

## How A Message Becomes An Action

Four stages, first hit wins:

1. **Fast heuristic** — fires only when the message names *both* an action verb
   and a list, *and* carries exactly one verb family. Deliberately strict:
   guessing the list wrong writes to the wrong place, and a message with two
   verb families ("anota o código, adiciona regar as plantas e marca os ovos")
   is several requests that a regex would collapse into one. Costs nothing.
2. **Parse cache** — FNV-1a hash of the normalized text, looked up in
   `bot_parse_cache`. 30-day TTL. Calendar results are never cached, because
   they are resolved against "now" and would hand back yesterday's date
   tomorrow.
3. **LLM** — one call with a strict JSON schema (`response_format:
   json_schema`, `strict: true`) returning an array of actions. 12-second
   timeout, one retry on HTTP 503 only.
4. **Heuristic fallback** — if the LLM errored or returned nothing usable. On a
   quota error the LLM failure is kept so the reply can explain the quota wall
   instead of pretending the message was gibberish.

Without `LLM_API_KEY` the bot skips straight from stage 1 to stage 4 and works
fine for explicit phrasings; only natural dates ("segunda que vem") are lost.

Model output is validated, never trusted: `validateTelegramActions` accepts the
array shape, a bare object, and the nested-wrapper shape Gemini occasionally
emits, and discards anything that does not typecheck into a known action.

---

## Limits

| Thing | Value | Where |
| --- | --- | --- |
| Undo token lifetime | 24 h, single use | `UNDO_TTL_MS` |
| Parse cache entry lifetime | 30 days | `PARSE_CACHE_TTL_MS` |
| Voice note | 5 min / 5 MB | `MAX_VOICE_SECONDS`, `MAX_VOICE_BYTES` |
| LLM call timeout | 12 s | `callLlm` |
| CalDAV timeout | 8 s | `applyCalendarAction` |
| Agenda events in `/listas` | 5 | `OVERVIEW_MAX_EVENTS` |
| Agenda lookahead | 365 days | `AGENDA_LOOKAHEAD_DAYS` |
| Telegram `callback_data` | 64 bytes (protocol cap) | tokens are 16 hex chars |

Free-tier Gemini meters **requests per day, not tokens**. The full flash models
allow around 20 a day; the flash-lite models allow far more, which is why
`LLM_MODEL` defaults to `gemini-3.5-flash-lite`. Check your own numbers at
<https://ai.dev/rate-limit>. `LLM_REASONING_EFFORT=low` is what keeps replies
near 1 s — Gemini 3.x thinks before answering by default, which costs 9–13 s on
a task this small.

---

## Operating It

Two tables belong to the bot alone; neither is read by the Kindle:

- **`bot_actions`** — pending undo and disambiguation payloads, keyed by the
  token that rides in `callback_data`. Every undo write also prunes rows older
  than 24 h — of both kinds — so the table stays small on its own without a
  scheduled job.
- **`bot_parse_cache`** — `message_hash` → action, with a `hits` counter and
  `last_used_at`. Safe to truncate at any time; the bot refills it.

```sh
# what is cached, most used first
npx @insforge/cli db query -- \
  "SELECT hits, action, last_used_at FROM bot_parse_cache ORDER BY hits DESC LIMIT 20;"

# forget one bad parse (or TRUNCATE for all of them)
npx @insforge/cli db query -- \
  "DELETE FROM bot_parse_cache WHERE action::text ILIKE '%wrong item%';"

# pending undo/choice tokens right now
npx @insforge/cli db query -- \
  "SELECT id, kind, created_at FROM bot_actions ORDER BY created_at DESC;"
```

Both tables have RLS enabled and are reached only through the function's
service key.

Function logs are prefixed `telegram-webhook` and name the failure, never the
payload: `llm_http_429`, `llm_network_error`, `voice_http_400`,
`calendar_put_507`, `parse_cache_read_failed`, `undo_consume_failed`,
`prune_failed`. Successful requests log a timing line with `total_ms`.

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Bot silent to everything, including `/start` | Webhook secret mismatch (every update 401s), or `TELEGRAM_ALLOWED_CHAT_ID` points at a different chat. Check `getWebhookInfo` for `last_error_message`. |
| Buttons work, free text says `🤔 Não entendi` | `LLM_API_KEY` missing or wrong — the heuristic path is all that is left |
| `⏳ bateu o limite do dia` | Daily request quota. Switch `LLM_MODEL` to a flash-lite model or wait for the reset |
| Replies take 9–13 s | `LLM_REASONING_EFFORT` is not set to `low` |
| Voice says it needs AI configured | `LLM_BASE_URL` does not point at Gemini and `LLM_AUDIO_BASE_URL` is unset |
| Calendar events save but never appear | `CALDAV_CALENDAR_PATH` points at a collection the Kindle payload does not read |
| Agenda shows fewer events than exist | `AGENDA_LOOKAHEAD_DAYS` was shrunk — it bounds the query, so anything past it is invisible no matter how few events are found |
| Event times are off by a fixed number of hours | An older deploy: `TZID` was resolved against the edge host's zone instead of the calendar's |
| A button spins forever | The function errored before `answerCallbackQuery`; check the logs for that request |

---

## Design Notes

- **Single-owner by design.** One chat, one set of lists, no per-user scoping
  in any table. A hosted multi-user version would need row ownership and device
  pairing everywhere.
- **The buttons never need the LLM.** Every destructive or additive operation
  is reachable without a model call, which is what makes a quota wall an
  inconvenience rather than an outage.
- **Nothing is written before it is resolved.** Matching rows are selected
  first, written by id second, and reported as hits and misses separately.
- **Replies are in Brazilian Portuguese**, including every error string — the
  copy lives in one `MSG` block at the top of the function, next to
  `LIST_LABELS`, so translating the bot means editing one place.
