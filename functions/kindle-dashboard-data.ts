import { createAdminClient } from "npm:@insforge/sdk";

type ListKey = "grocery" | "todo" | "notes";

type PlannerItem = {
  id: string;
  list_key: ListKey;
  text: string;
  done: boolean;
  created_at: string;
  updated_at: string;
};

type WeatherPayload = {
  available: boolean;
  fetched_at: string | null;
  temperature_c: number;
  feels_like_c: number;
  condition_label: string;
  precipitation_probability: number;
  precipitation_mm_today: number;
  high_c: number;
  low_c: number;
  wind_kph: number;
};

type AgendaEvent = {
  uid: string;
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  location: string | null;
};

type AgendaPayload = {
  available: boolean;
  fetched_at: string | null;
  events: AgendaEvent[];
};

type DashboardPayload = {
  ok: true;
  generated_at: string;
  version: string;
  weather: WeatherPayload;
  agenda: AgendaPayload;
  lists: Array<{
    key: ListKey;
    title: string;
    items: Array<{
      id: string;
      text: string;
      done: boolean;
      updated_at: string;
    }>;
  }>;
};

// Fallback when DASHBOARD_TIMEZONE is unset; must match telegram-webhook.ts.
const DEFAULT_TIMEZONE = "America/Sao_Paulo";

const LIST_TITLES: Record<ListKey, string> = {
  todo: "Tarefas",
  grocery: "Compras",
  notes: "Notas"
};
const COMPLETED_ITEM_HIDE_AFTER_MS = 24 * 60 * 60 * 1000;
const AGENDA_MAX_EVENTS = Number(Deno.env.get("AGENDA_MAX_EVENTS")) || 8;
// The tile shows "the next N events", so the window exists only to bound the
// CalDAV query and the recurrence walk — not to decide what is worth showing.
// It used to be 36 hours, which meant a calendar with nothing until next week
// rendered an empty agenda while the events sat just past the edge.
const AGENDA_LOOKAHEAD_DAYS = Number(Deno.env.get("AGENDA_LOOKAHEAD_DAYS")) || 365;

export default async function(req: Request): Promise<Response> {
  const requestStarted = timeMs();
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  if (!isAuthorizedDashboardRead(req)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const payload = await loadDashboardPayload();
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  } finally {
    logTiming("kindle-dashboard-data", { total_ms: elapsedMs(requestStarted) });
  }
}

async function loadDashboardPayload(): Promise<DashboardPayload> {
  const admin = createAdminClient({
    baseUrl: requiredEnv("INSFORGE_BASE_URL"),
    apiKey: requiredEnv("INSFORGE_API_KEY")
  });

  const baseStarted = timeMs();
  const [itemsResult, weather, agenda] = await Promise.all([
    admin.database
      .from("planner_items")
      .select("id,list_key,text,done,created_at,updated_at")
      .in("list_key", ["todo", "grocery", "notes"])
      .order("created_at", { ascending: false }),
    fetchWeather(Deno.env.get("WEATHER_LAT"), Deno.env.get("WEATHER_LON")),
    fetchAgenda(
      Deno.env.get("CALDAV_BASE_URL"),
      Deno.env.get("CALDAV_CALENDAR_PATH"),
      Deno.env.get("CALDAV_USERNAME"),
      Deno.env.get("CALDAV_PASSWORD"),
      AGENDA_LOOKAHEAD_DAYS
    )
  ]);
  const baseQueryMs = elapsedMs(baseStarted);

  const { data: items, error: itemsError } = itemsResult;
  if (itemsError) throw itemsError;

  const staleCompletedCutoff = Date.now() - COMPLETED_ITEM_HIDE_AFTER_MS;
  const plannerItems = (items as PlannerItem[]).filter((item) => shouldShowPlannerItem(item, staleCompletedCutoff));

  const payloadWithoutVersion = {
    ok: true as const,
    generated_at: new Date().toISOString(),
    weather,
    agenda: {
      ...agenda,
      events: agenda.events.map((event: AgendaEvent) => ({
        ...event,
        title: asciiFoldUpper(event.title),
        location: event.location ? asciiFoldUpper(event.location) : null,
        // The native renderer has no timezone tables — it reads HH:MM
        // straight out of these characters, so they must already be local.
        start: event.all_day ? event.start : toLocalIsoString(event.start),
        end: event.end && !event.all_day ? toLocalIsoString(event.end) : event.end
      }))
    },
    // Fixed order: the native renderer maps array position directly to
    // on-screen tile (0=TAREFAS, 1=COMPRAS, 2=NOTAS) - do not reorder.
    lists: (["todo", "grocery", "notes"] as const).map((key) => ({
      key,
      title: LIST_TITLES[key],
      items: plannerItems
        .filter((item) => item.list_key === key)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((item) => ({
          id: item.id,
          text: asciiFoldUpper(item.text),
          done: item.done,
          updated_at: item.updated_at
        }))
    }))
  };

  const payload = {
    ...payloadWithoutVersion,
    version: hashText(JSON.stringify({
      weather: payloadWithoutVersion.weather,
      agenda: payloadWithoutVersion.agenda,
      lists: payloadWithoutVersion.lists
    }))
  };
  logTiming("kindle-dashboard-data", {
    base_query_ms: baseQueryMs,
    weather_available: weather.available ? 1 : 0,
    agenda_available: agenda.available ? 1 : 0
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo — public, no API key required)
// ---------------------------------------------------------------------------

const WEATHER_CONDITION_BY_CODE: Record<number, string> = {
  0: "CLEAR",
  1: "CLOUDY", 2: "CLOUDY", 3: "CLOUDY",
  45: "FOG", 48: "FOG",
  51: "DRIZZLE", 53: "DRIZZLE", 55: "DRIZZLE", 56: "DRIZZLE", 57: "DRIZZLE",
  61: "RAIN", 63: "RAIN", 65: "RAIN", 66: "RAIN", 67: "RAIN",
  71: "SNOW", 73: "SNOW", 75: "SNOW", 77: "SNOW",
  80: "SHOWERS", 81: "SHOWERS", 82: "SHOWERS",
  95: "STORM", 96: "STORM", 99: "STORM"
};

function weatherLabelForCode(code: number): string {
  return WEATHER_CONDITION_BY_CODE[code] ?? "UNKNOWN";
}

function emptyWeather(): WeatherPayload {
  return {
    available: false,
    fetched_at: null,
    temperature_c: 0,
    feels_like_c: 0,
    condition_label: "UNKNOWN",
    precipitation_probability: 0,
    precipitation_mm_today: 0,
    high_c: 0,
    low_c: 0,
    wind_kph: 0
  };
}

async function fetchWeather(lat: string | undefined, lon: string | undefined): Promise<WeatherPayload> {
  if (!lat || !lon) return emptyWeather();

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat);
    url.searchParams.set("longitude", lon);
    url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m");
    url.searchParams.set("hourly", "precipitation_probability");
    url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "1");

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return emptyWeather();

    const data = await response.json();
    const current = data?.current ?? {};
    const hourly = data?.hourly ?? {};
    const daily = data?.daily ?? {};

    const hourlyTimes: string[] = Array.isArray(hourly.time) ? hourly.time : [];
    const currentTime: string | undefined = current.time;
    const hourIndex = currentTime ? hourlyTimes.findIndex((time) => time === currentTime) : -1;
    const precipitationProbability = hourIndex >= 0
      ? Number(hourly.precipitation_probability?.[hourIndex] ?? 0)
      : Number(hourly.precipitation_probability?.[0] ?? 0);

    return {
      available: true,
      fetched_at: new Date().toISOString(),
      temperature_c: roundNumber(current.temperature_2m),
      feels_like_c: roundNumber(current.apparent_temperature),
      condition_label: weatherLabelForCode(Number(current.weather_code ?? -1)),
      precipitation_probability: Math.max(0, Math.min(100, roundNumber(precipitationProbability))),
      precipitation_mm_today: roundNumber(daily.precipitation_sum?.[0]),
      high_c: roundNumber(daily.temperature_2m_max?.[0]),
      low_c: roundNumber(daily.temperature_2m_min?.[0]),
      wind_kph: roundNumber(current.wind_speed_10m)
    };
  } catch {
    return emptyWeather();
  }
}

function roundNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

// ---------------------------------------------------------------------------
// Agenda (CalDAV — hand-rolled client, no npm dependency)
// ---------------------------------------------------------------------------

function emptyAgenda(): AgendaPayload {
  return { available: false, fetched_at: null, events: [] };
}

async function fetchAgenda(
  baseUrl: string | undefined,
  calendarPath: string | undefined,
  username: string | undefined,
  password: string | undefined,
  lookaheadDays: number
): Promise<AgendaPayload> {
  if (!baseUrl || !calendarPath) return emptyAgenda();

  try {
    const now = new Date();
    const until = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
    const body = caldavTimeRangeQueryBody(now, until);
    const url = `${baseUrl.replace(/\/$/, "")}${calendarPath}`;

    const response = await fetch(url, {
      method: "REPORT",
      headers: {
        ...caldavAuthHeaders(username, password),
        "Content-Type": "application/xml; charset=utf-8",
        "Depth": "1"
      },
      body,
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return emptyAgenda();

    const xml = await response.text();
    // An hour of grace so an event that started while you were walking to the
    // Kindle is still on the screen.
    const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
    const events = parseCaldavEvents(xml, windowStart, until)
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, AGENDA_MAX_EVENTS);

    return { available: true, fetched_at: new Date().toISOString(), events };
  } catch {
    return emptyAgenda();
  }
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

function parseCaldavEvents(xml: string, windowStart: Date, windowEnd: Date): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  const calendarDataPattern = /<[\w-]*:?calendar-data[^>]*>([\s\S]*?)<\/[\w-]*:?calendar-data>/gi;
  let match: RegExpExecArray | null;
  while ((match = calendarDataPattern.exec(xml)) !== null) {
    const ics = decodeXmlEntities(match[1]);
    for (const vevent of extractVEvents(ics)) {
      events.push(...parseVEvent(vevent, windowStart, windowEnd));
    }
  }
  return events;
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

// Returns every occurrence of this VEVENT that falls inside the window — one
// entry for a plain event, several for a recurring one.
function parseVEvent(block: string, windowStart: Date, windowEnd: Date): AgendaEvent[] {
  const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const uid = icsLineValue(lines, "UID") || crypto.randomUUID();
  const title = icsLineValue(lines, "SUMMARY") || "Untitled event";
  const location = icsLineValue(lines, "LOCATION") || null;
  const dtStartLine = icsFullLine(lines, "DTSTART");
  const dtEndLine = icsFullLine(lines, "DTEND");
  if (!dtStartLine) return [];

  const start = parseIcsDate(dtStartLine);
  if (!start) return [];
  const end = dtEndLine ? parseIcsDate(dtEndLine) : null;
  const durationMs = end ? Date.parse(end.iso) - Date.parse(start.iso) : 0;

  const starts = expandRecurrence(
    start.iso,
    icsLineValue(lines, "RRULE"),
    collectExDates(lines),
    windowStart,
    windowEnd
  ).filter((iso) => {
    const time = Date.parse(iso);
    return Number.isFinite(time) && time >= windowStart.getTime() && time <= windowEnd.getTime();
  });

  return starts.map((iso, index) => ({
    // A recurring event yields several rows from one UID, and the renderer
    // keys on it, so each occurrence gets its own.
    uid: index === 0 ? uid : `${uid}#${iso.slice(0, 10)}`,
    title,
    start: iso,
    end: end ? isoSeconds(new Date(Date.parse(iso) + durationMs)) : null,
    all_day: start.allDay,
    location
  }));
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
  // runtime's own zone — UTC on the edge host — which shifted every one of
  // these events by the calendar's offset, silently and in the wrong direction.
  const tzid = /TZID=([^;:]+)/i.exec(params)?.[1]?.trim();
  const zone = tzid || Deno.env.get("DASHBOARD_TIMEZONE") || DEFAULT_TIMEZONE;
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
// implementation ignores it and hands back the master VEVENT — so a yearly
// birthday arrives dated 1996 and gets dropped for being in the past. This
// walks the rule forward instead.
//
// Only the parts a personal calendar actually uses are modelled. A rule
// outside that set returns the master start untouched, which is the same
// nothing-on-screen it produces today — never a date this code invented.
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toLocalIsoString(isoUtc: string): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return isoUtc;
  return zonedIsoString(date, Deno.env.get("DASHBOARD_TIMEZONE") || DEFAULT_TIMEZONE);
}

function zonedIsoString(date: Date, timeZone: string): string {
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

  const localMillis = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  const offsetMinutes = Math.round((localMillis - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHH = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const offsetMM = String(absMinutes % 60).padStart(2, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHH}:${offsetMM}`;
}

function asciiFoldUpper(text: string): string {
  const folded = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return folded.toUpperCase().replace(/[^A-Z0-9 /:\-_.,%[\]+|!#]/g, "?");
}

function shouldShowPlannerItem(item: PlannerItem, staleCompletedCutoff: number): boolean {
  if (!item.done) return true;
  const updatedAt = Date.parse(item.updated_at);
  if (!Number.isFinite(updatedAt)) return true;
  return updatedAt > staleCompletedCutoff;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Dashboard-Read-Token, Authorization"
  };
}

function isAuthorizedDashboardRead(req: Request): boolean {
  const configuredToken = requiredEnv("DASHBOARD_READ_TOKEN");
  const receivedToken =
    req.headers.get("x-dashboard-read-token") ||
    bearerToken(req.headers.get("authorization")) ||
    new URL(req.url).searchParams.get("read_token");
  return Boolean(receivedToken) && receivedToken === configuredToken;
}

function bearerToken(header: string | null): string {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  return match?.[1]?.trim() || "";
}

function requiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function timeMs(): number {
  return performance.now();
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

function logTiming(label: string, timing: Record<string, number>): void {
  console.log(`${label} timing ${JSON.stringify(timing)}`);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
