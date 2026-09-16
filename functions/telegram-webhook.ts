import { createAdminClient } from "npm:@insforge/sdk";

type ListKey = "grocery" | "todo" | "notes";

type PlannerAction = {
  kind?: "planner";
  action: "add" | "complete" | "uncomplete" | "delete" | "clear" | "edit" | "important" | "unimportant";
  list_key: ListKey;
  items: string[];
  // Alternative targeting to `items`' text needles: 1-based positions in the
  // same order /listas numbers that list's rows (see orderForNumbering).
  // Unambiguous by construction, so it never produces a disambiguation
  // choice the way a text needle can. Never set for "add" — there is nothing
  // to number yet.
  item_numbers?: number[];
  // Only used by action "edit": the replacement text for the targeted row(s).
  new_text?: string;
  all_lists?: boolean;
  // Set only by the heuristic parser, when it had to pick a destination with
  // nothing in the message naming one. The LLM path never sets it: there the
  // model classified on meaning, not on a default.
  guessed_list?: boolean;
};

type CalendarAction = {
  kind: "calendar";
  action: "create" | "delete";
  title: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  location: string | null;
  // Alternative targeting to `title`'s search text, for "delete": the
  // 1-based position among the events the agenda block last showed (see
  // upcomingAgendaEvents). Null when the user named the event by text instead.
  event_number: number | null;
};

type TelegramAction = PlannerAction | CalendarAction;

type TelegramAudio = { file_id?: string; duration?: number; file_size?: number; mime_type?: string };

type TelegramUpdate = {
  message?: {
    chat?: { id?: number | string };
    message_id?: number;
    text?: string;
    // Present when the user replied to one of our own messages. Used to carry
    // the category picked from the menu keyboard back to us statelessly: we
    // recognize our own force-reply prompt text and skip NLP classification.
    reply_to_message?: { text?: string };
    // A held-to-record voice note. `audio` is the same payload for a file the
    // user attached rather than recorded.
    voice?: TelegramAudio;
    audio?: TelegramAudio;
  };
  // Sent when the user taps an inline button (undo, disambiguation). The
  // payload rides in callback_data, capped by Telegram at 64 bytes — hence the
  // short id pointing at a bot_actions row rather than the data itself.
  callback_query?: {
    id?: string;
    data?: string;
    message?: { chat?: { id?: number | string }; message_id?: number; text?: string };
  };
};

// ---------------------------------------------------------------------------
// Category menu (stateless): a persistent keyboard with 4 buttons. Tapping one
// sends its exact label as a message; we answer with a force-reply prompt
// whose exact text encodes the category. Telegram echoes that prompt back as
// reply_to_message on the user's next message, so we recover the category
// without needing any server-side session storage between the two requests.
// ---------------------------------------------------------------------------

type MenuCategory = { button: string; prompt: string; listKey?: ListKey; calendar?: true };

const MENU_CATEGORIES: MenuCategory[] = [
  { button: "📋 Tarefa", prompt: "📋 Tarefa — qual é a tarefa? (várias? separe por vírgula)", listKey: "todo" },
  { button: "📝 Nota", prompt: "📝 Nota — o que você quer anotar? (várias? separe por vírgula)", listKey: "notes" },
  { button: "🛒 Compras", prompt: "🛒 Compras — o que entra na lista? (vários? separe por vírgula)", listKey: "grocery" },
  { button: "📅 Agenda", prompt: "📅 Agenda — descreva o evento (ex.: reunião amanhã às 14h na sala 2)", calendar: true }
];

// Every prompt starts with its button label, so the category is recovered from
// the label prefix rather than from the full prompt text. Matching on the whole
// string made the copy itself part of the protocol: editing a single word broke
// every force-reply already open in the chat at deploy time.
function categoryForRepliedPrompt(promptText: string | undefined): MenuCategory | undefined {
  if (!promptText) return undefined;
  return MENU_CATEGORIES.find((category) => promptText.startsWith(category.button));
}

// Not a MenuCategory: this one answers immediately instead of opening a
// force-reply, so it deliberately sits outside the category protocol.
const VIEW_BUTTON = "👀 Ver listas";

function categoryKeyboardMarkup(): unknown {
  return {
    keyboard: [
      [MENU_CATEGORIES[0].button, MENU_CATEGORIES[1].button],
      [MENU_CATEGORIES[2].button, MENU_CATEGORIES[3].button],
      [VIEW_BUTTON]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

// ---------------------------------------------------------------------------
// Copy (pt-BR)
//
// Every string the chat ever sees lives here. Telegram is UTF-8, so these keep
// their accents: the ASCII folding the e-ink renderer needs happens on read in
// kindle-dashboard-data.ts, never on the text stored or echoed back here.
// ---------------------------------------------------------------------------

const LIST_LABELS: Record<ListKey, string> = {
  grocery: "🛒 Compras",
  todo: "📋 Tarefas",
  notes: "📝 Notas"
};

const MSG = {
  welcome: [
    "👋 Oi! Toque numa categoria no teclado abaixo ou escreva à vontade — eu entendo texto solto.",
    "",
    "Exemplos:",
    "• “comprar leite e pão” → vai pra 🛒 Compras",
    "• “lembrar de ligar pro dentista” → 📋 Tarefas",
    "• “anota que a senha do wifi é casa123” → 📝 Notas",
    "• “reunião amanhã às 14h na sala 2” → 📅 Agenda",
    "",
    "👀 Ver listas mostra tudo o que está anotado. /ajuda mostra os comandos."
  ].join("\n"),

  help: [
    "📖 Como me usar",
    "",
    "▸ Pelos botões (sempre funciona, não depende de IA):",
    "toque na categoria, eu pergunto o conteúdo, você responde. Vários itens de uma vez? Separe por vírgula.",
    "",
    "▸ Por texto livre:",
    "• adicionar → “comprar leite”, “preciso passar na farmácia”, “anota o telefone do João”",
    "• concluir → “já comprei o café”, “feito: ligar pro dentista”",
    "• reabrir → “desmarca o café”",
    "• remover → “tira o leite da lista”",
    "• limpar → “limpa as compras”",
    "• agendar → “reunião amanhã às 14h”, “consulta dia 20/09 às 9h”",
    "• cancelar → “cancela a reunião de sexta”",
    "",
    "▸ Por número: /listas numera cada item (“3. comprar leite”) e evento (“1. 14h — Reunião”); use o número em vez do texto:",
    "• “conclua a tarefa 3”, “exclua o item 2 da lista de compras”, “cancela o evento 1”",
    "• editar → “mude o texto do item 3 da lista de compras para leite integral”",
    "• importante → “marca a tarefa 6 como importante” / “tira a importância do item 2” — o item importante aparece primeiro na lista, com “!” antes do número (ex.: “!6. cortar cabelo”)",
    "",
    "▸ Comandos: /listas (ver tudo) · /menu (teclado) · /ajuda (esta mensagem)",
    "▸ /exportar [compras|tarefas|notas|agenda|tudo] [json|yaml] → manda um arquivo com os dados (padrão: tudo em json)",
    "▸ /resumo → resumo do dia em Markdown (adicionado + concluído); /resumo fechar já tira os concluídos das listas",
    "▸ /resumo_hora [0-23] → vê ou muda a hora do fechamento automático diário (padrão 22h)"
  ].join("\n"),

  saveFailed: "⚠️ Não consegui salvar agora. Tente de novo em instantes.",

  unparsed: "🤔 Não entendi. Use os botões do /menu ou escreva algo como “comprar leite”, “já fiz X” ou “reunião amanhã às 14h”.",

  unparsedCalendar: "🤔 Não peguei a data/hora. Tente assim: “reunião amanhã às 14h” ou “consulta dia 20/09 às 9h”.",

  // The free Gemini tier is capped per day, so this is a state the user will
  // genuinely hit. Point them at the buttons, which never call the model.
  llmQuota: "⏳ Meu interpretador de texto livre bateu o limite do dia. Use os botões do /menu — eles funcionam sempre.",

  llmUnavailable: "⏳ A IA não respondeu agora. Tente de novo, ou use os botões do /menu.",

  voiceTooLong: "🎤 Esse áudio é longo demais. Grave até 5 minutos, ou mande por texto.",
  voiceUnavailable: "🎤 Áudio precisa da IA configurada. Use os botões do /menu ou mande por texto.",

  calendarNotConfigured: "⚠️ A agenda ainda não está configurada no servidor.",
  calendarUnreachable: "⚠️ Não consegui falar com o servidor da agenda. Tente de novo em instantes.",
  calendarNeedsDate: "📅 Preciso de uma data e hora. Ex.: “reunião amanhã às 14h”.",
  calendarSaveFailed: "⚠️ Não consegui salvar esse evento na agenda.",
  calendarDeleteFailed: "⚠️ Não consegui apagar esse evento.",
  untitledEvent: "Evento sem título"
};

function unparsedMessage(parsed: ParseOutcome, calendarOnly: boolean): string {
  if (parsed.llmError === "quota") return MSG.llmQuota;
  if (parsed.llmError === "too_long") return MSG.voiceTooLong;
  if (parsed.llmError === "unavailable") return MSG.llmUnavailable;
  // A transcript with no action means the audio was heard fine and simply did
  // not contain a request — saying so beats a generic "I did not understand".
  if (parsed.transcript) return `🎤 “${parsed.transcript}”\n\n${MSG.unparsed}`;
  return calendarOnly ? MSG.unparsedCalendar : MSG.unparsed;
}

function joinItems(items: string[]): string {
  return items.join(", ");
}

export default async function(req: Request): Promise<Response> {
  const started = timeMs();
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method === "GET") {
    return jsonResponse({ ok: true, service: "telegram-webhook" });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  // The hourly digest schedule posts here too (see handleDigestTick), carrying
  // its own header/secret instead of Telegram's — check for it before the
  // Telegram-secret check below, which would otherwise 401 every tick.
  if (req.headers.get("x-daily-digest-token") !== null) {
    return await handleDigestTick(req);
  }

  const configuredSecret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
  const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (receivedSecret !== configuredSecret) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const update = (await req.json()) as TelegramUpdate;
  const allowedChatId = requiredEnv("TELEGRAM_ALLOWED_CHAT_ID");

  // A button tap arrives as callback_query, not message, and carries its own
  // chat — so it has to pass the same allowlist check on its own terms.
  if (update.callback_query) {
    const callbackChatId = String(update.callback_query.message?.chat?.id ?? "");
    if (callbackChatId !== allowedChatId) {
      return jsonResponse({ ok: true, ignored: true, reason: "chat_not_allowed" });
    }
    return await handleCallbackQuery(update.callback_query, callbackChatId, started);
  }

  const chatId = String(update.message?.chat?.id ?? "");
  if (chatId !== allowedChatId) {
    return jsonResponse({ ok: true, ignored: true, reason: "chat_not_allowed" });
  }

  const voice = update.message?.voice ?? update.message?.audio;
  const incomingMessageId = update.message?.message_id;
  const text = update.message?.text?.trim();
  if (!text && !voice) {
    return jsonResponse({ ok: true, ignored: true, reason: "no_text" });
  }

  // /start or /menu (re)shows the persistent category keyboard.
  const command = (text ?? "").split(/[\s@]/)[0].toLowerCase();
  if (command === "/start" || command === "/menu") {
    sendTelegramMessageInBackground(chatId, MSG.welcome, categoryKeyboardMarkup());
    return jsonResponse({ ok: true, menu: "shown" });
  }

  if (command === "/ajuda" || command === "/help") {
    sendTelegramMessageInBackground(chatId, MSG.help, categoryKeyboardMarkup());
    return jsonResponse({ ok: true, menu: "help" });
  }

  // Reading back what is on the lists was only possible by walking over to the
  // Kindle. It is the most common question a list bot gets asked, and it costs
  // no LLM call at all.
  if (text === VIEW_BUTTON || command === "/listas" || command === "/lista" || command === "/ver") {
    const viewAdmin = insforgeAdmin();
    sendTypingInBackground(chatId);
    let overview: string;
    try {
      overview = await buildListsOverview(viewAdmin);
    } catch (error) {
      console.error(`telegram-webhook overview_failed ${errorMessage(error)}`);
      overview = MSG.saveFailed;
    }
    sendTelegramMessageInBackground(chatId, overview, undefined, incomingMessageId);
    logTiming("telegram-webhook", { action: "overview", total_ms: elapsedMs(started) });
    // Echoed back like `summary` is for actions: the response only ever reaches
    // a caller that already proved it knows TELEGRAM_WEBHOOK_SECRET.
    return jsonResponse({ ok: true, view: "lists", overview });
  }

  // Same data as /listas, but as a file: /exportar [compras|tarefas|notas|agenda|tudo] [json|yaml]
  // in either order, both optional (defaults: tudo, json). Native server data only — no
  // reshaping beyond what the overview already shows.
  if (command === "/exportar" || command === "/export") {
    const exportAdmin = insforgeAdmin();
    sendTypingInBackground(chatId, "upload_document");
    const args = (text ?? "").split(/\s+/).slice(1).map((token) => foldAccents(token.toLowerCase()));
    const format: ExportFormat = args.includes("yaml") || args.includes("yml") ? "yaml" : "json";
    const scope = parseExportScope(args);
    try {
      const payload = await buildExportPayload(exportAdmin, scope);
      const serialized = format === "yaml" ? toYaml(payload) : JSON.stringify(payload, null, 2);
      const extension = format === "yaml" ? "yaml" : "json";
      const filename = `dashboard-${scope}.${extension}`;
      const mimeType = format === "yaml" ? "application/yaml" : "application/json";
      sendTelegramDocumentInBackground(chatId, filename, serialized, mimeType, incomingMessageId);
    } catch (error) {
      console.error(`telegram-webhook export_failed ${errorMessage(error)}`);
      sendTelegramMessageInBackground(chatId, MSG.saveFailed, undefined, incomingMessageId);
    }
    logTiming("telegram-webhook", { action: "export", total_ms: elapsedMs(started) });
    return jsonResponse({ ok: true, export: scope, format });
  }

  // Manual pull of the same digest the hourly schedule sends automatically
  // (see handleDigestTick). Preview by default — nothing is deleted and
  // "already sent today" is not marked — so asking for it never steals or
  // duplicates the day's real close-out. Add "fechar" to force that close-out
  // right now instead of waiting for the configured hour.
  if (command === "/resumo") {
    const digestAdmin = insforgeAdmin();
    sendTypingInBackground(chatId);
    const args = (text ?? "").split(/\s+/).slice(1).map((token) => foldAccents(token.toLowerCase()));
    const wantsClose = args.includes("fechar");
    try {
      const now = new Date();
      // Preview: always the plain last 24h, independent of the close cycle.
      // "fechar": since the last successful close, same as the automatic tick —
      // so forcing an early close never leaves a gap for the next one either.
      const windowStart = wantsClose
        ? await getDigestWindowStart(digestAdmin, now)
        : new Date(now.getTime() - DIGEST_WINDOW_MS);
      const digest = await buildDailyDigest(digestAdmin, windowStart, now);
      sendDigestMessageInBackground(chatId, digest.markdown);
      if (wantsClose) {
        await closeDailyDigest(digestAdmin, digest, now);
        sendTelegramMessageInBackground(chatId, "🔒 Fechei o dia: os itens concluídos acima saíram das listas.");
      }
    } catch (error) {
      console.error(`telegram-webhook digest_failed ${errorMessage(error)}`);
      sendTelegramMessageInBackground(chatId, MSG.saveFailed, undefined, incomingMessageId);
    }
    logTiming("telegram-webhook", { action: "digest", total_ms: elapsedMs(started) });
    return jsonResponse({ ok: true, action: "digest", closed: wantsClose });
  }

  // Reads or sets the local hour the automatic digest closes the day at —
  // stored in bot_settings so it takes effect on the very next hourly tick,
  // no redeploy and no schedule edit.
  if (command === "/resumo_hora" || command === "/resumohora") {
    const settingsAdmin = insforgeAdmin();
    const arg = (text ?? "").split(/\s+/)[1];
    if (!arg) {
      const hour = await getDigestHour(settingsAdmin);
      sendTelegramMessageInBackground(
        chatId,
        `🕙 O resumo diário fecha às ${String(hour).padStart(2, "0")}h (fuso ${configuredTimezone()}). Para mudar: /resumo_hora 22`,
        undefined,
        incomingMessageId
      );
      return jsonResponse({ ok: true, digest_hour: hour });
    }
    const parsedHour = Number(arg);
    if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) {
      sendTelegramMessageInBackground(chatId, "⚠️ Use um número de 0 a 23. Ex.: /resumo_hora 22", undefined, incomingMessageId);
      return jsonResponse({ ok: true, error: "invalid_hour" });
    }
    await setBotSetting(settingsAdmin, DIGEST_HOUR_SETTING, String(parsedHour));
    sendTelegramMessageInBackground(
      chatId,
      `✅ Resumo diário passa a fechar às ${String(parsedHour).padStart(2, "0")}h.`,
      undefined,
      incomingMessageId
    );
    return jsonResponse({ ok: true, digest_hour: parsedHour });
  }

  // Step 1 of the menu flow: the user tapped a category button. Ask for the
  // content with a force-reply — the category rides back to us on the reply.
  const tappedCategory = MENU_CATEGORIES.find((category) => category.button === text);
  if (tappedCategory) {
    sendTelegramMessageInBackground(chatId, tappedCategory.prompt, { force_reply: true });
    return jsonResponse({ ok: true, menu: "prompted", category: tappedCategory.listKey ?? "calendar" });
  }

  // Step 2 of the menu flow: this message replies to one of our own prompts,
  // so the category is already known — skip kind/list classification entirely
  // for planner adds. Only the calendar category still needs NLP, to resolve
  // relative dates/times out of free text.
  const repliedCategory = categoryForRepliedPrompt(update.message?.reply_to_message?.text);

  // Everything from here on can involve a model call, a file download or a
  // CalDAV round trip.
  sendTypingInBackground(chatId);

  // Created before parsing, not after: the parse cache lives in the same
  // database, and a cache hit is what keeps a repeated message off the model.
  const admin = insforgeAdmin();

  const parseStarted = timeMs();
  let parsed: ParseOutcome;
  if (voice) {
    // A voice note carries no category, so it always goes through the full
    // classifier — even when it answers one of our force-reply prompts.
    parsed = await parseVoiceMessage(voice);
  } else if (repliedCategory?.listKey) {
    parsed = { actions: [buildPlannerAddAction(repliedCategory.listKey, text ?? "")] };
  } else if (repliedCategory?.calendar) {
    parsed = await parseCalendarMessage(text ?? "");
  } else {
    parsed = await parseTelegramMessage(text ?? "", admin);
  }
  const parseMs = elapsedMs(parseStarted);
  const actions = parsed.actions;
  if (actions.length === 0) {
    sendTelegramMessageInBackground(
      chatId,
      unparsedMessage(parsed, Boolean(repliedCategory?.calendar)),
      undefined,
      incomingMessageId
    );
    return jsonResponse({ ok: true, ignored: true, reason: parsed.llmError ?? "unparsed" });
  }

  // applyPlannerAction rethrows database errors. Letting one escape would 500 the
  // webhook, which leaves the user with no reply at all and makes Telegram retry the
  // same update on a loop. Answer the chat instead and acknowledge the update.
  //
  // Actions are applied in order and their results merged into one reply: the
  // undo list is already a list, so a single button takes back the whole
  // message rather than leaving half of it applied.
  const applyStarted = timeMs();
  const summaries: string[] = [];
  const undoOps: UndoOp[] = [];
  const pendingChoices: PendingChoice[] = [];
  for (const action of actions) {
    let applied: Applied;
    try {
      applied = await applyTelegramAction(admin, action);
    } catch (error) {
      const detail = errorMessage(error);
      console.error("telegram-webhook apply failed", detail);
      sendTelegramMessageInBackground(chatId, MSG.saveFailed, undefined, incomingMessageId);
      logTiming("telegram-webhook", {
        action: action.kind || "planner",
        parse_ms: parseMs,
        apply_ms: elapsedMs(applyStarted),
        total_ms: elapsedMs(started),
        error: detail
      });
      return jsonResponse({ ok: true, applied: false, reason: "apply_failed" });
    }
    if (applied.summary) summaries.push(applied.summary);
    undoOps.push(...applied.undo);
    pendingChoices.push(...(applied.choices ?? []));
  }

  const applyMs = elapsedMs(applyStarted);
  const undoToken = await storeUndo(admin, undoOps);
  // The transcript leads the confirmation so a misheard word is visible right
  // where the item it produced is named.
  const heard = parsed.transcript ? `🎤 “${parsed.transcript}”\n` : "";
  const summary = summaries.join("\n");
  if (summary) {
    sendTelegramMessageInBackground(chatId, `${heard}${summary}`, undoKeyboardMarkup(undoToken), incomingMessageId);
  } else if (heard) {
    sendTelegramMessageInBackground(chatId, heard.trim(), undefined, incomingMessageId);
  }
  for (const choice of pendingChoices) {
    await sendChoice(admin, chatId, choice, incomingMessageId);
  }
  logTiming("telegram-webhook", {
    action: actions.map((entry) => entry.kind || "planner").join("+"),
    actions: actions.length,
    parse_ms: parseMs,
    apply_ms: applyMs,
    total_ms: elapsedMs(started),
    cached: parsed.cached ? 1 : 0
  });

  return jsonResponse({
    ok: true,
    actions,
    summary,
    undo: undoToken !== null,
    ...(parsed.transcript ? { transcript: parsed.transcript } : {}),
    ...(parsed.cached ? { cached: true } : {}),
    ...(pendingChoices.length ? { choices: pendingChoices.length } : {})
  });
}

// ---------------------------------------------------------------------------
// Lists overview
// ---------------------------------------------------------------------------

const OVERVIEW_MAX_ITEMS_PER_LIST = 20;
const OVERVIEW_MAX_EVENTS = 5;

// Display order only for /listas: agenda first (what's coming up matters most),
// then tarefas, notas, compras. LIST_KEYS itself stays in its original order —
// it also drives move-to-another-list button order and alias matching, which
// nobody asked to reshuffle.
const OVERVIEW_LIST_ORDER: ListKey[] = ["todo", "notes", "grocery"];

async function buildListsOverview(admin: any): Promise<string> {
  const { data, error } = await admin.database
    .from("planner_items")
    .select("list_key, text, done, important, created_at")
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as { list_key: ListKey; text: string; done: boolean; important: boolean }[];
  const listBlocks = OVERVIEW_LIST_ORDER.map((key) => renderListBlock(key, rows.filter((row) => row.list_key === key)));

  // The agenda is fetched alongside because the bot's fourth category is
  // Agenda: an overview that silently omits it would read as a bug. It is also
  // the only block allowed to fail — a CalDAV hiccup must not cost the lists.
  const agenda = await renderAgendaBlock();
  const blocks = agenda ? [agenda, ...listBlocks] : listBlocks;

  return blocks.join("\n\n");
}

// Open-and-important first, then open, then done-and-important, then done —
// numbers below are assigned over this exact order so "conclua a tarefa 3"
// always resolves to the row a user just read as "3." in /listas. Relies on
// Array#sort being stable (guaranteed since ES2019), so each group keeps the
// created_at-ascending order the query already returned.
function orderForNumbering<T extends { done?: boolean; important?: boolean }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aDone = Boolean(a.done);
    const bDone = Boolean(b.done);
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aImportant = Boolean(a.important);
    const bImportant = Boolean(b.important);
    if (aImportant !== bImportant) return aImportant ? -1 : 1;
    return 0;
  });
}

function renderListBlock(key: ListKey, rows: { text: string; done: boolean; important: boolean }[]): string {
  const label = LIST_LABELS[key];
  if (rows.length === 0) return `${label}\n(vazia)`;

  const ordered = orderForNumbering(rows);
  const shown = ordered.slice(0, OVERVIEW_MAX_ITEMS_PER_LIST);
  const lines = shown.map((row, index) => {
    const number = index + 1;
    return `${row.done ? "✅" : "▫️"} ${row.important ? "!" : ""}${number}. ${row.text}`;
  });
  if (ordered.length > shown.length) {
    lines.push(`… e mais ${ordered.length - shown.length}`);
  }
  const open = rows.filter((row) => !row.done).length;
  return `${label} (${open} em aberto)\n${lines.join("\n")}`;
}

async function renderAgendaBlock(): Promise<string | null> {
  const baseUrl = Deno.env.get("CALDAV_BASE_URL");
  const calendarPath = Deno.env.get("CALDAV_CALENDAR_PATH");
  if (!baseUrl || !calendarPath) return null;

  let events: CalendarEventRow[];
  try {
    events = await upcomingAgendaEvents(
      baseUrl,
      calendarPath,
      Deno.env.get("CALDAV_USERNAME"),
      Deno.env.get("CALDAV_PASSWORD")
    );
  } catch (error) {
    console.error(`telegram-webhook overview_agenda_failed ${errorMessage(error)}`);
    return "📅 Agenda\n(não consegui consultar agora)";
  }

  if (events.length === 0) return "📅 Agenda\n(nada agendado)";

  const lines = events.map(
    (event, index) => `${index + 1}. ${formatEventTime(new Date(event.start), event.allDay)} — ${event.title}`
  );
  return `📅 Agenda\n${lines.join("\n")}`;
}

// Same window, order and cap /listas' agenda block renders, factored out so
// "cancela o evento 1" addresses exactly the row the user just read there —
// see deleteCalendarEventByNumber.
async function upcomingAgendaEvents(
  baseUrl: string,
  calendarPath: string,
  username: string | undefined,
  password: string | undefined
): Promise<CalendarEventRow[]> {
  // "Ver listas" answers "what is coming up", so the window only bounds the
  // query — the cap below is what decides how much is shown. A tight window
  // here used to print "nada nas próximas 36h" at a calendar with four events
  // in it.
  const now = new Date();
  const until = new Date(now.getTime() + calendarLookaheadDays() * 24 * 60 * 60 * 1000);
  const events = await queryCalendarEvents(baseUrl, calendarPath, username, password, now, until);
  return events.sort((a, b) => a.start.localeCompare(b.start)).slice(0, OVERVIEW_MAX_EVENTS);
}

// ---------------------------------------------------------------------------
// Export (/exportar, /export)
//
// Same underlying data as the overview above, reshaped for a machine reader
// instead of a chat bubble: full item/event fields, not the truncated,
// emoji-prefixed lines /listas renders.
// ---------------------------------------------------------------------------

type ExportFormat = "json" | "yaml";
type ExportScope = ListKey | "calendar" | "all";

// Built lazily, not as a module-scope const: LIST_ALIASES is declared much
// further down the file (Shared helpers), and spreading it eagerly here would
// read it before its own initializer runs.
function exportScopeAliases(): Record<Exclude<ExportScope, "all">, string[]> {
  return {
    ...LIST_ALIASES,
    calendar: ["agenda", "calendar", "calendario", "eventos", "evento"]
  };
}

function parseExportScope(args: string[]): ExportScope {
  if (args.some((token) => token === "tudo" || token === "todos" || token === "todas" || token === "all")) {
    return "all";
  }
  const aliases = exportScopeAliases();
  for (const scope of Object.keys(aliases) as Exclude<ExportScope, "all">[]) {
    if (aliases[scope].some((alias) => args.includes(alias))) return scope;
  }
  return "all";
}

async function buildExportPayload(admin: any, scope: ExportScope): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { generated_at: new Date().toISOString() };

  if (scope !== "calendar") {
    const { data, error } = await admin.database
      .from("planner_items")
      .select("list_key, text, done, important, created_at, updated_at")
      .order("created_at", { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as
      { list_key: ListKey; text: string; done: boolean; important: boolean; created_at: string; updated_at: string }[];
    for (const key of LIST_KEYS) {
      if (scope !== "all" && scope !== key) continue;
      payload[key] = rows
        .filter((row) => row.list_key === key)
        .map((row) => ({
          text: row.text,
          done: row.done,
          important: row.important,
          created_at: row.created_at,
          updated_at: row.updated_at
        }));
    }
  }

  if (scope === "all" || scope === "calendar") {
    payload.agenda = await buildAgendaExport();
  }

  return payload;
}

async function buildAgendaExport(): Promise<unknown[] | null> {
  const baseUrl = Deno.env.get("CALDAV_BASE_URL");
  const calendarPath = Deno.env.get("CALDAV_CALENDAR_PATH");
  if (!baseUrl || !calendarPath) return null;

  const now = new Date();
  const until = new Date(now.getTime() + calendarLookaheadDays() * 24 * 60 * 60 * 1000);
  try {
    const events = await queryCalendarEvents(
      baseUrl,
      calendarPath,
      Deno.env.get("CALDAV_USERNAME"),
      Deno.env.get("CALDAV_PASSWORD"),
      now,
      until
    );
    return events
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((event) => ({
        title: event.title,
        start: event.start,
        all_day: event.allDay,
        when: formatEventTime(new Date(event.start), event.allDay)
      }));
  } catch (error) {
    console.error(`telegram-webhook export_agenda_failed ${errorMessage(error)}`);
    return null;
  }
}

// A hand-rolled serializer, not a library import: every other CalDAV/JSON
// helper in this file is already self-contained (see the module header), and
// the export payload is only ever strings/booleans/timestamps/arrays/objects —
// too narrow a shape to justify a dependency. Every string scalar is always
// double-quoted, never left as YAML's bare-plain-scalar form: user-typed item
// text can contain ":", "#", quotes or start with a character that plain YAML
// would otherwise parse as syntax.
function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          return Object.entries(item as Record<string, unknown>)
            .map(([key, val], i) => yamlEntry(key, val, indent + 1, i === 0 ? `${pad}- ` : `${pad}  `))
            .join("");
        }
        return `${pad}- ${yamlScalar(item)}\n`;
      })
      .join("");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}\n`;
    return entries.map(([key, val]) => yamlEntry(key, val, indent, pad)).join("");
  }
  return `${pad}${yamlScalar(value)}\n`;
}

function yamlEntry(key: string, val: unknown, indent: number, prefix: string): string {
  if (val === null) return `${prefix}${key}: null\n`;
  if (typeof val === "object") {
    const isEmptyArray = Array.isArray(val) && val.length === 0;
    const isEmptyObj = !Array.isArray(val) && Object.keys(val as object).length === 0;
    if (isEmptyArray) return `${prefix}${key}: []\n`;
    if (isEmptyObj) return `${prefix}${key}: {}\n`;
    return `${prefix}${key}:\n${toYaml(val, indent + 1)}`;
  }
  return `${prefix}${key}: ${yamlScalar(val)}\n`;
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

// ---------------------------------------------------------------------------
// Daily digest (/resumo, /resumo_hora, and the hourly schedule tick)
//
// Once a day, at a locally-configured hour, this posts a Markdown message —
// meant to be pasted straight into a note-taking app — summarizing what was
// added to and finished on the three lists in the preceding 24 hours, then
// deletes the finished rows. From that point on the message is the only
// record; the table only ever holds what is still open.
//
// The schedule itself is a static hourly cron (see scripts/schedule-daily-
// digest.mjs) — InsForge schedules carry no timezone, so instead of trying to
// keep a cron expression in sync with a locally-configured hour, the tick
// fires every hour and this function decides whether *this* hour is the
// configured one. That also means /resumo_hora takes effect immediately, with
// no redeploy and no schedule edit.
// ---------------------------------------------------------------------------

const DEFAULT_DIGEST_HOUR = 22;
const DIGEST_HOUR_SETTING = "daily_digest_hour";
// ISO timestamp of the last successful close — the next window starts exactly
// here, not at a fixed "now - 24h", so one missed hourly tick (a platform
// hiccup, a transient DB error) never silently drops a slice of the day: the
// next successful tick's window just stretches back further to cover it.
const DIGEST_LAST_CLOSED_SETTING = "daily_digest_last_closed_at";
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIST_EMOJI: Record<ListKey, string> = { grocery: "🛒", todo: "📋", notes: "📝" };

// Shared by the digest, zonedNowContext() and formatEventTime() below, so the
// fallback lives in one place and can't drift between copies. Owners are
// expected to set DASHBOARD_TIMEZONE; this default matches kindle-dashboard-data.ts.
const DEFAULT_TIMEZONE = "America/Sao_Paulo";

function configuredTimezone(): string {
  return Deno.env.get("DASHBOARD_TIMEZONE") || DEFAULT_TIMEZONE;
}

function digestDateParts(date: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
}

function digestLocalHour(date: Date, timezone: string): number {
  return Number(digestDateParts(date, timezone).hour);
}

// en-CA formats as YYYY-MM-DD directly, which doubles as the dedupe key for
// "have we already closed out this local day".
function digestLocalDateKey(date: Date, timezone: string): string {
  const parts = digestDateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function digestLocalDateTime(date: Date, timezone: string): string {
  const parts = digestDateParts(date, timezone);
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

async function getBotSetting(admin: any, key: string): Promise<string | null> {
  const { data, error } = await admin.database.from("bot_settings").select("value").eq("key", key);
  if (error) throw error;
  const row = (data ?? [])[0] as { value?: string } | undefined;
  return row?.value ?? null;
}

async function setBotSetting(admin: any, key: string, value: string): Promise<void> {
  const { error } = await admin.database.from("bot_settings").upsert({ key, value });
  if (error) throw error;
}

async function getDigestHour(admin: any): Promise<number> {
  const raw = await getBotSetting(admin, DIGEST_HOUR_SETTING);
  const hour = raw !== null ? Number(raw) : NaN;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_DIGEST_HOUR;
}

// Start of the next window: right where the last successful close left off,
// falling back to a plain last-24h only for the very first run this bot ever
// does (no prior close recorded yet).
async function getDigestWindowStart(admin: any, now: Date): Promise<Date> {
  const lastClosedIso = await getBotSetting(admin, DIGEST_LAST_CLOSED_SETTING);
  if (lastClosedIso) {
    const parsed = new Date(lastClosedIso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(now.getTime() - DIGEST_WINDOW_MS);
}

function digestLockKey(dateKey: string): string {
  return `daily_digest_closed:${dateKey}`;
}

// Atomic "has today's automatic close already happened" claim. bot_settings.key
// is a primary key, so a genuine INSERT (never upsert) fails on a second
// concurrent attempt instead of silently overwriting it — the one guarantee a
// plain read-then-write check on an upsert-based flag cannot make if the
// hourly schedule ever fires twice for the same hour (a platform retry, an
// overlapping invocation). One tiny row accumulates per calendar day this ever
// runs; that is cheap enough to never need cleaning up.
async function claimDigestLock(admin: any, dateKey: string): Promise<boolean> {
  const { error } = await admin.database
    .from("bot_settings")
    .insert({ key: digestLockKey(dateKey), value: new Date().toISOString() });
  return !error;
}

type DigestRow = {
  id: string;
  list_key: ListKey;
  text: string;
  done: boolean;
  created_at: string;
  completed_at: string | null;
};

type DailyDigest = {
  markdown: string;
  completedIds: string[];
  addedCount: number;
  completedCount: number;
};

async function buildDailyDigest(admin: any, windowStart: Date, windowEnd: Date): Promise<DailyDigest> {
  const { data, error } = await admin.database
    .from("planner_items")
    .select("id, list_key, text, done, created_at, completed_at")
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as DigestRow[];
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();
  const within = (iso: string | null) => {
    if (!iso) return false;
    const ms = Date.parse(iso);
    return ms >= startMs && ms < endMs;
  };

  // An item added and finished inside the same window lands in both lists —
  // deliberately: "what did I add" and "what did I finish" are two separate
  // questions, not a partition of one list of items.
  const added = rows.filter((row) => within(row.created_at));
  const completed = rows.filter((row) => row.done && within(row.completed_at));

  const timezone = configuredTimezone();
  return {
    markdown: renderDigestMarkdown(windowStart, windowEnd, timezone, added, completed),
    completedIds: completed.map((row) => row.id),
    addedCount: added.length,
    completedCount: completed.length
  };
}

function renderDigestMarkdown(
  windowStart: Date,
  windowEnd: Date,
  timezone: string,
  added: DigestRow[],
  completed: DigestRow[]
): string {
  const [day] = digestLocalDateTime(windowEnd, timezone).split(" ");
  const lines: string[] = [
    `# 📆 Resumo do dia — ${day}`,
    "",
    `Janela: ${digestLocalDateTime(windowStart, timezone)} → ${digestLocalDateTime(windowEnd, timezone)}`,
    "",
    `## ✅ Concluído (${completed.length})`,
    ...(completed.length > 0
      ? completed.map((row) => `- [x] ${LIST_EMOJI[row.list_key]} ${row.text}`)
      : ["_(nada concluído nesta janela)_"]),
    "",
    `## ➕ Adicionado (${added.length})`,
    // Plain bullets, not checkboxes: an added item that is not also in the
    // Concluído section above is still open, and a bare "- " box would read
    // as a task left unchecked rather than as "this exists".
    ...(added.length > 0
      ? added.map((row) => `- ${LIST_EMOJI[row.list_key]} ${row.text}`)
      : ["_(nada adicionado nesta janela)_"])
  ];
  return lines.join("\n");
}

async function closeDailyDigest(admin: any, digest: DailyDigest, closedAt: Date): Promise<void> {
  if (digest.completedIds.length > 0) {
    const { error } = await admin.database.from("planner_items").delete().in("id", digest.completedIds);
    if (error) throw error;
  }
  await setBotSetting(admin, DIGEST_LAST_CLOSED_SETTING, closedAt.toISOString());
  // Upsert here too (claimDigestLock already inserted it for the automatic
  // path): a manual "/resumo fechar" never calls claimDigestLock, so this is
  // what stops the automatic tick from also closing the same day later.
  await setBotSetting(admin, digestLockKey(digestLocalDateKey(closedAt, configuredTimezone())), closedAt.toISOString());
}

// Telegram caps a message at 4096 chars. A personal three-list digest should
// never get close, but the alternative to chunking is silently dropping part
// of what is meant to be a permanent record — worse than an extra message.
const TELEGRAM_MESSAGE_SOFT_LIMIT = 3500;

function sendDigestMessageInBackground(chatId: string, markdown: string): void {
  for (const chunk of chunkMarkdown(markdown, TELEGRAM_MESSAGE_SOFT_LIMIT)) {
    sendTelegramMessageInBackground(chatId, chunk);
  }
}

function chunkMarkdown(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Entry point for the hourly schedule (see scripts/schedule-daily-digest.mjs).
// Authenticated by its own header/secret, never Telegram's: the schedule call
// carries neither Telegram's update shape nor its secret token, so it must be
// routed here before the Telegram-secret check would otherwise 401 it.
async function handleDigestTick(req: Request): Promise<Response> {
  const configuredToken = Deno.env.get("DAILY_DIGEST_TOKEN");
  const receivedToken = req.headers.get("x-daily-digest-token");
  if (!configuredToken || receivedToken !== configuredToken) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const chatId = Deno.env.get("TELEGRAM_ALLOWED_CHAT_ID");
  if (!chatId) {
    return jsonResponse({ ok: false, error: "TELEGRAM_ALLOWED_CHAT_ID not set" }, 500);
  }

  const admin = insforgeAdmin();

  const timezone = configuredTimezone();
  const now = new Date();
  const configuredHour = await getDigestHour(admin);
  const currentHour = digestLocalHour(now, timezone);
  if (currentHour !== configuredHour) {
    return jsonResponse({
      ok: true,
      skipped: "not_the_configured_hour",
      current_hour: currentHour,
      configured_hour: configuredHour
    });
  }

  // Atomic: if the schedule ever fires twice for the same hour (a platform
  // retry, an overlapping invocation), only the first claim wins — the second
  // sees the primary-key conflict and skips instead of sending a duplicate.
  const today = digestLocalDateKey(now, timezone);
  const claimed = await claimDigestLock(admin, today);
  if (!claimed) {
    return jsonResponse({ ok: true, skipped: "already_closed_today" });
  }

  try {
    const windowStart = await getDigestWindowStart(admin, now);
    const digest = await buildDailyDigest(admin, windowStart, now);
    sendDigestMessageInBackground(chatId, digest.markdown);
    await closeDailyDigest(admin, digest, now);
    return jsonResponse({ ok: true, sent: true, added: digest.addedCount, completed: digest.completedCount });
  } catch (error) {
    console.error(`telegram-webhook digest_tick_failed ${errorMessage(error)}`);
    return jsonResponse({ ok: false, error: "digest_failed" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Undo
//
// complete/delete/uncomplete match by substring, so hitting the wrong row is
// the single most likely failure. Without undo, fixing it means reconstructing
// what the bot did and typing the inverse command — which is exactly the moment
// a user gives up on a chat interface. The button makes that one tap.
// ---------------------------------------------------------------------------

const UNDO_TTL_MS = 24 * 60 * 60 * 1000;

function undoKeyboardMarkup(token: string | null): unknown {
  if (!token) return undefined;
  return { inline_keyboard: [[{ text: "↩️ Desfazer", callback_data: `u:${token}` }]] };
}

// One button per row keeps long item names readable; Telegram truncates a
// label that shares a row with others.
function choiceKeyboardMarkup(token: string, options: ChoiceOption[]): unknown {
  const rows = options.map((option, index) => [
    { text: truncateLabel(option.label), callback_data: `c:${token}:${index}` }
  ]);
  rows.push([{ text: "✖️ Cancelar", callback_data: `c:${token}:x` }]);
  return { inline_keyboard: rows };
}

function truncateLabel(label: string): string {
  return label.length <= 48 ? label : `${label.slice(0, 47)}…`;
}

async function sendChoice(
  admin: any,
  chatId: string,
  choice: PendingChoice,
  replyToMessageId?: number
): Promise<void> {
  const id = shortToken();
  const { error } = await admin.database
    .from("bot_actions")
    .insert([{ id, kind: "choice", payload: { prompt: choice.prompt, options: choice.options } }]);
  if (error) {
    console.error(`telegram-webhook choice_store_failed ${errorMessage(error)}`);
    sendTelegramMessageInBackground(chatId, choice.prompt, undefined, replyToMessageId);
    return;
  }
  sendTelegramMessageInBackground(chatId, choice.prompt, choiceKeyboardMarkup(id, choice.options), replyToMessageId);
}

// Telegram allows 64 bytes of callback_data; "u:" plus 16 hex characters is
// well inside that and still far too large to guess.
function shortToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function storeUndo(admin: any, ops: UndoOp[]): Promise<string | null> {
  if (ops.length === 0) return null;
  const id = shortToken();
  const { error } = await admin.database
    .from("bot_actions")
    .insert([{ id, kind: "undo", payload: { ops } }]);
  if (error) {
    // A missing undo button is a far better outcome than a failed action, so
    // this never propagates — the write itself already succeeded.
    console.error(`telegram-webhook undo_store_failed ${errorMessage(error)}`);
    return null;
  }
  pruneBotActionsInBackground(admin);
  return id;
}

function pruneBotActionsInBackground(admin: any): void {
  const cutoff = new Date(Date.now() - UNDO_TTL_MS).toISOString();
  admin.database
    .from("bot_actions")
    .delete()
    .lt("created_at", cutoff)
    .then(undefined, (error: unknown) => {
      console.error(`telegram-webhook prune_failed ${errorMessage(error)}`);
    });
}

async function handleCallbackQuery(
  callback: NonNullable<TelegramUpdate["callback_query"]>,
  chatId: string,
  started: number
): Promise<Response> {
  const callbackId = callback.id ?? "";
  const data = callback.data ?? "";
  const messageId = callback.message?.message_id;

  const choiceMatch = /^c:([0-9a-f]{16}):(\d+|x)$/.exec(data);
  if (choiceMatch) {
    return await handleChoiceCallback(choiceMatch[1], choiceMatch[2], callbackId, chatId, messageId, started);
  }

  const match = /^u:([0-9a-f]{16})$/.exec(data);
  if (!match) {
    await answerCallbackQuery(callbackId, "Botão não reconhecido.");
    return jsonResponse({ ok: true, ignored: true, reason: "unknown_callback" });
  }

  const admin = insforgeAdmin();

  const { data: rows, error } = await admin.database
    .from("bot_actions")
    .select("id, payload, created_at")
    .eq("id", match[1])
    .eq("kind", "undo");
  if (error) {
    console.error(`telegram-webhook undo_load_failed ${errorMessage(error)}`);
    await answerCallbackQuery(callbackId, "Não consegui desfazer agora.");
    return jsonResponse({ ok: true, applied: false, reason: "undo_load_failed" });
  }

  const record = (rows ?? [])[0] as { payload?: { ops?: UndoOp[] } } | undefined;
  if (!record) {
    // Already used, or pruned. Telegram replays a tap if the client retries,
    // so treating "gone" as success-shaped avoids a scary error on a no-op.
    await answerCallbackQuery(callbackId, "Essa ação já foi desfeita.");
    if (messageId) await editMessageReplyMarkup(chatId, messageId);
    return jsonResponse({ ok: true, applied: false, reason: "undo_expired" });
  }

  // Consume the token before replaying: a double tap must not restore twice.
  const { error: consumeError } = await admin.database.from("bot_actions").delete().eq("id", match[1]);
  if (consumeError) {
    console.error(`telegram-webhook undo_consume_failed ${errorMessage(consumeError)}`);
    await answerCallbackQuery(callbackId, "Não consegui desfazer agora.");
    return jsonResponse({ ok: true, applied: false, reason: "undo_consume_failed" });
  }

  try {
    await replayUndo(admin, record.payload?.ops ?? []);
  } catch (undoError) {
    console.error(`telegram-webhook undo_failed ${errorMessage(undoError)}`);
    await answerCallbackQuery(callbackId, "Não consegui desfazer agora.");
    return jsonResponse({ ok: true, applied: false, reason: "undo_failed" });
  }

  await answerCallbackQuery(callbackId, "Desfeito ✅");
  if (messageId) {
    const original = callback.message?.text ?? "";
    await editMessageText(chatId, messageId, `${original}\n\n↩️ Desfeito.`);
  }
  logTiming("telegram-webhook", { action: "undo", total_ms: elapsedMs(started) });
  return jsonResponse({ ok: true, applied: true, action: "undo" });
}

async function handleChoiceCallback(
  token: string,
  selection: string,
  callbackId: string,
  chatId: string,
  messageId: number | undefined,
  started: number
): Promise<Response> {
  const admin = insforgeAdmin();

  const { data: rows, error } = await admin.database
    .from("bot_actions")
    .select("id, payload")
    .eq("id", token)
    .eq("kind", "choice");
  if (error) {
    console.error(`telegram-webhook choice_load_failed ${errorMessage(error)}`);
    await answerCallbackQuery(callbackId, "Não consegui aplicar agora.");
    return jsonResponse({ ok: true, applied: false, reason: "choice_load_failed" });
  }

  const record = (rows ?? [])[0] as { payload?: PendingChoice } | undefined;
  if (!record?.payload) {
    await answerCallbackQuery(callbackId, "Essa pergunta já foi respondida.");
    if (messageId) await editMessageReplyMarkup(chatId, messageId);
    return jsonResponse({ ok: true, applied: false, reason: "choice_expired" });
  }

  // Resolved before the token is consumed, so a malformed callback cannot burn
  // a pending question and leave the user with a dead keyboard.
  const option = selection === "x" ? null : record.payload.options[Number(selection)];
  if (selection !== "x" && !option) {
    await answerCallbackQuery(callbackId, "Opção inválida.");
    return jsonResponse({ ok: true, applied: false, reason: "choice_invalid_option" });
  }

  // Consumed up front, exactly like undo: two taps must not apply twice.
  const { error: consumeError } = await admin.database.from("bot_actions").delete().eq("id", token);
  if (consumeError) {
    console.error(`telegram-webhook choice_consume_failed ${errorMessage(consumeError)}`);
    await answerCallbackQuery(callbackId, "Não consegui aplicar agora.");
    return jsonResponse({ ok: true, applied: false, reason: "choice_consume_failed" });
  }

  if (selection === "x" || !option) {
    await answerCallbackQuery(callbackId, "Ok, deixei como está.");
    if (messageId) await editMessageText(chatId, messageId, `${record.payload.prompt}\n\n✖️ Cancelado — nada foi alterado.`);
    return jsonResponse({ ok: true, applied: false, reason: "choice_cancelled" });
  }

  let applied: Applied;
  try {
    applied = await applyChoiceOp(admin, option.op);
  } catch (choiceError) {
    console.error(`telegram-webhook choice_failed ${errorMessage(choiceError)}`);
    await answerCallbackQuery(callbackId, "Não consegui aplicar agora.");
    return jsonResponse({ ok: true, applied: false, reason: "choice_failed" });
  }

  await answerCallbackQuery(callbackId, "Feito ✅");
  if (messageId) await editMessageReplyMarkup(chatId, messageId);
  // A fresh message rather than an edit: the result carries its own undo
  // button, and the user explicitly chose this, so it deserves the same
  // safety net as any other action.
  const undoToken = await storeUndo(admin, applied.undo);
  sendTelegramMessageInBackground(chatId, applied.summary, undoKeyboardMarkup(undoToken));
  logTiming("telegram-webhook", { action: "choice", total_ms: elapsedMs(started) });
  return jsonResponse({ ok: true, applied: true, action: "choice", summary: applied.summary });
}

async function applyChoiceOp(admin: any, op: ChoiceOp): Promise<Applied> {
  if (op.op === "set_done") {
    const ids = op.rows.map((row) => row.id);
    const { error } = await admin.database.from("planner_items").update(donePatch(op.done)).in("id", ids);
    if (error) throw error;
    const changed = op.rows.filter((row) => row.done !== op.done);
    const verb = op.done ? "✅ Concluí" : "↩️ Reabri";
    return {
      summary: `${verb}: ${joinItems(op.rows.map((row) => row.text))}.`,
      undo: changed.length > 0 ? [{ op: "set_done", ids: changed.map((row) => row.id), done: !op.done }] : []
    };
  }

  if (op.op === "set_important") {
    const ids = op.rows.map((row) => row.id);
    const { error } = await admin.database.from("planner_items").update({ important: op.important }).in("id", ids);
    if (error) throw error;
    const changed = op.rows.filter((row) => row.important !== op.important);
    const verb = op.important ? "⭐ Marquei como importante" : "Desmarquei importante";
    return {
      summary: `${verb}: ${joinItems(op.rows.map((row) => row.text))}.`,
      undo: changed.length > 0 ? [{ op: "set_important", ids: changed.map((row) => row.id), important: !op.important }] : []
    };
  }

  if (op.op === "set_text") {
    const ids = op.rows.map((row) => row.id);
    const { error } = await admin.database.from("planner_items").update({ text: op.new_text }).in("id", ids);
    if (error) throw error;
    return {
      summary: `✏️ Editei: ${joinItems(op.rows.map((row) => row.text))} → ${op.new_text}.`,
      undo: [{ op: "set_text", rows: op.rows.map((row) => ({ id: row.id, text: row.text })) }]
    };
  }

  if (op.op === "delete_items") {
    const { error } = await admin.database.from("planner_items").delete().in("id", op.rows.map((row) => row.id));
    if (error) throw error;
    return {
      summary: `🗑 Removi: ${joinItems(op.rows.map((row) => row.text))}.`,
      undo: [
        {
          op: "restore_items",
          rows: op.rows.map((row) => ({
            list_key: row.list_key,
            text: row.text,
            done: row.done,
            completed_at: row.completed_at,
            important: row.important
          }))
        }
      ]
    };
  }

  if (op.op === "move_items") {
    const ids = op.rows.map((row) => row.id);
    const { error } = await admin.database.from("planner_items").update({ list_key: op.list_key }).in("id", ids);
    if (error) throw error;
    // Undo is a move back, one op per source list so mixed selections survive.
    const undo: UndoOp[] = [];
    for (const key of LIST_KEYS) {
      const back = op.rows.filter((row) => row.list_key === key).map((row) => row.id);
      if (back.length > 0) undo.push({ op: "move_items", ids: back, list_key: key });
    }
    return {
      summary: `📦 Movi para ${LIST_LABELS[op.list_key]}: ${joinItems(op.rows.map((row) => row.text))}.`,
      undo
    };
  }

  const response = await fetch(op.url, {
    method: "DELETE",
    headers: caldavAuthHeaders(Deno.env.get("CALDAV_USERNAME"), Deno.env.get("CALDAV_PASSWORD")),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    console.error(`telegram-webhook choice_calendar_delete_${response.status}`);
    return { summary: MSG.calendarDeleteFailed, undo: [] };
  }
  return {
    summary: `🗑 Evento cancelado: ${op.title}`,
    undo: op.ics ? [{ op: "restore_event", url: op.url, ics: op.ics }] : []
  };
}

async function replayUndo(admin: any, ops: UndoOp[]): Promise<void> {
  for (const op of ops) {
    if (op.op === "delete_items") {
      const { error } = await admin.database.from("planner_items").delete().in("id", op.ids);
      if (error) throw error;
    } else if (op.op === "restore_items") {
      const { error } = await admin.database.from("planner_items").insert(op.rows);
      if (error) throw error;
    } else if (op.op === "set_done") {
      const { error } = await admin.database.from("planner_items").update(donePatch(op.done)).in("id", op.ids);
      if (error) throw error;
    } else if (op.op === "set_important") {
      const { error } = await admin.database.from("planner_items").update({ important: op.important }).in("id", op.ids);
      if (error) throw error;
    } else if (op.op === "set_text") {
      for (const row of op.rows) {
        const { error } = await admin.database.from("planner_items").update({ text: row.text }).eq("id", row.id);
        if (error) throw error;
      }
    } else if (op.op === "move_items") {
      const { error } = await admin.database.from("planner_items").update({ list_key: op.list_key }).in("id", op.ids);
      if (error) throw error;
    } else if (op.op === "delete_event") {
      await fetch(op.url, {
        method: "DELETE",
        headers: caldavAuthHeaders(Deno.env.get("CALDAV_USERNAME"), Deno.env.get("CALDAV_PASSWORD")),
        signal: AbortSignal.timeout(8000)
      });
    } else if (op.op === "restore_event") {
      await fetch(op.url, {
        method: "PUT",
        headers: {
          ...caldavAuthHeaders(Deno.env.get("CALDAV_USERNAME"), Deno.env.get("CALDAV_PASSWORD")),
          "Content-Type": "text/calendar; charset=utf-8"
        },
        body: op.ics,
        signal: AbortSignal.timeout(8000)
      });
    }
  }
}

// ---------------------------------------------------------------------------
// NLP parsing: fast heuristics -> LLM (OpenAI-compatible) -> deterministic fallback
// ---------------------------------------------------------------------------

// Why the result carries the LLM failure and not just null: "I could not parse
// this" and "the model is rate-limited until tomorrow" call for very different
// replies, and the free Gemini tier makes the second one a routine occurrence.
type LlmError = "quota" | "unavailable" | "network" | "bad_response" | "too_long";
type ParseOutcome = { actions: TelegramAction[]; llmError?: LlmError; transcript?: string; cached?: boolean };

type LlmConfig = { apiKey: string; baseUrl: string; model: string; reasoningEffort: string };

function llmConfig(): LlmConfig | null {
  const apiKey = Deno.env.get("LLM_API_KEY");
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (Deno.env.get("LLM_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, ""),
    model: Deno.env.get("LLM_MODEL") || "gemini-3.5-flash-lite",
    // Gemini 3.x thinks before answering by default, which costs 9-13s on a
    // classification this small. "low" answers the same thing in about 1s.
    reasoningEffort: Deno.env.get("LLM_REASONING_EFFORT") || "low"
  };
}

// A single flat schema for both action kinds. Unions are not reliably supported
// across OpenAI-compatible backends, so the unused half is filled with empty
// values and discarded by the validators. Every field is required because
// strict mode rejects a schema whose `required` omits a declared property.
const ACTION_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["planner", "calendar"] },
    action: {
      type: "string",
      enum: ["add", "complete", "uncomplete", "delete", "clear", "edit", "important", "unimportant", "create"]
    },
    list_key: { type: "string", enum: ["grocery", "todo", "notes", "none"] },
    items: { type: "array", items: { type: "string" } },
    // 1-based positions from the last /listas render (see orderForNumbering),
    // an alternative to items/title for addressing an existing row or event
    // without repeating its text.
    item_numbers: { type: "array", items: { type: "integer" } },
    new_text: { type: "string" },
    all_lists: { type: "boolean" },
    title: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    all_day: { type: "boolean" },
    location: { type: "string" },
    event_number: { type: "integer" }
  },
  required: [
    "kind", "action", "list_key", "items", "item_numbers", "new_text",
    "all_lists", "title", "start", "end", "all_day", "location", "event_number"
  ],
  additionalProperties: false
};

// A list, because one sentence routinely carries more than one request:
// "comprar leite e marca o café como feito" is an add and a complete. Asking
// for a single object forced the model to drop half of that silently.
const ACTION_JSON_SCHEMA = {
  name: "dashboard_actions",
  strict: true,
  schema: {
    type: "object",
    properties: { actions: { type: "array", items: ACTION_OBJECT_SCHEMA } },
    required: ["actions"],
    additionalProperties: false
  }
};

// Accepts the array shape, a single bare action, and the kind-nested shape a
// model may still produce if it ignores the schema.
function validateTelegramActions(input: unknown): TelegramAction[] {
  if (input && typeof input === "object" && Array.isArray((input as { actions?: unknown }).actions)) {
    return ((input as { actions: unknown[] }).actions)
      .map((candidate) => validateTelegramAction(candidate))
      .filter((action): action is TelegramAction => action !== null);
  }
  const single = validateTelegramAction(unwrapAction(input));
  return single ? [single] : [];
}

async function parseTelegramMessage(message: string, admin?: any): Promise<ParseOutcome> {
  const fastAction = parseFastHeuristicMessage(message);
  if (fastAction) return { actions: [fastAction] };

  const config = llmConfig();
  if (!config) return { actions: [parseMessageHeuristically(message)] };

  const cached = admin ? await readParseCache(admin, message) : null;
  if (cached) return { actions: cached, cached: true };

  const result = await callLlm(config, buildSystemPrompt(), message);
  if ("error" in result) {
    // The heuristics still cover the common explicit phrasings, so try them
    // before giving up — but keep the LLM error so the reply can explain a
    // quota wall instead of pretending the message was gibberish.
    const heuristic = parseCalendarHeuristically(message) ?? parseFastHeuristicMessage(message);
    return heuristic ? { actions: [heuristic] } : { actions: [], llmError: result.error };
  }

  const actions = validateTelegramActions(result.value);
  if (actions.length > 0 && admin) writeParseCache(admin, message, actions);
  return { actions: actions.length > 0 ? actions : [parseMessageHeuristically(message)] };
}

// ---------------------------------------------------------------------------
// Parse cache
//
// The free Gemini tier meters requests, not tokens, so a repeat of "comprar
// leite" is a whole unit of daily quota spent on an answer already known.
// ---------------------------------------------------------------------------

const PARSE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Whitespace and case are the only normalization applied: "leite" and "Leite"
// should share an entry, but punctuation can carry meaning in an item name.
function parseCacheKey(message: string): string {
  return hashText(message.trim().replace(/\s+/g, " ").toLowerCase());
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// A calendar action is resolved against "now" — caching "reunião amanhã às 14h"
// would schedule today's meeting on yesterday's date tomorrow. Planner actions
// carry no time reference at all, so only those are memoized; one calendar
// action in the batch disqualifies the whole message.
function isCacheable(actions: TelegramAction[]): boolean {
  return actions.length > 0 && actions.every((action) => !isCalendarAction(action));
}

async function readParseCache(admin: any, message: string): Promise<TelegramAction[] | null> {
  const key = parseCacheKey(message);
  try {
    const { data, error } = await admin.database
      .from("bot_parse_cache")
      .select("action, hits, created_at")
      .eq("message_hash", key);
    if (error) throw error;
    const row = (data ?? [])[0] as { action?: unknown; hits?: number; created_at?: string } | undefined;
    if (!row?.action) return null;
    if (row.created_at && Date.now() - Date.parse(row.created_at) > PARSE_CACHE_TTL_MS) return null;

    const actions = validateTelegramActions(row.action);
    if (actions.length === 0) return null;

    admin.database
      .from("bot_parse_cache")
      .update({ hits: (row.hits ?? 0) + 1, last_used_at: new Date().toISOString() })
      .eq("message_hash", key)
      .then(undefined, () => {});
    return actions;
  } catch (error) {
    // A cache that misbehaves must never cost the user their message.
    console.error(`telegram-webhook parse_cache_read_failed ${errorMessage(error)}`);
    return null;
  }
}

function writeParseCache(admin: any, message: string, actions: TelegramAction[]): void {
  if (!isCacheable(actions)) return;
  admin.database
    .from("bot_parse_cache")
    .upsert({
      message_hash: parseCacheKey(message),
      action: { actions },
      hits: 0,
      last_used_at: new Date().toISOString()
    })
    .then(undefined, (error: unknown) => {
      console.error(`telegram-webhook parse_cache_write_failed ${errorMessage(error)}`);
    });
}

type LlmResult = { value: unknown } | { error: LlmError };

async function callLlm(config: LlmConfig, systemPrompt: string, message: string): Promise<LlmResult> {
  // One retry, and only for 503: that status means "the model is busy right
  // now" and clears in milliseconds, while 429 on the free tier is a daily cap
  // that retrying only burns further.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message }
          ],
          response_format: { type: "json_schema", json_schema: ACTION_JSON_SCHEMA },
          reasoning_effort: config.reasoningEffort,
          temperature: 0
        }),
        signal: AbortSignal.timeout(12000)
      });
    } catch (error) {
      console.error(`telegram-webhook llm_network_error ${errorMessage(error)}`);
      return { error: "network" };
    }

    if (response.status === 429) {
      console.error("telegram-webhook llm_quota_exhausted");
      return { error: "quota" };
    }

    if (response.status === 503 && attempt === 0) {
      await sleep(400);
      continue;
    }

    if (!response.ok) {
      console.error(`telegram-webhook llm_http_${response.status} ${(await response.text()).slice(0, 200)}`);
      return { error: response.status === 503 ? "unavailable" : "bad_response" };
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { error: "bad_response" };

    try {
      return { value: unwrapAction(JSON.parse(content)) };
    } catch {
      return { error: "bad_response" };
    }
  }

  return { error: "unavailable" };
}

// ---------------------------------------------------------------------------
// Voice notes
//
// Dictating "leite, pão e ovos" while walking through a shop is the reason a
// list bot lives on a phone at all. Transcription and parsing happen in ONE
// model call — splitting them would double the quota cost for no gain, since
// the model that hears the audio can emit the action directly.
//
// This path does NOT go through the OpenAI compatibility layer: that layer
// only accepts input_audio formats [wav, mp3], and Telegram voice notes are
// OGG/Opus. The native endpoint takes audio/ogg as inline_data, so the audio
// path talks to Gemini directly and text keeps using the portable layer.
// ---------------------------------------------------------------------------

const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const MAX_VOICE_SECONDS = 300;

// Derived rather than configured separately, so a working text setup implies a
// working audio setup: ".../v1beta/openai" -> ".../v1beta". Explicitly
// overridable, and null for any provider that is not Gemini-shaped — voice
// then reports itself unavailable instead of failing in a confusing way.
function geminiNativeBaseUrl(): string | null {
  const override = Deno.env.get("LLM_AUDIO_BASE_URL");
  if (override) return override.replace(/\/$/, "");
  const base = (Deno.env.get("LLM_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
  if (!/generativelanguage\.googleapis\.com/.test(base)) return null;
  return base.replace(/\/openai$/, "");
}

function thinkingLevelFor(effort: string): string {
  return effort.toUpperCase() === "NONE" ? "LOW" : effort.toUpperCase();
}

async function parseVoiceMessage(audio: TelegramAudio): Promise<ParseOutcome> {
  const config = llmConfig();
  const nativeBase = geminiNativeBaseUrl();
  if (!config || !nativeBase) return { actions: [], llmError: "unavailable" };

  if ((audio.duration ?? 0) > MAX_VOICE_SECONDS || (audio.file_size ?? 0) > MAX_VOICE_BYTES) {
    return { actions: [], llmError: "too_long" };
  }

  const file = await downloadTelegramFile(audio.file_id ?? "");
  if (!file) return { actions: [], llmError: "network" };

  const body = {
    systemInstruction: { parts: [{ text: buildVoiceSystemPrompt() }] },
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: audio.mime_type || "audio/ogg", data: toBase64(file) } }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: voiceResponseSchema(),
      thinkingConfig: { thinkingLevel: thinkingLevelFor(config.reasoningEffort) }
    }
  };

  let response: Response;
  try {
    response = await fetch(`${nativeBase}/models/${config.model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000)
    });
  } catch (error) {
    console.error(`telegram-webhook voice_network_error ${errorMessage(error)}`);
    return { actions: [], llmError: "network" };
  }

  if (response.status === 429) return { actions: [], llmError: "quota" };
  if (!response.ok) {
    console.error(`telegram-webhook voice_http_${response.status} ${(await response.text()).slice(0, 200)}`);
    return { actions: [], llmError: response.status === 503 ? "unavailable" : "bad_response" };
  }

  const payload = await response.json();
  const content = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content !== "string") return { actions: [], llmError: "bad_response" };

  try {
    const parsed = JSON.parse(content);
    const transcript = typeof parsed?.transcript === "string" ? parsed.transcript.trim() : undefined;
    return { actions: validateTelegramActions(parsed), transcript };
  } catch {
    return { actions: [], llmError: "bad_response" };
  }
}

function buildVoiceSystemPrompt(): string {
  return [
    "The user sent a voice note in Brazilian Portuguese.",
    "First transcribe it verbatim into the \"transcript\" field, keeping the user's own words and accents.",
    "Then parse that transcript into dashboard actions using the \"actions\" array.",
    buildSystemPrompt()
  ].join(" ");
}

// The text schema plus a transcript, so the reply can show what was heard —
// without that, a misheard word turns into a mystery item on the list.
function voiceResponseSchema(): unknown {
  return {
    type: "object",
    properties: {
      transcript: { type: "string" },
      actions: { type: "array", items: ACTION_OBJECT_SCHEMA }
    },
    required: ["transcript", "actions"]
  };
}

async function downloadTelegramFile(fileId: string): Promise<Uint8Array | null> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token || !fileId) return null;
  try {
    const infoResponse = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(8000)
    });
    if (!infoResponse.ok) return null;
    const filePath = (await infoResponse.json())?.result?.file_path;
    if (typeof filePath !== "string") return null;

    const fileResponse = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      signal: AbortSignal.timeout(20000)
    });
    if (!fileResponse.ok) return null;
    const bytes = new Uint8Array(await fileResponse.arrayBuffer());
    return bytes.byteLength > MAX_VOICE_BYTES ? null : bytes;
  } catch (error) {
    console.error(`telegram-webhook telegram_file_error ${errorMessage(error)}`);
    return null;
  }
}

// Chunked because String.fromCharCode(...bytes) blows the argument limit well
// before a voice note's size — a few hundred KB is already enough to throw.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// Models asked for "one of these two shapes" in prose often answer with both
// shapes nested under their kind ({"planner":{...},"calendar":{...}}) instead of
// the flat object. The JSON schema above prevents that, but a model or backend
// that ignores the schema would otherwise have every answer silently thrown
// away, so flatten that shape rather than discard it.
function unwrapAction(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || "action" in parsed) return parsed;
  for (const kind of ["planner", "calendar"] as const) {
    const nested = (parsed as Record<string, unknown>)[kind];
    if (nested && typeof nested === "object" && "action" in nested && (nested as { action?: unknown }).action) {
      return { kind, ...(nested as Record<string, unknown>) };
    }
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemPrompt(): string {
  const { isoNow, timezone } = zonedNowContext();
  return [
    `Parse one Telegram dashboard message into strict JSON. Today's date/time is ${isoNow} in timezone ${timezone} — that string's own UTC offset is the user's local offset.`,
    "The user writes in Brazilian Portuguese. Keep every item title and event title in the user's own words and language; never translate, never rewrite into English.",
    "For grocery/todo/notes list updates return kind \"planner\" with action add|complete|uncomplete|delete|clear|edit|important|unimportant and list_key grocery|todo|notes. Use \"todo\" for chores/tasks/errands (\"preciso passar na farmacia\", \"ligar pro dentista\"), \"grocery\" for shopping/market items (\"comprar leite\"), and \"notes\" for a freeform note or piece of information that is neither an actionable task nor a shopping item (\"anota que a senha do wifi e casa123\"). Use action \"complete\" for past-tense phrasings that report something already done (\"ja comprei o cafe\", \"feito\"). Use items:[] only for clear.",
    "/listas numbers every row per list, e.g. \"3. comprar leite\" or \"!6. cortar cabelo\" (the \"!\" only marks it important, it is not part of the number). When the user names an item by that number instead of its text (\"conclua a tarefa 3\", \"exclua o item 2 da lista de compras\", \"item 4\"), put the number(s) in item_numbers instead of guessing text for items — item_numbers is always relative to the one list_key you set, never across lists, so all_lists must stay false whenever item_numbers is used. Use action \"edit\" with new_text set to the replacement text for requests to rename/change an item's text (\"mude o texto do item 3 para leite integral\", \"a nota 2 agora e outra coisa: X\"), addressing the target the same way (items or item_numbers). Use action \"important\"/\"unimportant\" to set or clear the \"!\" flag on an EXISTING item (\"marca a tarefa 6 como importante\", \"tira a importancia do item 2\") — never for a brand-new item: an add that also asks for importance is two actions, one add and one important, the second one addressing the item by its text since it has no number yet.",
    calendarPromptInstructions(),
    "Return one entry in \"actions\" per distinct request in the message. Usually that is exactly one entry: several items of the same kind going to the same list stay in a single entry's items array (\"comprar leite e pao\" is ONE add with two items). Split only when the message genuinely asks for different things (\"comprar leite e marca o cafe como feito\" is an add AND a complete).",
    "Fill the fields that do not apply to the chosen kind with empty values: list_key \"none\", items [], item_numbers [], new_text \"\", title/start/end/location \"\", all_day and all_lists false, event_number 0. Never invent fields."
  ].join(" ");
}

// Shared between the general classifier prompt above and the calendar-only
// prompt used when the user already picked "Agenda" from the menu keyboard —
// in that path the kind is already known, only title/start/end/location need
// extracting from free text.
function calendarPromptInstructions(): string {
  return "For calendar/agenda updates return kind \"calendar\" with action create|delete, a short title, ISO 8601 start/end, all_day and an optional location. Use \"create\" when the user wants to schedule/add/book a meeting or event. Resolve relative dates/times (\"amanha as 14h\", \"segunda que vem\", \"daqui a 3 horas\") against today's date/time above and always return start/end as absolute ISO 8601 timestamps using that SAME UTC offset (the user's local time, not UTC/Z, unless the timezone above genuinely is UTC). Default the end to one hour after the start when the user gives no duration. Use \"delete\" when the user wants to cancel/remove an event. The agenda block in /listas numbers each upcoming event (\"1. 14:00 — Reuniao\"); when the user names the event by that number (\"cancela o evento 1\"), set event_number to it and leave title empty. Otherwise leave event_number at 0 and put a search phrase in title as before.";
}

function buildCalendarOnlySystemPrompt(): string {
  const { isoNow, timezone } = zonedNowContext();
  return [
    `Parse one message into a strict JSON calendar action. Today's date/time is ${isoNow} in timezone ${timezone} — that string's own UTC offset is the user's local offset.`,
    "The user writes in Brazilian Portuguese. Keep the event title in the user's own words and language; never translate it.",
    calendarPromptInstructions(),
    "Set kind to \"calendar\", list_key to \"none\", items to [], item_numbers to [], new_text to \"\" and all_lists to false. Return exactly one entry in \"actions\"."
  ].join(" ");
}

// Renders "now" as an ISO 8601 string carrying DASHBOARD_TIMEZONE's actual UTC
// offset (e.g. "2026-09-11T18:00:00-03:00"), instead of Date#toISOString()'s
// always-UTC "Z". Without this, the LLM has no way to know what offset the
// user's "tomorrow at 3pm" is stated in, and silently defaults to treating
// bare times as UTC — three hours off for America/Sao_Paulo.
function zonedNowContext(): { isoNow: string; timezone: string } {
  const timezone = configuredTimezone();
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "shortOffset"
    }).formatToParts(now).map((part) => [part.type, part.value])
  );
  const offsetMatch = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(parts.timeZoneName ?? "");
  const sign = offsetMatch?.[1] ?? "+";
  const hours = (offsetMatch?.[2] ?? "0").padStart(2, "0");
  const minutes = offsetMatch?.[3] ?? "00";
  const isoNow = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hours}:${minutes}`;
  return { isoNow, timezone };
}

// Used only for the "Agenda" menu category: the kind is already known (the
// user picked it from the keyboard), so this skips the general classifier and
// asks the LLM to extract only title/start/end/location. Falls back to the
// same delete-only heuristic used by the general parser when no LLM_API_KEY
// is configured — free-text create still needs an LLM to resolve dates.
async function parseCalendarMessage(message: string): Promise<ParseOutcome> {
  const config = llmConfig();
  if (!config) {
    const heuristic = parseCalendarHeuristically(message);
    return { actions: heuristic ? [heuristic] : [] };
  }

  const result = await callLlm(config, buildCalendarOnlySystemPrompt(), message);
  if ("error" in result) {
    const heuristic = parseCalendarHeuristically(message);
    return heuristic ? { actions: [heuristic] } : { actions: [], llmError: result.error };
  }

  // The calendar-only prompt still answers with the shared flat schema, so the
  // model can hand back a planner object if it misreads the message. Forcing
  // the kind here keeps the menu category authoritative over the model.
  const raw = result.value && typeof result.value === "object" && Array.isArray((result.value as { actions?: unknown }).actions)
    ? (result.value as { actions: unknown[] }).actions[0]
    : result.value;
  const candidate = raw && typeof raw === "object"
    ? { ...(raw as Record<string, unknown>), kind: "calendar" }
    : raw;
  const action = validateCalendarAction(candidate);
  return { actions: action ? [action] : [] };
}

// Used for the "Tarefa"/"Nota"/"Compras" menu categories: the list_key is
// already known from which button was tapped, so there is nothing left to
// classify — just split the reply into one or more items.
function buildPlannerAddAction(listKey: ListKey, text: string): PlannerAction {
  const items = text
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    kind: "planner",
    action: "add",
    list_key: listKey,
    items: items.length > 0 ? items : [text],
    all_lists: false
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Every applied action reports what it did AND how to take it back. The undo
// list is a list rather than a single op on purpose: one message can already
// touch several rows, and a multi-action message touches several lists.
type UndoOp =
  | { op: "delete_items"; ids: string[] }
  | { op: "restore_items"; rows: { list_key: ListKey; text: string; done: boolean; completed_at: string | null; important: boolean }[] }
  | { op: "set_done"; ids: string[]; done: boolean }
  | { op: "set_important"; ids: string[]; important: boolean }
  | { op: "set_text"; rows: { id: string; text: string }[] }
  | { op: "move_items"; ids: string[]; list_key: ListKey }
  | { op: "delete_event"; url: string }
  | { op: "restore_event"; url: string; ics: string };

// A question the bot could not answer on its own, to be resolved by a tap.
// Raised instead of guessing — the alternative is applying a destructive action
// to every row a substring happened to match.
type ChoiceOp =
  | { op: "set_done"; rows: StoredRow[]; done: boolean }
  | { op: "set_important"; rows: StoredRow[]; important: boolean }
  | { op: "set_text"; rows: StoredRow[]; new_text: string }
  | { op: "delete_items"; rows: StoredRow[] }
  | { op: "move_items"; rows: StoredRow[]; list_key: ListKey }
  | { op: "delete_event"; url: string; ics: string; title: string };

type StoredRow = { id: string; text: string; list_key: ListKey; done: boolean; completed_at: string | null; important: boolean };
type ChoiceOption = { label: string; op: ChoiceOp };
type PendingChoice = { prompt: string; options: ChoiceOption[] };

type Applied = { summary: string; undo: UndoOp[]; choices?: PendingChoice[] };

async function applyTelegramAction(admin: any, action: TelegramAction): Promise<Applied> {
  if (isCalendarAction(action)) return applyCalendarAction(action);
  return applyPlannerAction(admin, action);
}

type PlannerRow = { id: string; text: string; list_key?: ListKey; done?: boolean; completed_at?: string | null; important?: boolean };

// complete/uncomplete/delete all match by substring, so a typo silently affects
// nothing. Resolving the matches first (instead of firing a blind UPDATE and
// reporting the requested words back as if they had landed) is what lets the
// reply distinguish "done" from "I found nothing called that".
async function findMatchingItems(admin: any, action: PlannerAction, needle: string): Promise<PlannerRow[]> {
  let query = admin.database
    .from("planner_items")
    // list_key, done, completed_at and important come along because an undo of
    // a delete has to put the row back exactly as it was, not just its text.
    .select("id, text, list_key, done, completed_at, important")
    .ilike("text", `%${escapeLikePattern(needle)}%`);
  if (!action.all_lists) {
    query = query.eq("list_key", action.list_key);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as PlannerRow[];
}

// "50%" or "peça_x" as an item name would otherwise turn into ILIKE wildcards
// and match half the list.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

type ActionTarget = { label: string; matches: PlannerRow[] };

// Builds one target per requested item, number-addressed targets always
// resolving to 0 or 1 match (see findItemsByNumbers) and text-addressed ones
// falling back to the existing substring search, ambiguity and all.
async function resolveActionTargets(admin: any, action: PlannerAction): Promise<ActionTarget[]> {
  if (action.item_numbers && action.item_numbers.length > 0) {
    const byNumber = await findItemsByNumbers(admin, action.list_key, action.item_numbers);
    return action.item_numbers.map((n) => ({
      label: `item ${n}`,
      matches: byNumber.has(n) ? [byNumber.get(n)!] : []
    }));
  }
  const targets: ActionTarget[] = [];
  for (const item of action.items) {
    targets.push({ label: item, matches: await findMatchingItems(admin, action, item) });
  }
  return targets;
}

// Numbers are 1-based positions in the same order /listas renders a list's
// items in (see orderForNumbering) — always re-derived live from the current
// rows, so a stale render can only go wrong the same way a stale text needle
// already can.
async function findItemsByNumbers(admin: any, listKey: ListKey, numbers: number[]): Promise<Map<number, PlannerRow>> {
  const { data, error } = await admin.database
    .from("planner_items")
    .select("id, text, list_key, done, completed_at, important, created_at")
    .eq("list_key", listKey)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const ordered = orderForNumbering((data ?? []) as (PlannerRow & { created_at: string })[]);
  const map = new Map<number, PlannerRow>();
  for (const n of numbers) {
    const row = ordered[n - 1];
    if (row) map.set(n, row);
  }
  return map;
}

async function applyPlannerAction(admin: any, action: PlannerAction): Promise<Applied> {
  const label = LIST_LABELS[action.list_key];

  if (action.action === "clear") {
    const { data, error } = await admin.database
      .from("planner_items")
      .select("id, text, list_key, done, completed_at, important")
      .eq("list_key", action.list_key);
    if (error) throw error;
    const rows = (data ?? []) as PlannerRow[];
    if (rows.length === 0) return { summary: `🧹 A lista ${label} já estava vazia.`, undo: [] };

    const { error: deleteError } = await admin.database
      .from("planner_items")
      .delete()
      .eq("list_key", action.list_key);
    if (deleteError) throw deleteError;
    return {
      summary: `🧹 Limpei ${label} (${rows.length} ${rows.length === 1 ? "item" : "itens"}).`,
      undo: [{ op: "restore_items", rows: rows.map(toRestorableRow) }]
    };
  }

  if (action.action === "add") {
    const rows = action.items.map((text) => ({ list_key: action.list_key, text, done: false }));
    // select() returns the generated ids, which is the only way an undo can
    // delete exactly the rows this message created and not a same-named row
    // that was already there.
    const { data, error } = await admin.database.from("planner_items").insert(rows).select("id, text");
    if (error) throw error;
    const inserted = (data ?? []) as { id: string; text: string }[];
    const ids = inserted.map((row) => row.id);
    return {
      summary: action.items.length === 1
        ? `✅ Anotei em ${label}: ${action.items[0]}.`
        : `✅ Anotei ${action.items.length} itens em ${label}: ${joinItems(action.items)}.`,
      undo: ids.length > 0 ? [{ op: "delete_items", ids }] : [],
      // The item is inserted first and offered for relocation after, rather
      // than held back pending an answer: a guess that lands in the wrong list
      // is recoverable, a note that vanished while waiting for a tap is not.
      choices: action.guessed_list && inserted.length > 0
        ? [buildDestinationChoice(action.list_key, inserted)]
        : []
    };
  }

  // Every remaining action addresses existing rows, either by number
  // (item_numbers — resolveActionTargets guarantees 0 or 1 match each) or by
  // free-text needle (items, which may match several and prompt a choice).
  const targets = await resolveActionTargets(admin, action);

  const hits: string[] = [];
  const misses: string[] = [];
  const undo: UndoOp[] = [];
  const choices: PendingChoice[] = [];
  // With all_lists the search ignored list_key, so naming one list in the reply
  // would misreport where the change actually landed.
  const scope = action.all_lists ? "todas as listas" : label;

  if (action.action === "complete" || action.action === "uncomplete") {
    const done = action.action === "complete";
    for (const { label: targetLabel, matches } of targets) {
      if (matches.length === 0) {
        misses.push(targetLabel);
        continue;
      }
      // "ja comprei o pao" against a list holding both "pão" and "pão de forma"
      // used to mark BOTH. Ask instead: a wrong guess here is invisible until
      // the user is standing in the shop wondering what happened.
      if (matches.length > 1) {
        choices.push(buildRowChoice(targetLabel, matches, done ? "complete" : "uncomplete"));
        continue;
      }
      const changed = matches.filter((row) => row.done !== done);
      const { error } = await admin.database
        .from("planner_items")
        .update(donePatch(done))
        .in("id", matches.map((row) => row.id));
      if (error) throw error;
      // Only rows that actually change are worth reverting: an item already
      // marked done should stay done if the user undoes this message.
      if (changed.length > 0) undo.push({ op: "set_done", ids: changed.map((row) => row.id), done: !done });
      hits.push(...matches.map((row) => row.text));
    }
    const verb = done ? "✅ Concluí" : "↩️ Reabri";
    return { summary: summarizeMatches(`${verb} em ${scope}`, hits, misses, scope), undo, choices };
  }

  if (action.action === "important" || action.action === "unimportant") {
    const important = action.action === "important";
    for (const { label: targetLabel, matches } of targets) {
      if (matches.length === 0) {
        misses.push(targetLabel);
        continue;
      }
      if (matches.length > 1) {
        choices.push(buildRowChoice(targetLabel, matches, important ? "important" : "unimportant"));
        continue;
      }
      const changed = matches.filter((row) => Boolean(row.important) !== important);
      const { error } = await admin.database
        .from("planner_items")
        .update({ important })
        .in("id", matches.map((row) => row.id));
      if (error) throw error;
      if (changed.length > 0) {
        undo.push({ op: "set_important", ids: changed.map((row) => row.id), important: !important });
      }
      hits.push(...matches.map((row) => row.text));
    }
    const verb = important ? "⭐ Marquei como importante" : "Desmarquei importante";
    return { summary: summarizeMatches(`${verb} em ${scope}`, hits, misses, scope), undo, choices };
  }

  if (action.action === "edit") {
    const newText = (action.new_text ?? "").trim();
    if (!newText) return { summary: "🤔 Não entendi qual seria o novo texto do item.", undo: [] };
    for (const { label: targetLabel, matches } of targets) {
      if (matches.length === 0) {
        misses.push(targetLabel);
        continue;
      }
      if (matches.length > 1) {
        choices.push(buildRowChoice(targetLabel, matches, "edit", newText));
        continue;
      }
      const row = matches[0];
      const { error } = await admin.database.from("planner_items").update({ text: newText }).eq("id", row.id);
      if (error) throw error;
      undo.push({ op: "set_text", rows: [{ id: row.id, text: row.text }] });
      hits.push(`${row.text} → ${newText}`);
    }
    return { summary: summarizeMatches(`✏️ Editei em ${scope}`, hits, misses, scope), undo, choices };
  }

  // delete
  for (const { label: targetLabel, matches } of targets) {
    if (matches.length === 0) {
      misses.push(targetLabel);
      continue;
    }
    if (matches.length > 1) {
      choices.push(buildRowChoice(targetLabel, matches, "delete"));
      continue;
    }
    const { error } = await admin.database
      .from("planner_items")
      .delete()
      .in("id", matches.map((row) => row.id));
    if (error) throw error;
    undo.push({ op: "restore_items", rows: matches.map(toRestorableRow) });
    hits.push(...matches.map((row) => row.text));
  }

  return { summary: summarizeMatches(`🗑 Removi de ${scope}`, hits, misses, scope), undo, choices };
}

// Offered when the destination was a default rather than a reading of the
// message — the case that historically produced items filed under the wrong
// list with no sign anything had been guessed.
function buildDestinationChoice(current: ListKey, inserted: { id: string; text: string }[]): PendingChoice {
  const rows: StoredRow[] = inserted.map((row) => ({
    id: row.id,
    text: row.text,
    list_key: current,
    done: false,
    completed_at: null,
    important: false
  }));
  const options: ChoiceOption[] = LIST_KEYS
    .filter((key) => key !== current)
    .map((key) => ({ label: `➡️ ${LIST_LABELS[key]}`, op: { op: "move_items", rows, list_key: key } }));
  return {
    prompt: `Coloquei em ${LIST_LABELS[current]} porque a mensagem não disse a lista. Quer mover?`,
    options
  };
}

const MAX_CHOICE_OPTIONS = 6;

function buildRowChoice(
  needle: string,
  matches: PlannerRow[],
  kind: "complete" | "uncomplete" | "delete" | "important" | "unimportant" | "edit",
  newText?: string
): PendingChoice {
  const rows = matches.map(toStoredRow);
  const shown = rows.slice(0, MAX_CHOICE_OPTIONS);
  const verb =
    kind === "delete" ? "remover"
    : kind === "complete" ? "concluir"
    : kind === "uncomplete" ? "reabrir"
    : kind === "important" ? "marcar como importante"
    : kind === "unimportant" ? "desmarcar como importante"
    : "editar";
  const opFor = (selected: StoredRow[]): ChoiceOp =>
    kind === "delete" ? { op: "delete_items", rows: selected }
    : kind === "important" ? { op: "set_important", rows: selected, important: true }
    : kind === "unimportant" ? { op: "set_important", rows: selected, important: false }
    : kind === "edit" ? { op: "set_text", rows: selected, new_text: newText ?? "" }
    : { op: "set_done", rows: selected, done: kind === "complete" };

  // The list prefix only earns its space when the matches actually span lists,
  // which happens on an all_lists search.
  const spansLists = new Set(rows.map((row) => row.list_key)).size > 1;
  const options: ChoiceOption[] = shown.map((row) => ({
    label: spansLists ? `${LIST_LABELS[row.list_key]} · ${row.text}` : row.text,
    op: opFor([row])
  }));
  // "Todos" stays available because sometimes the sweep really is what the
  // user meant — it just should not be the silent default.
  options.push({ label: `⚡ Todos (${rows.length})`, op: opFor(rows) });

  const list = shown.map((row) => `• ${row.text}`).join("\n");
  const more = rows.length > shown.length ? `\n… e mais ${rows.length - shown.length}` : "";
  return {
    prompt: `🤔 “${needle}” casou com ${rows.length} itens. Qual eu devo ${verb}?\n${list}${more}`,
    options
  };
}

function toStoredRow(row: PlannerRow): StoredRow {
  return {
    id: row.id,
    text: row.text,
    list_key: (row.list_key ?? "todo") as ListKey,
    done: Boolean(row.done),
    completed_at: row.completed_at ?? null,
    important: Boolean(row.important)
  };
}

function toRestorableRow(row: PlannerRow): { list_key: ListKey; text: string; done: boolean; completed_at: string | null; important: boolean } {
  return {
    list_key: (row.list_key ?? "todo") as ListKey,
    text: row.text,
    done: Boolean(row.done),
    completed_at: row.completed_at ?? null,
    important: Boolean(row.important)
  };
}

// completed_at is the digest's only way to tell "finished today" apart from
// "edited today" (the shared updated_at trigger fires on a plain list move
// too) — so every write that flips `done` must flip this alongside it, never
// `done` alone.
function donePatch(done: boolean): { done: boolean; completed_at: string | null } {
  return { done, completed_at: done ? new Date().toISOString() : null };
}

function summarizeMatches(headline: string, hits: string[], misses: string[], label: string): string {
  const lines: string[] = [];
  if (hits.length > 0) lines.push(`${headline}: ${joinItems(hits)}.`);
  if (misses.length > 0) {
    lines.push(
      misses.length === 1
        ? `🤔 Não achei “${misses[0]}” em ${label}.`
        : `🤔 Não achei em ${label}: ${joinItems(misses.map((item) => `“${item}”`))}.`
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Calendar (CalDAV) — hand-rolled client, duplicated from kindle-dashboard-data.ts
// (InsForge deploys each function as a standalone file with no shared imports)
// ---------------------------------------------------------------------------

async function applyCalendarAction(action: CalendarAction): Promise<Applied> {
  const baseUrl = Deno.env.get("CALDAV_BASE_URL");
  const calendarPath = Deno.env.get("CALDAV_CALENDAR_PATH");
  const username = Deno.env.get("CALDAV_USERNAME");
  const password = Deno.env.get("CALDAV_PASSWORD");
  if (!baseUrl || !calendarPath) {
    return { summary: MSG.calendarNotConfigured, undo: [] };
  }

  try {
    if (action.action === "create") {
      return await createCalendarEvent(baseUrl, calendarPath, username, password, action);
    }
    if (action.event_number != null) {
      return await deleteCalendarEventByNumber(baseUrl, calendarPath, username, password, action.event_number);
    }
    return await deleteCalendarEvent(baseUrl, calendarPath, username, password, action.title);
  } catch (error) {
    console.error(`telegram-webhook calendar_error ${errorMessage(error)}`);
    return { summary: MSG.calendarUnreachable, undo: [] };
  }
}

async function createCalendarEvent(
  baseUrl: string,
  calendarPath: string,
  username: string | undefined,
  password: string | undefined,
  action: CalendarAction
): Promise<Applied> {
  if (!action.start) return { summary: MSG.calendarNeedsDate, undo: [] };

  const uid = crypto.randomUUID();
  const start = new Date(action.start);
  const end = action.end ? new Date(action.end) : new Date(start.getTime() + 60 * 60 * 1000);
  const ics = buildVEvent(uid, action.title, start, end, action.all_day, action.location);
  const url = `${baseUrl.replace(/\/$/, "")}${calendarPath}${uid}.ics`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...caldavAuthHeaders(username, password),
      "Content-Type": "text/calendar; charset=utf-8",
      "If-None-Match": "*"
    },
    body: ics,
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    console.error(`telegram-webhook calendar_put_${response.status}`);
    return { summary: MSG.calendarSaveFailed, undo: [] };
  }

  const where = action.location ? ` · ${action.location}` : "";
  return {
    summary: `📅 Agendado: ${action.title}\n${formatEventTime(start, action.all_day)}${where}`,
    undo: [{ op: "delete_event", url }]
  };
}

async function deleteCalendarEvent(
  baseUrl: string,
  calendarPath: string,
  username: string | undefined,
  password: string | undefined,
  title: string
): Promise<Applied> {
  const now = new Date();
  const until = new Date(now.getTime() + calendarLookaheadDays() * 24 * 60 * 60 * 1000);
  const events = await queryCalendarEvents(baseUrl, calendarPath, username, password, now, until);

  // Accent-insensitive so "reuniao" finds "Reunião" — the user types on a phone
  // keyboard and the event title came from wherever the calendar was created.
  const needle = foldAccents(title.toLowerCase());
  // Deduped by href because a recurring event now expands to one row per
  // occurrence: without this, "cancela a reunião semanal" would ask which of
  // eight identical Mondays to delete, when every one of them deletes the
  // same resource — the whole series.
  const matches = dedupeByHref(
    events.filter((event) => foldAccents(event.title.toLowerCase()).includes(needle))
  );
  if (matches.length === 0) {
    return { summary: `🤔 Não encontrei nenhum evento com “${title}”.`, undo: [] };
  }
  if (matches.length > 1) {
    // Was a dead end that told the user to rephrase. The bot already knows
    // exactly which events they are — asking with buttons costs one tap.
    const shown = matches.slice(0, MAX_CHOICE_OPTIONS);
    return {
      summary: `🤔 Achei ${matches.length} eventos com “${title}”. Qual eu cancelo?`,
      undo: [],
      choices: [{
        prompt: `📅 Eventos com “${title}”:`,
        options: shown.map((event) => ({
          label: `${formatEventTime(new Date(event.start), event.allDay)} — ${event.title}`,
          op: {
            op: "delete_event",
            url: resolveCaldavHref(baseUrl, event.href),
            ics: event.ics,
            title: event.title
          }
        }))
      }]
    };
  }

  return performCalendarEventDelete(baseUrl, username, password, matches[0]);
}

// "cancela o evento 1": addresses the Nth row of the exact same window/order/
// cap the agenda block last showed (see upcomingAgendaEvents), so the number
// the user just read off /listas resolves to that row and nothing else —
// unlike a title search, this can never be ambiguous.
async function deleteCalendarEventByNumber(
  baseUrl: string,
  calendarPath: string,
  username: string | undefined,
  password: string | undefined,
  eventNumber: number
): Promise<Applied> {
  const events = await upcomingAgendaEvents(baseUrl, calendarPath, username, password);
  const match = events[eventNumber - 1];
  if (!match) {
    return { summary: `🤔 Não encontrei o evento número ${eventNumber} na agenda.`, undo: [] };
  }
  return performCalendarEventDelete(baseUrl, username, password, match);
}

async function performCalendarEventDelete(
  baseUrl: string,
  username: string | undefined,
  password: string | undefined,
  match: CalendarEventRow
): Promise<Applied> {
  // A multistatus href is normally a server-absolute path ("/calendars/..."),
  // which fetch() rejects outright — resolve it against the configured base.
  const eventUrl = resolveCaldavHref(baseUrl, match.href);
  const response = await fetch(eventUrl, {
    method: "DELETE",
    headers: caldavAuthHeaders(username, password),
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    console.error(`telegram-webhook calendar_delete_${response.status}`);
    return { summary: MSG.calendarDeleteFailed, undo: [] };
  }
  return {
    summary: `🗑 Evento cancelado: ${match.title}\n${formatEventTime(new Date(match.start), match.allDay)}`,
    // The raw ICS is kept verbatim so an undo re-creates the event exactly,
    // recurrence rules, alarms and all, rather than a lossy reconstruction
    // from the handful of fields this parser reads.
    undo: match.ics ? [{ op: "restore_event", url: eventUrl, ics: match.ics }] : []
  };
}

// Keeps the earliest upcoming occurrence of each calendar resource, so the
// date shown next to a series is the one about to happen.
function dedupeByHref(events: CalendarEventRow[]): CalendarEventRow[] {
  const byHref = new Map<string, CalendarEventRow>();
  for (const event of events) {
    const seen = byHref.get(event.href);
    if (!seen || event.start.localeCompare(seen.start) < 0) byHref.set(event.href, event);
  }
  return [...byHref.values()];
}

function calendarLookaheadDays(): number {
  return Number(Deno.env.get("AGENDA_LOOKAHEAD_DAYS") || "365") || 365;
}

function resolveCaldavHref(baseUrl: string, href: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

type CalendarEventRow = { href: string; title: string; start: string; allDay: boolean; ics: string };

async function queryCalendarEvents(
  baseUrl: string,
  calendarPath: string,
  username: string | undefined,
  password: string | undefined,
  start: Date,
  end: Date
): Promise<CalendarEventRow[]> {
  const url = `${baseUrl.replace(/\/$/, "")}${calendarPath}`;
  const response = await fetch(url, {
    method: "REPORT",
    headers: {
      ...caldavAuthHeaders(username, password),
      "Content-Type": "application/xml; charset=utf-8",
      "Depth": "1"
    },
    body: caldavTimeRangeQueryBody(start, end),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return [];

  const xml = await response.text();
  return parseCaldavResponses(xml, start, end);
}

function caldavAuthHeaders(username: string | undefined, password: string | undefined): HeadersInit {
  if (!username || !password) return {};
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
}

function caldavTimeRangeQueryBody(start: Date, end: Date): string {
  const startStamp = toCaldavUtcStamp(start);
  const endStamp = toCaldavUtcStamp(end);
  return `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${startStamp}" end="${endStamp}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

function toCaldavUtcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function parseCaldavResponses(xml: string, windowStart: Date, windowEnd: Date): CalendarEventRow[] {
  const rows: CalendarEventRow[] = [];
  const responsePattern = /<[\w-]*:?response[^>]*>([\s\S]*?)<\/[\w-]*:?response>/gi;
  let responseMatch: RegExpExecArray | null;
  while ((responseMatch = responsePattern.exec(xml)) !== null) {
    const block = responseMatch[1];
    const hrefMatch = /<[\w-]*:?href[^>]*>([\s\S]*?)<\/[\w-]*:?href>/i.exec(block);
    const dataMatch = /<[\w-]*:?calendar-data[^>]*>([\s\S]*?)<\/[\w-]*:?calendar-data>/i.exec(block);
    if (!hrefMatch || !dataMatch) continue;

    const href = decodeXmlEntities(hrefMatch[1]).trim();
    const ics = decodeXmlEntities(dataMatch[1]);
    for (const vevent of extractVEvents(ics)) {
      const lines = vevent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const title = icsLineValue(lines, "SUMMARY") || MSG.untitledEvent;
      const dtStartLine = icsFullLine(lines, "DTSTART");
      if (!dtStartLine) continue;
      const start = parseIcsDate(dtStartLine);
      if (!start) continue;

      // One row per occurrence inside the window, so a yearly birthday shows
      // up on its next date instead of the 1996 one the server hands back.
      for (const iso of expandRecurrence(
        start.iso,
        icsLineValue(lines, "RRULE"),
        collectExDates(lines),
        windowStart,
        windowEnd
      )) {
        const time = Date.parse(iso);
        if (!Number.isFinite(time) || time < windowStart.getTime() || time > windowEnd.getTime()) continue;
        rows.push({ href, title, start: iso, allDay: start.allDay, ics });
      }
    }
  }
  return rows;
}

function extractVEvents(ics: string): string[] {
  const blocks: string[] = [];
  const pattern = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ics)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function icsFullLine(lines: string[], key: string): string | null {
  return lines.find((line) => line.startsWith(`${key}:`) || line.startsWith(`${key};`)) ?? null;
}

function icsAllLines(lines: string[], key: string): string[] {
  return lines.filter((line) => line.startsWith(`${key}:`) || line.startsWith(`${key};`));
}

function icsLineValue(lines: string[], key: string): string {
  const line = icsFullLine(lines, key);
  if (!line) return "";
  const colonIndex = line.indexOf(":");
  return colonIndex >= 0 ? line.slice(colonIndex + 1).trim() : "";
}

function parseIcsDate(line: string): { iso: string; allDay: boolean } | null {
  const colonIndex = line.indexOf(":");
  if (colonIndex < 0) return null;
  const params = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1).trim();
  const allDay = /VALUE=DATE(?!-TIME)/i.test(params);

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (!year || !month || !day) return null;

  if (allDay) {
    return { iso: isoSeconds(new Date(Date.UTC(year, month - 1, day))), allDay: true };
  }

  const hour = Number(value.slice(9, 11)) || 0;
  const minute = Number(value.slice(11, 13)) || 0;
  const second = Number(value.slice(13, 15)) || 0;

  if (/Z$/.test(value)) {
    return { iso: isoSeconds(new Date(Date.UTC(year, month - 1, day, hour, minute, second))), allDay: false };
  }

  // DTSTART;TZID=America/Sao_Paulo:20260913T120000 means noon *there*. Reading
  // it as `new Date("2026-09-13T12:00:00")` resolves the wall clock against the
  // runtime's own zone — UTC on the edge host — so every confirmation and
  // every agenda line was off by the calendar's offset.
  const tzid = /TZID=([^;:]+)/i.exec(params)?.[1]?.trim();
  const zone = tzid || configuredTimezone();
  const parsed = wallClockToUtc(year, month, day, hour, minute, second, zone);
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return { iso: isoSeconds(parsed), allDay: false };
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The instant a wall-clock reading corresponds to in a named zone. Derived
// from the offset the zone was at, rather than assumed, so a fixed "-03:00"
// does not break across a DST boundary.
function wallClockToUtc(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  timeZone: string
): Date | null {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(asIfUtc)) return null;
  try {
    let instant = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
    // A second pass in case the first guess landed on the far side of a
    // transition and read the wrong offset.
    const refined = asIfUtc - zoneOffsetMs(new Date(instant), timeZone);
    if (refined !== instant) instant = refined;
    return new Date(instant);
  } catch {
    // An unknown TZID throws inside Intl; the event is skipped rather than
    // placed at an invented time.
    return null;
  }
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return asUtc - date.getTime();
}

// ---------------------------------------------------------------------------
// Recurrence
//
// CalDAV can expand a rule server-side with <C:expand>, but Google's
// implementation ignores it and returns the master VEVENT — so a yearly
// birthday arrives dated 1996 and is invisible to anything that filters by
// "upcoming". This walks the rule forward instead.
//
// Only the parts a personal calendar actually uses are modelled. A rule
// outside that set returns the master start untouched — never a date this
// code invented.
// ---------------------------------------------------------------------------

const MAX_RECURRENCE_STEPS = 400;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

type RecurrenceRule = {
  freq: string;
  interval: number;
  count: number | null;
  until: number | null;
  byDay: number[];
  byMonth: number[];
  byMonthDay: number[];
};

function parseRrule(value: string): RecurrenceRule | null {
  const parts = new Map<string, string>();
  for (const chunk of value.split(";")) {
    const [key, val] = chunk.split("=");
    if (key && val) parts.set(key.trim().toUpperCase(), val.trim());
  }

  const freq = (parts.get("FREQ") || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;

  // Parts that change which occurrences a rule produces in ways the stepper
  // below does not model.
  for (const unsupported of ["BYSETPOS", "BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE"]) {
    if (parts.has(unsupported)) return null;
  }

  const byDay = (parts.get("BYDAY") || "")
    .split(",")
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean)
    // "2MO" is the second Monday of the period — positional, not a weekday
    // filter, so it belongs with the unsupported parts above.
    .map((token) => (/^[A-Z]{2}$/.test(token) ? WEEKDAYS.indexOf(token) : -2));
  if (byDay.some((index) => index < 0)) return null;
  if (byDay.length > 0 && freq !== "WEEKLY") return null;

  const until = parts.has("UNTIL") ? parseIcsUntil(parts.get("UNTIL") as string) : null;
  if (parts.has("UNTIL") && until === null) return null;

  const interval = Number(parts.get("INTERVAL") || "1");
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;

  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1,
    count: count !== null && Number.isFinite(count) && count > 0 ? Math.floor(count) : null,
    until,
    byDay,
    byMonth: icsNumberList(parts.get("BYMONTH")),
    byMonthDay: icsNumberList(parts.get("BYMONTHDAY"))
  };
}

function icsNumberList(value: string | undefined): number[] {
  if (!value) return [];
  return value.split(",").map((token) => Number(token.trim())).filter((n) => Number.isFinite(n));
}

function parseIcsUntil(value: string): number | null {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (!year || !month || !day) return null;
  const hour = Number(value.slice(9, 11)) || 0;
  const minute = Number(value.slice(11, 13)) || 0;
  const second = Number(value.slice(13, 15)) || 0;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function recurrenceStep(base: Date, rule: RecurrenceRule, index: number): Date | null {
  const jump = rule.interval * index;

  if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
    const days = rule.freq === "DAILY" ? jump : jump * 7;
    return new Date(base.getTime() + days * 86400000);
  }

  const day = base.getUTCDate();
  const targetMonth = rule.freq === "MONTHLY" ? base.getUTCMonth() + jump : base.getUTCMonth();
  const targetYear = rule.freq === "MONTHLY" ? base.getUTCFullYear() : base.getUTCFullYear() + jump;
  const normalizedYear = targetYear + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;

  // RFC 5545: an occurrence landing on a date the month does not have — the
  // 31st of February, Feb 29 in a common year — is skipped, not clamped.
  const daysInMonth = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0)).getUTCDate();
  if (day > daysInMonth) return null;

  return new Date(Date.UTC(
    normalizedYear, normalizedMonth, day,
    base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds()
  ));
}

// Jumping straight to the window skips ~11000 useless iterations for a
// birthday anchored in 1996. Not safe with COUNT, which has to be tallied
// from the first occurrence.
function firstRecurrenceStep(base: Date, rule: RecurrenceRule, windowStart: Date): number {
  if (rule.count !== null || base.getTime() >= windowStart.getTime()) return 0;
  const elapsed = windowStart.getTime() - base.getTime();
  let steps: number;
  switch (rule.freq) {
    case "DAILY": steps = elapsed / 86400000; break;
    case "WEEKLY": steps = elapsed / (7 * 86400000); break;
    case "MONTHLY":
      steps = (windowStart.getUTCFullYear() - base.getUTCFullYear()) * 12
        + (windowStart.getUTCMonth() - base.getUTCMonth());
      break;
    default:
      steps = windowStart.getUTCFullYear() - base.getUTCFullYear();
  }
  // One interval of slack, so the first occurrence in range is never stepped over.
  return Math.max(0, Math.floor(steps / rule.interval) - 1);
}

function matchesRecurrenceByParts(date: Date, rule: RecurrenceRule): boolean {
  if (rule.byMonth.length > 0 && !rule.byMonth.includes(date.getUTCMonth() + 1)) return false;
  if (rule.byMonthDay.length > 0 && !rule.byMonthDay.includes(date.getUTCDate())) return false;
  return true;
}

function expandRecurrence(
  startIso: string,
  rruleValue: string,
  exDates: Set<string>,
  windowStart: Date,
  windowEnd: Date
): string[] {
  const base = new Date(startIso);
  if (Number.isNaN(base.getTime())) return [];

  const rule = parseRrule(rruleValue);
  if (!rule) return [startIso];

  // A weekly rule listing several days yields more than one occurrence per
  // step, so each step emits its whole week and the filter below trims it.
  const weekdayOffsets = rule.byDay.length > 0
    ? rule.byDay.map((weekday) => (weekday - base.getUTCDay() + 7) % 7)
    : [0];

  const out: string[] = [];
  let emitted = 0;
  const start = firstRecurrenceStep(base, rule, windowStart);

  for (let step = start; step < start + MAX_RECURRENCE_STEPS; step++) {
    const anchor = recurrenceStep(base, rule, step);
    if (anchor === null) continue;

    let allPast = true;
    for (const offset of weekdayOffsets) {
      const occurrence = new Date(anchor.getTime() + offset * 86400000);
      const time = occurrence.getTime();
      if (time < base.getTime()) continue;
      if (rule.until !== null && time > rule.until) return out;

      allPast = false;
      emitted++;
      if (rule.count !== null && emitted > rule.count) return out;
      if (time > windowEnd.getTime()) return out;
      if (time < windowStart.getTime()) continue;
      if (!matchesRecurrenceByParts(occurrence, rule)) continue;

      const iso = isoSeconds(occurrence);
      if (!exDates.has(iso.slice(0, 10))) out.push(iso);
    }
    if (allPast && anchor.getTime() > windowEnd.getTime()) return out;
  }

  return out;
}

// EXDATE is matched by date rather than exact instant: a cancelled occurrence
// is cancelled whichever way its time was written.
function collectExDates(lines: string[]): Set<string> {
  const dates = new Set<string>();
  for (const line of icsAllLines(lines, "EXDATE")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) continue;
    const params = line.slice(0, colonIndex);
    for (const value of line.slice(colonIndex + 1).split(",")) {
      const parsed = parseIcsDate(`${params}:${value.trim()}`);
      if (parsed) dates.add(parsed.iso.slice(0, 10));
    }
  }
  return dates;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function buildVEvent(
  uid: string,
  title: string,
  start: Date,
  end: Date,
  allDay: boolean,
  location: string | null
): string {
  const dtStamp = toCaldavUtcStamp(new Date());
  const dtStart = allDay ? `;VALUE=DATE:${toIcsDate(start)}` : `:${toCaldavUtcStamp(start)}`;
  const dtEnd = allDay ? `;VALUE=DATE:${toIcsDate(end)}` : `:${toCaldavUtcStamp(end)}`;
  const locationLine = location ? `\nLOCATION:${escapeIcsText(location)}` : "";
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//kindle-dashboard//telegram-webhook//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${dtStamp}
DTSTART${dtStart}
DTEND${dtEnd}
SUMMARY:${escapeIcsText(title)}${locationLine}
END:VEVENT
END:VCALENDAR
`;
}

function toIcsDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function escapeIcsText(value: string): string {
  return value.replace(/([,;\\])/g, "\\$1");
}

// "sáb., 12/09 às 14:00" reads back as a confirmation; the previous
// "2026-09-12 14:00" made the user re-derive which day of the week that was,
// which is the one thing they actually want to check in a confirmation.
function formatEventTime(date: Date, allDay: boolean): string {
  // An all-day event carries a date, not an instant: it is stored as midnight
  // UTC, so rendering it in a western zone rolls it back to the day before —
  // a birthday on the 25th announced as the 24th. Read those in UTC, where
  // midnight is still the date the calendar wrote.
  const timezone = allDay ? "UTC" : configuredTimezone();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: timezone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).formatToParts(date).map((part) => [part.type, part.value])
  );

  const localZone = configuredTimezone();
  const dayLabel = relativeDayLabel(date, timezone, localZone) ?? `${parts.weekday} ${parts.day}/${parts.month}`;
  return allDay ? `${dayLabel} (dia inteiro)` : `${dayLabel} às ${parts.hour}:${parts.minute}`;
}

// eventZone is UTC for all-day events and the dashboard zone otherwise, but
// "hoje" always has to mean the user's today — otherwise an all-day event
// reads as today from 21:00 onwards, when UTC has already rolled over.
function relativeDayLabel(date: Date, eventZone: string, localZone: string): string | null {
  const dayIn = (value: Date, zone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  const dayOf = (value: Date) => dayIn(value, localZone);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const target = dayIn(date, eventZone);
  if (target === dayOf(today)) return "hoje";
  if (target === dayOf(tomorrow)) return "amanhã";
  return null;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegramMessage(
  chatId: string,
  text: string,
  replyMarkup?: unknown,
  replyToMessageId?: number
): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      // Anchors the confirmation to the request that caused it. Firing off
      // three quick messages and then reading three unattributed replies is
      // the normal way this bot gets used. allow_sending_without_reply keeps
      // a deleted original from swallowing the reply entirely.
      ...(replyToMessageId
        ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true }
        : {})
    })
  });
}

// Fired before the model call, not awaited: a second of silence reads as a
// hung bot, and the indicator costs nothing to be wrong about — Telegram
// clears it on its own after ~5s or when the reply lands.
function sendTypingInBackground(chatId: string, action = "typing"): void {
  telegramApi("sendChatAction", { chat_id: chatId, action }).catch(() => {});
}

// Telegram keeps a spinner on the button until the callback is answered, so
// this is not optional politeness — skipping it looks like a hung bot.
async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  await telegramApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

async function editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
  await telegramApi("editMessageText", { chat_id: chatId, message_id: messageId, text });
}

async function editMessageReplyMarkup(chatId: string, messageId: number): Promise<void> {
  await telegramApi("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

async function telegramApi(method: string, body: Record<string, unknown>): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      console.error(`telegram-webhook ${method}_${response.status} ${(await response.text()).slice(0, 200)}`);
    }
  } catch (error) {
    console.error(`telegram-webhook ${method}_error ${errorMessage(error)}`);
  }
}

function sendTelegramMessageInBackground(
  chatId: string,
  text: string,
  replyMarkup?: unknown,
  replyToMessageId?: number
): void {
  sendTelegramMessage(chatId, text, replyMarkup, replyToMessageId).catch((error) => {
    console.error(`telegram-webhook reply_error ${errorMessage(error)}`);
  });
}

// sendDocument needs multipart/form-data, not the JSON body every other
// telegramApi call sends — Telegram's Bot API only accepts a file upload that
// way, so this one bypasses telegramApi() and posts a FormData body directly.
async function sendTelegramDocument(
  chatId: string,
  filename: string,
  content: string,
  mimeType: string,
  replyToMessageId?: number
): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return;

  const form = new FormData();
  form.append("chat_id", chatId);
  if (replyToMessageId) {
    form.append("reply_to_message_id", String(replyToMessageId));
    form.append("allow_sending_without_reply", "true");
  }
  form.append("document", new Blob([content], { type: mimeType }), filename);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    console.error(`telegram-webhook sendDocument_${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

function sendTelegramDocumentInBackground(
  chatId: string,
  filename: string,
  content: string,
  mimeType: string,
  replyToMessageId?: number
): void {
  sendTelegramDocument(chatId, filename, content, mimeType, replyToMessageId).catch((error) => {
    console.error(`telegram-webhook sendDocument_error ${errorMessage(error)}`);
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Bot-Api-Secret-Token"
  };
}

// ---------------------------------------------------------------------------
// Heuristic parsing (fast path + fallback when no LLM_API_KEY is configured)
// ---------------------------------------------------------------------------

// The general free-text heuristic below only ever produces these five
// actions — "edit"/"important"/"unimportant" are number-addressed only (see
// parseNumberedCommandHeuristically) and never guessed from a bare verb here.
type GeneralHeuristicAction = "add" | "complete" | "uncomplete" | "delete" | "clear";

// Verbs are matched against an accent-folded copy of the message, so "concluí"
// and "conclui" are the same word here and the lists below stay plain ASCII.
// Portuguese matters more than English now: without an LLM_API_KEY — and, on
// Gemini's free tier, for the rest of the day once the request cap is hit —
// this parser is the only thing standing between the user and a blank reply.
const ACTION_VERBS: Record<GeneralHeuristicAction, string[]> = {
  uncomplete: ["undo", "uncheck", "not done", "incomplete", "desfazer", "desfaz", "desmarcar", "desmarca", "reabrir", "reabre"],
  delete: ["delete", "remove", "drop", "apagar", "apaga", "remover", "tirar", "tira", "excluir", "exclui", "deletar", "deleta"],
  clear: ["clear", "empty", "reset", "limpar", "limpa", "esvaziar", "esvazia", "zerar", "zera"],
  complete: ["done", "complete", "completed", "check off", "mark", "comprei", "comprado", "comprada", "feito", "feita", "fiz", "conclui", "concluido", "concluida", "pronto", "terminei", "terminado", "marcar", "marca"],
  add: ["add", "put", "include", "buy", "get", "need", "comprar", "compra", "adicionar", "adiciona", "incluir", "inclui", "anotar", "anota", "anote", "lembrar", "lembra", "lembre", "preciso", "colocar", "coloca", "poe", "por"]
};

// Checked in this order: a past-tense report ("ja comprei o cafe") must beat the
// "comprar" family, and "tira X da lista" must beat anything else it contains.
const ACTION_ORDER: GeneralHeuristicAction[] = ["uncomplete", "delete", "clear", "complete", "add"];

function verbPattern(verbs: string[]): RegExp {
  return new RegExp(`(?<![\\w-])(?:${verbs.map(escapeRegExp).join("|")})\\b`, "i");
}

function detectAction(foldedMessage: string): GeneralHeuristicAction | null {
  for (const action of ACTION_ORDER) {
    if (verbPattern(ACTION_VERBS[action]).test(foldedMessage)) return action;
  }
  return null;
}

function foldAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// The calendar heuristic is deliberately NOT consulted here. It used to run
// first, which meant "cancela a reuniao de sexta" short-circuited before the
// model ever saw it — and the model extracts a far better search title than a
// regex that just deletes the word "reuniao". It is the fallback now, not the
// fast path.
// A number always refers to the exact position /listas last rendered (see
// orderForNumbering / upcomingAgendaEvents), never to anything this parser
// could guess from words — so these patterns are checked, and answered
// deterministically, before either the general heuristic below or the LLM
// ever sees the message. This runs even when an LLM is configured: there is
// nothing for the model to add here, and a stray misread would be worse.
const NUMBERED_NOUN_PATTERN = "(item|itens|tarefa|tarefas|nota|notas|compra|compras|evento|eventos)";
const NUMBERED_REF_PATTERN = new RegExp(`\\b${NUMBERED_NOUN_PATTERN}\\s*(?:numero\\s*)?#?(\\d+)\\b`, "i");

const NUMBERED_ACTION_VERBS: Record<"complete" | "uncomplete" | "delete", string[]> = {
  complete: ["conclua", "concluir", "conclui", "termina", "terminar", "finaliza", "finalizar", "completa", "completar"],
  uncomplete: ["reabra", "reabrir", "reabre", "desfaz", "desfazer"],
  delete: ["exclua", "excluir", "exclui", "remova", "remover", "apague", "apagar", "deleta", "deletar", "tira", "tirar", "cancela", "cancelar"]
};

// A bare noun does not name a list on its own ("item 3" could be any list) —
// only "tarefa"/"nota"/"compra" do. Anything else falls back to whatever list
// word the rest of the sentence names, same default the free-text heuristic
// below already uses.
function numberedNounListKey(noun: string, message: string): ListKey {
  if (noun === "tarefa" || noun === "tarefas") return "todo";
  if (noun === "nota" || noun === "notas") return "notes";
  if (noun === "compra" || noun === "compras") return "grocery";
  return detectListKey(message);
}

function parseNumberedCommandHeuristically(message: string): TelegramAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const folded = foldAccents(normalized.toLowerCase());

  // "exclua o evento 1" / "cancela o evento 2": only the delete family — an
  // "evento 1" mentioned in some other context (e.g. while creating one) must
  // not be misread as a cancellation.
  const deleteVerbPattern = new RegExp(`\\b(?:${NUMBERED_ACTION_VERBS.delete.map(escapeRegExp).join("|")})\\b`, "i");
  const eventMatch = NUMBERED_REF_PATTERN.exec(normalized);
  if (eventMatch && foldAccents(eventMatch[1].toLowerCase()).startsWith("evento") && deleteVerbPattern.test(folded)) {
    const number = Number(eventMatch[2]);
    if (Number.isFinite(number) && number > 0) {
      return { kind: "calendar", action: "delete", title: "", start: null, end: null, all_day: false, location: null, event_number: number };
    }
  }

  // "mude/edita/altera o texto do item|tarefa|nota|compra N para X"
  const editMatch = new RegExp(
    `\\b(?:muda|mude|mudar|edita|edite|editar|altera|altere|alterar)\\b.*?\\b${NUMBERED_NOUN_PATTERN}\\s*(?:numero\\s*)?#?(\\d+)\\b.*?\\bpara\\s+(.+)$`,
    "i"
  ).exec(normalized);
  if (editMatch && !foldAccents(editMatch[1].toLowerCase()).startsWith("evento")) {
    const number = Number(editMatch[2]);
    const newText = tidyItemBody(editMatch[3]);
    if (Number.isFinite(number) && number > 0 && newText) {
      return {
        kind: "planner",
        action: "edit",
        list_key: numberedNounListKey(foldAccents(editMatch[1].toLowerCase()), normalized),
        items: [],
        item_numbers: [number],
        new_text: newText,
        all_lists: false
      };
    }
  }

  // A compound request ("conclua a tarefa 3 e marca como importante") must
  // reach the LLM, which can split it into two actions — a regex here can
  // only ever apply one. Guard both this branch and the action loop below on
  // never both firing for the same message.
  const hasOtherNumberedVerb = (["uncomplete", "delete", "complete"] as const).some((action) =>
    new RegExp(`\\b(?:${NUMBERED_ACTION_VERBS[action].map(escapeRegExp).join("|")})\\b`, "i").test(folded)
  );

  // "marca o item 5 como importante", "tira a importancia do item 5",
  // "desmarca importante o item 3" — checked ahead of complete/uncomplete
  // below, since "marca" alone is also a "complete" verb.
  const importantRef = NUMBERED_REF_PATTERN.exec(normalized);
  if (
    importantRef &&
    !foldAccents(importantRef[1].toLowerCase()).startsWith("evento") &&
    /\bimportante\b/i.test(folded) &&
    !hasOtherNumberedVerb
  ) {
    const number = Number(importantRef[2]);
    const isRemoval = /\b(desmarca|desmarque|tira|remove|remova|sem)\b.*\bimportante\b/i.test(folded)
      || /\bnao\s+(?:e|eh)?\s*importante\b/i.test(folded);
    if (Number.isFinite(number) && number > 0) {
      return {
        kind: "planner",
        action: isRemoval ? "unimportant" : "important",
        list_key: numberedNounListKey(foldAccents(importantRef[1].toLowerCase()), normalized),
        items: [],
        item_numbers: [number],
        all_lists: false
      };
    }
  }

  // "conclua a tarefa 3", "exclua o item 2 da lista de compras", "reabre a nota 1".
  if (/\bimportante\b/i.test(folded)) return null;
  for (const action of ["uncomplete", "delete", "complete"] as const) {
    const verbs = NUMBERED_ACTION_VERBS[action];
    const pattern = new RegExp(
      `\\b(?:${verbs.map(escapeRegExp).join("|")})\\b.*?\\b${NUMBERED_NOUN_PATTERN}\\s*(?:numero\\s*)?#?(\\d+)\\b`,
      "i"
    );
    const match = pattern.exec(normalized);
    if (match && !foldAccents(match[1].toLowerCase()).startsWith("evento")) {
      const number = Number(match[2]);
      if (Number.isFinite(number) && number > 0) {
        return {
          kind: "planner",
          action,
          list_key: numberedNounListKey(foldAccents(match[1].toLowerCase()), normalized),
          items: [],
          item_numbers: [number],
          all_lists: false
        };
      }
    }
  }

  return null;
}

function parseFastHeuristicMessage(message: string): TelegramAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");

  const numbered = parseNumberedCommandHeuristically(normalized);
  if (numbered) return numbered;

  // Deliberately strict: the fast path only fires when the user named both an
  // action and a list, because guessing the list wrong writes to the wrong
  // place. Everything else goes to the model, which is better at it.
  const folded = foldAccents(normalized.toLowerCase());
  const hasPlannerVerb = detectAction(folded) !== null;

  // And only for a message asking one thing. "anota o codigo do alarme,
  // adiciona regar as plantas nas tarefas e marca os ovos como comprados"
  // carries a verb and a list name, so it used to qualify — and collapsed into
  // a single nonsense add. Two verb families means two requests; the model
  // splits them, a regex cannot.
  if (hasPlannerVerb && countActionFamilies(folded) === 1 && hasExplicitList(normalized)) {
    return parseMessageHeuristically(normalized);
  }

  return null;
}

function countActionFamilies(foldedMessage: string): number {
  return ACTION_ORDER.filter((action) => verbPattern(ACTION_VERBS[action]).test(foldedMessage)).length;
}

function parseMessageHeuristically(message: string): TelegramAction {
  const calendarAction = parseCalendarHeuristically(message);
  if (calendarAction) return calendarAction;

  const normalized = message.trim().replace(/\s+/g, " ");
  const listKey = detectListKey(normalized);
  const explicitList = hasExplicitList(normalized);
  const action = detectAction(foldAccents(normalized.toLowerCase())) ?? "add";

  const allVerbs = ACTION_ORDER.flatMap((key) => ACTION_VERBS[key]);
  const leadingVerb = new RegExp(`^(?:por favor|please)?\\s*(?:${allVerbs.map(escapeRegExp).join("|")})\\b`, "i");

  // "ja comprei o cafe" puts an adverb in front of the verb, which would
  // otherwise anchor the verb strip at the wrong position.
  // (?=\s|$) rather than \b: JavaScript's \b is ASCII-only, so it finds no
  // boundary after the "á" in "já" and the strip silently never fires.
  let body = stripLeading(normalized, /^(?:já|ja|por favor|please)(?=\s|$)/i);
  body = stripLeading(body, leadingVerb);
  // "preciso comprar leite", "lembrar de ligar": a second verb routinely
  // survives the first strip.
  body = stripLeading(body, leadingVerb);
  body = stripListWords(body.replace(/\s+(?:done|complete|completed)$/i, ""), listKey);

  const items =
    action === "clear"
      ? []
      : body
          .split(/\s*(?:,| and | e |\+)\s*/i)
          .map(tidyItemBody)
          .filter(Boolean);

  return {
    kind: "planner",
    action,
    list_key: listKey,
    // An empty items array is the correct, meaningful value for "clear" — the
    // old fallback pushed the raw sentence in, which read back as an item.
    items: action === "clear" ? [] : items.length > 0 ? items : [tidyItemBody(body) || normalized],
    all_lists: !explicitList && (action === "complete" || action === "uncomplete" || action === "delete"),
    guessed_list: !explicitList && action === "add"
  };
}

// Removing a verb and a list name leaves grammatical debris on both ends
// ("cafe nas", "leite da lista de", ": ligar pro dentista"). Shaving connectors
// and punctuation until nothing more comes off is what turns that back into
// something the user recognizes in a confirmation — and into a needle that
// actually matches the stored row on a complete/delete.
function tidyItemBody(value: string): string {
  let out = value.trim();
  let previous = "";
  while (out !== previous) {
    previous = out;
    out = out
      .replace(/^[\s,;:.!¡-]+|[\s,;:.!-]+$/g, "")
      .replace(/^(?:de|do|da|dos|das|que|com|o|a|os|as|no|na|nos|nas|em|pra|para|the|my|minha|meu|to|in|on|from)\s+/i, "")
      .replace(/\s+(?:de|do|da|dos|das|no|na|nos|nas|em|pra|para|my|minha|meu|to|in|on|from)$/i, "")
      .replace(/\s+(?:listas?|lists?)$/i, "")
      .trim();
  }
  return out;
}

function stripLeading(value: string, pattern: RegExp): string {
  const match = pattern.exec(value);
  if (!match || match.index !== 0) return value;
  const rest = value.slice(match[0].length).trim();
  // Never strip the whole message away: "comprar" alone is an item, not a verb
  // with an empty object.
  return rest || value;
}

// Relative-date resolution ("amanhã às 14h", "segunda que vem") is left to the
// LLM — this heuristic only covers the trivial, unambiguous "cancel" case, so
// deleting an event still works with no LLM_API_KEY or an exhausted quota.
function parseCalendarHeuristically(message: string): CalendarAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const folded = foldAccents(normalized.toLowerCase());
  if (!/(?<![\w-])(?:cancel|cancela|cancelar|delete|remove|remover|apagar|apaga|desmarcar|desmarca)\b/.test(folded)) return null;
  if (!/(?<![\w-])(?:meeting|event|appointment|reuniao|evento|compromisso|consulta|agenda)\b/.test(folded)) return null;

  const withoutVerb = normalized
    .replace(/^(?:por favor|please)?\s*(?:cancel|cancela|cancelar|delete|remove|remover|apagar|apaga|desmarcar|desmarca)\s+(?:the|o|a)?\s*/i, "")
    .trim();
  const withoutNoun = tidyItemBody(
    withoutVerb
      .replace(/(?<![\w-])(?:meeting|event|appointment|reuni[ãa]o|evento|compromisso|consulta|agenda)\b/gi, "")
      .replace(/\s+/g, " ")
  );

  // "cancela a reuniao de sexta" leaves only "sexta" once the noun goes, which
  // matches nothing in the calendar. Keep the noun whenever dropping it leaves
  // no real subject behind.
  const title = withoutNoun.split(" ").filter(Boolean).length >= 2 ? withoutNoun : tidyItemBody(withoutVerb);
  if (!title) return null;

  return { kind: "calendar", action: "delete", title, start: null, end: null, all_day: false, location: null, event_number: null };
}

function validateTelegramAction(input: unknown): TelegramAction | null {
  return validateCalendarAction(input) ?? validatePlannerAction(input);
}

const PLANNER_ACTIONS = ["add", "complete", "uncomplete", "delete", "clear", "edit", "important", "unimportant"];

function validatePlannerAction(input: unknown): PlannerAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<PlannerAction>;

  if (!PLANNER_ACTIONS.includes(String(candidate.action))) return null;
  if (!LIST_KEYS.includes(candidate.list_key as ListKey)) return null;

  const action = candidate.action as PlannerAction["action"];
  const items = Array.isArray(candidate.items)
    ? candidate.items.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const itemNumbers = Array.isArray(candidate.item_numbers)
    ? candidate.item_numbers.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  const newText = typeof candidate.new_text === "string" ? candidate.new_text.trim() : "";

  // "add" always needs item text — there is nothing to number yet. "clear"
  // needs neither. Every other action targets an existing row, by number or
  // by needle; "edit" additionally needs the replacement text.
  if (action === "add" && items.length === 0) return null;
  if (action !== "add" && action !== "clear" && items.length === 0 && itemNumbers.length === 0) return null;
  if (action === "edit" && !newText) return null;

  return {
    kind: "planner",
    action,
    list_key: candidate.list_key as ListKey,
    items,
    item_numbers: itemNumbers.length > 0 ? itemNumbers : undefined,
    new_text: action === "edit" ? newText : undefined,
    // Numbers address one specific list's own numbering, so a number-targeted
    // action can never also mean "search every list".
    all_lists: itemNumbers.length > 0 ? false : Boolean(candidate.all_lists)
  };
}

function validateCalendarAction(input: unknown): CalendarAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<CalendarAction> & { kind?: string };
  if (candidate.kind !== "calendar") return null;
  if (candidate.action !== "create" && candidate.action !== "delete") return null;

  if (candidate.action === "delete") {
    const eventNumber = Number(candidate.event_number);
    if (Number.isInteger(eventNumber) && eventNumber > 0) {
      return {
        kind: "calendar",
        action: "delete",
        title: "",
        start: null,
        end: null,
        all_day: false,
        location: null,
        event_number: eventNumber
      };
    }
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (!title) return null;
    return { kind: "calendar", action: "delete", title, start: null, end: null, all_day: false, location: null, event_number: null };
  }

  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (!title) return null;

  const start = typeof candidate.start === "string" && !Number.isNaN(Date.parse(candidate.start))
    ? candidate.start
    : null;
  if (!start) return null;

  const end = typeof candidate.end === "string" && !Number.isNaN(Date.parse(candidate.end))
    ? candidate.end
    : new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();

  return {
    kind: "calendar",
    action: "create",
    title,
    start,
    end,
    all_day: Boolean(candidate.all_day),
    location: typeof candidate.location === "string" && candidate.location.trim() ? candidate.location.trim() : null,
    event_number: null
  };
}

function isCalendarAction(action: TelegramAction): action is CalendarAction {
  return (action as CalendarAction).kind === "calendar";
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const LIST_ALIASES: Record<ListKey, string[]> = {
  grocery: ["grocery", "groceries", "shopping", "market", "comprar", "compra", "compras", "mercado", "supermercado", "feira"],
  todo: ["todo", "to-do", "task", "tasks", "errand", "errands", "tarefa", "tarefas", "afazer", "afazeres", "pendencia", "pendencias"],
  notes: ["note", "notes", "nota", "notas", "anotacao", "anotacoes", "recado", "recados"]
};

const LIST_KEYS: ListKey[] = ["grocery", "todo", "notes"];

// An alias must stand on its own. A plain includes() was fine while the aliases were
// English, but every Portuguese weekday ends in "-feira" ("sexta-feira"), which made
// any message mentioning a weekday classify as grocery. A bare \b does not help,
// because the hyphen in "sexta-feira" is itself a word boundary — hence the lookbehind
// rejecting a hyphen-joined prefix. A trailing \b still allows "grocery-list".
function matchesAlias(lowerMessage: string, alias: string): boolean {
  return new RegExp(`(?<![\\w-])${escapeRegExp(alias)}\\b`).test(lowerMessage);
}

// Detection folds accents so the alias table can stay plain ASCII and still
// match "pendências" or "anotação". stripListWords below matches the raw text
// instead, so an accented alias survives in the item body — harmless, and far
// cheaper than keeping a folded-to-raw offset map just to delete a word.
function detectListKey(message: string): ListKey {
  const lower = foldAccents(message.toLowerCase());
  for (const key of LIST_KEYS) {
    if (LIST_ALIASES[key].some((alias) => matchesAlias(lower, alias))) return key;
  }
  return "todo";
}

function stripListWords(message: string, listKey: ListKey): string {
  let output = message;
  for (const alias of LIST_ALIASES[listKey]) {
    output = output.replace(new RegExp(`(?<![\\w-])${escapeRegExp(alias)}\\b`, "ig"), "");
  }
  return output.replace(/\s+(list|plan)\b/gi, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExplicitList(message: string): boolean {
  const lower = foldAccents(message.toLowerCase());
  return LIST_KEYS.some((key) => LIST_ALIASES[key].some((alias) => matchesAlias(lower, alias)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" }
  });
}

function requiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

// Every admin client in this file is built from the same two env vars — a
// one-line call beats eight repeated inline createAdminClient() literals,
// and it means a future option (retry, timeout) only needs to change once.
function insforgeAdmin(): any {
  return createAdminClient({
    baseUrl: requiredEnv("INSFORGE_BASE_URL"),
    apiKey: requiredEnv("INSFORGE_API_KEY")
  });
}

function timeMs(): number {
  return Date.now();
}

function elapsedMs(started: number): number {
  return Date.now() - started;
}

function logTiming(label: string, timing: Record<string, number | string>): void {
  console.log(`${label} timing ${JSON.stringify(timing)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
