#include <ctype.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <math.h>
#include <errno.h>
#include <pthread.h>
#include <sys/time.h>
#include <time.h>
#ifdef __linux__
#include <linux/input.h>
#include <linux/fb.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#endif

namespace {

const char* kDefaultUrl = "";
const char* kDefaultEventsUrl = "";
const char* kDefaultToggleUrl = "";
const char* kDefaultCache = "/mnt/us/documents/kindle-dashboard-data.json";
const char* kDefaultPhotoPath = "/mnt/us/extensions/kindle-dashboard/assets/profile.pgm";
const int kDefaultIntervalSeconds = 180;
const char* kDefaultSleepWindow = "off";
const long kMaxDashboardPayloadBytes = 512 * 1024;
const int kScreenColumns = 40;
const int kMaxRows = 28;
const int kCardInnerWidth = 36;
const int kMaxLists = 4;
const int kMaxItems = 16;
const int kMaxAgendaEvents = 8;
const int kBitmapFallbackWidth = 760;
const int kBitmapFallbackHeight = 1024;
const int kKindleStatusBarHeight = 66;

volatile sig_atomic_t g_running = 1;
volatile sig_atomic_t g_event_refresh = 0;
volatile sig_atomic_t g_manual_fetch_refresh = 0;
int g_last_screen_width = kBitmapFallbackWidth;
int g_last_screen_height = kBitmapFallbackHeight;
int g_active_list = -1;
char g_photo_path[256] = "";
// Header title. The bitmap font is uppercase-only, so --title is upper-cased on the way in.
char g_title[64] = "PAINEL KINDLE";
// Dark mode. Every draw call still works in the light palette (ink 0 on paper
// 255) and the finished canvas is inverted once, in drawCurrentDashboard(),
// rather than threading an ink/paper colour through ~120 call sites. Both give
// the same pixels for a two-tone design, and the single inversion cannot miss a
// call site the way a hand-swapped palette can. The photo tile is the one thing
// pre-inverted on the way in, so it survives the final flip as a photo instead
// of a negative - which is what the old --invert-images flag was reaching for.
int g_dark_mode = 0;
// Locks out every touch except the lock button itself, until it is tapped
// again - so the dashboard can be carried around or wiped clean without an
// incidental tap opening a list or exiting to the Kindle home screen. Always
// starts unlocked: there is no reason for this to survive a relaunch, and a
// relaunch redraws the whole screen from scratch anyway.
int g_screen_locked = 0;
// Skip-unchanged redraws (battery). Every fetch used to redraw the whole e-ink panel even
// when nothing changed. g_last_drawn_signature describes what is on the glass after a
// kRenderIfChanged/kRenderRecord draw; any other draw clears it so the next fetch always
// repaints (e.g. an optimistic touch toggle the server never accepted must get corrected).
// A full redraw is still forced every kForcedRedrawMs, to clear anything the Kindle's own
// UI (popups, warnings) may have left on top of the dashboard.
enum RenderMode { kRenderForce, kRenderIfChanged, kRenderRecord };
char g_last_drawn_signature[160] = "";
long long g_last_drawn_ms = 0;
int g_last_render_skipped = 0;
char g_last_fetch_status[32] = "live";
const long long kForcedRedrawMs = 30LL * 60 * 1000;

enum TouchAction {
  kTouchNone = 0,
  kTouchExit = 1,
  kTouchBack = 2,
  kTouchOpenList = 3,
  kTouchToggleItem = 4,
  kTouchHome = 8,
  // Locks the screen; only ever reachable by an actual touchscreen tap on the padlock
  // button, since applyTouchWithDebounce() returns before dispatching anything else while
  // g_screen_locked is set - so this action always means "was unlocked, now locking."
  kTouchToggleLock = 9,
  // The other half of the pair. Never comes from the touchscreen at all - set only by
  // pollPowerButtonUnlock() on a physical power-button press, and only while locked. Kept
  // in this enum (and dispatched through the same g_pending_action plumbing) purely to
  // reuse the existing main-loop "an action is pending, handle it and redraw" mechanism,
  // not because it is a touch.
  kTouchHardwareUnlock = 10
};

struct Item {
  char id[48];
  char text[96];
  int done;
};

struct List {
  char key[24];
  char title[40];
  Item items[kMaxItems];
  int item_count;
};

struct Weather {
  int available;
  int temperature_c;
  int feels_like_c;
  int high_c;
  int low_c;
  int precipitation_probability;
  int wind_kph;
  char condition_label[16];
};

struct AgendaEvent {
  char uid[48];
  char title[64];
  char start[32];
  char location[64];
  int all_day;
};

struct Dashboard {
  char generated_at[40];
  char version[32];
  Weather weather;
  AgendaEvent agenda_events[kMaxAgendaEvents];
  int agenda_event_count;
  int agenda_available;
  List lists[kMaxLists];
  int list_count;
};

struct Options {
  char url[256];
  char events_url[256];
  char toggle_url[256];
  char read_token[160];
  char toggle_token[160];
  char cache[256];
  char render_only[256];
  char view[32];
  char dump_pgm[256];
  char save_pgm[256];
  char photo_path[256];
  char title[64];
  int dump_width;
  int dump_height;
  int interval;
  int sleep_start_minute;
  int sleep_end_minute;
  int once;
  int dark;
};

struct Canvas {
  int width;
  int height;
  unsigned char* pixels;
};

struct Rect {
  int x;
  int y;
  int w;
  int h;
};

struct TouchRegion {
  Rect rect;
  TouchAction action;
  int list_index;
  int item_index;
  char item_id[48];
  int item_done;
};

const int kMaxTouchRegions = 32;
TouchRegion g_touch_regions[kMaxTouchRegions];
int g_touch_region_count = 0;
TouchAction g_pending_action = kTouchNone;
int g_pending_list_index = -1;
int g_pending_recipe_index = -1;
char g_pending_item_id[48];
int g_pending_item_done = 0;
int g_pending_touch_x = -1;
int g_pending_touch_y = -1;
Rect g_pending_touch_rect = {0, 0, 0, 0};
int g_pending_touch_rect_valid = 0;

// Frontlight power management: the device previously stayed lit the entire
// time the dashboard ran (preventScreenSaver just stops the OS screensaver,
// it never controlled the frontlight). We manage the frontlight ourselves so
// it is on only around an actual touch, not for periodic background
// refreshes. -1 means "not yet captured" (before the first startup read).
// volatile: written by the main thread and by the touch-watcher thread
// (turnOffFrontlightIfIdle), so neither side may cache them in a register.
volatile int g_frontlight_saved_level = -1;
volatile int g_frontlight_is_on = 0;
const int kFrontlightFallbackLevel = 10;
const long long kFrontlightIdleTimeoutMs = 20000;
void wakeFrontlightOnTouch();  // defined near returnToKindleHome(), used by applyTouchWithDebounce() below
void stopTouchWatcher();       // defined with startTouchWatcher(); must run before any frontlight restore

// CLOCK_MONOTONIC, not gettimeofday(): this clock gates the touch debounce, so a wall-clock
// correction (NTP after a wake from sleep, RTC drift) jumping backwards would make every
// elapsed-time check go negative and silently swallow input until wall time caught back up.
// Every caller uses this for deltas only, never for a real date, so monotonic is correct
// everywhere it is used.
long long monotonicMs() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<long long>(ts.tv_sec) * 1000LL + static_cast<long long>(ts.tv_nsec / 1000000);
}

void copyText(char* dest, size_t size, const char* source) {
  if (size == 0) return;
  if (!source) source = "";
  snprintf(dest, size, "%s", source);
}

char* readFile(const char* path) {
  FILE* file = fopen(path, "rb");
  if (!file) return NULL;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long size = ftell(file);
  if (size < 0 || size > kMaxDashboardPayloadBytes) {
    fclose(file);
    return NULL;
  }
  rewind(file);
  char* data = static_cast<char*>(calloc(static_cast<size_t>(size) + 1, 1));
  if (!data) {
    fclose(file);
    return NULL;
  }
  if (fread(data, 1, static_cast<size_t>(size), file) != static_cast<size_t>(size)) {
    free(data);
    fclose(file);
    return NULL;
  }
  fclose(file);
  return data;
}

const char* skipWhitespace(const char* cursor) {
  while (cursor && *cursor && isspace(static_cast<unsigned char>(*cursor))) cursor++;
  return cursor;
}

const char* findKeyInRange(const char* start, const char* end, const char* key) {
  char pattern[80];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  const size_t pattern_len = strlen(pattern);
  const char* cursor = start;
  while (cursor && (!end || cursor + pattern_len <= end)) {
    cursor = strstr(cursor, pattern);
    if (!cursor || (end && cursor + pattern_len > end)) return NULL;
    const char* colon = skipWhitespace(cursor + pattern_len);
    if (*colon == ':') return skipWhitespace(colon + 1);
    cursor += pattern_len;
  }
  return NULL;
}

int parseJsonString(const char* cursor, char* out, size_t out_size, const char** after) {
  cursor = skipWhitespace(cursor);
  if (!cursor || *cursor != '"') return 0;
  cursor++;
  size_t length = 0;
  while (*cursor && *cursor != '"') {
    char ch = *cursor++;
    if (ch == '\\') {
      ch = *cursor++;
      if (ch == 'n') ch = ' ';
      else if (ch == 'r') ch = ' ';
      else if (ch == 't') ch = ' ';
      else if (ch == 'u') {
        ch = '?';
        for (int i = 0; i < 4 && *cursor; i++) cursor++;
      }
    }
    if (length + 1 < out_size) out[length++] = ch;
  }
  if (*cursor != '"') return 0;
  if (out_size > 0) out[length] = '\0';
  if (after) *after = cursor + 1;
  return 1;
}

void jsonEscapeString(const char* input, char* out, size_t out_size) {
  if (!out || out_size == 0) return;
  if (!input) input = "";
  size_t written = 0;
  for (const char* cursor = input; *cursor && written + 1 < out_size; cursor++) {
    const unsigned char ch = static_cast<unsigned char>(*cursor);
    const char* replacement = NULL;
    if (ch == '\\') replacement = "\\\\";
    else if (ch == '"') replacement = "\\\"";
    else if (ch == '\n') replacement = "\\n";
    else if (ch == '\r') replacement = "\\r";
    else if (ch == '\t') replacement = "\\t";

    if (replacement) {
      for (const char* r = replacement; *r && written + 1 < out_size; r++) out[written++] = *r;
    } else if (ch >= 0x20) {
      out[written++] = static_cast<char>(ch);
    }
  }
  out[written] = '\0';
}

int extractString(const char* start, const char* end, const char* key, char* out, size_t out_size, const char* fallback) {
  const char* value = findKeyInRange(start, end, key);
  if (value && strncmp(value, "null", 4) == 0) value = NULL;
  if (value && parseJsonString(value, out, out_size, NULL)) return 1;
  copyText(out, out_size, fallback);
  return 0;
}

int extractInt(const char* start, const char* end, const char* key, int fallback) {
  const char* value = findKeyInRange(start, end, key);
  if (!value) return fallback;
  return static_cast<int>(strtol(value, NULL, 10));
}

int extractBool(const char* start, const char* end, const char* key, int fallback) {
  const char* value = findKeyInRange(start, end, key);
  if (!value) return fallback;
  if (strncmp(value, "true", 4) == 0) return 1;
  if (strncmp(value, "false", 5) == 0) return 0;
  return fallback;
}

const char* matchingClose(const char* open, char close_char) {
  const char open_char = *open;
  int depth = 0;
  int in_string = 0;
  int escaped = 0;
  for (const char* cursor = open; *cursor; cursor++) {
    const char ch = *cursor;
    if (in_string) {
      if (escaped) escaped = 0;
      else if (ch == '\\') escaped = 1;
      else if (ch == '"') in_string = 0;
      continue;
    }
    if (ch == '"') {
      in_string = 1;
      continue;
    }
    if (ch == open_char) depth++;
    else if (ch == close_char) {
      depth--;
      if (depth == 0) return cursor;
    }
  }
  return NULL;
}

int parseItems(const char* list_start, const char* list_end, List* list) {
  const char* items_value = findKeyInRange(list_start, list_end, "items");
  if (!items_value || *items_value != '[') return 0;
  const char* items_end = matchingClose(items_value, ']');
  if (!items_end || items_end > list_end) return 0;

  const char* cursor = items_value + 1;
  while (cursor < items_end && list->item_count < kMaxItems) {
    const char* object_start = strchr(cursor, '{');
    if (!object_start || object_start >= items_end) break;
    const char* object_end = matchingClose(object_start, '}');
    if (!object_end || object_end > items_end) break;

    Item* item = &list->items[list->item_count];
    extractString(object_start, object_end, "id", item->id, sizeof(item->id), "");
    extractString(object_start, object_end, "text", item->text, sizeof(item->text), "");
    item->done = extractBool(object_start, object_end, "done", 0);
    if (item->text[0]) list->item_count++;
    cursor = object_end + 1;
  }
  return 1;
}

void parseWeather(const char* json, Dashboard* dashboard) {
  Weather* weather = &dashboard->weather;
  copyText(weather->condition_label, sizeof(weather->condition_label), "UNKNOWN");

  const char* weather_value = findKeyInRange(json, NULL, "weather");
  if (!weather_value || *weather_value != '{') return;
  const char* weather_end = matchingClose(weather_value, '}');
  if (!weather_end) return;

  weather->available = extractBool(weather_value, weather_end, "available", 0);
  weather->temperature_c = extractInt(weather_value, weather_end, "temperature_c", 0);
  weather->feels_like_c = extractInt(weather_value, weather_end, "feels_like_c", 0);
  weather->high_c = extractInt(weather_value, weather_end, "high_c", 0);
  weather->low_c = extractInt(weather_value, weather_end, "low_c", 0);
  weather->precipitation_probability = extractInt(weather_value, weather_end, "precipitation_probability", 0);
  weather->wind_kph = extractInt(weather_value, weather_end, "wind_kph", 0);
  extractString(weather_value, weather_end, "condition_label", weather->condition_label, sizeof(weather->condition_label), "UNKNOWN");
}

void parseAgenda(const char* json, Dashboard* dashboard) {
  const char* agenda_value = findKeyInRange(json, NULL, "agenda");
  if (!agenda_value || *agenda_value != '{') return;
  const char* agenda_end = matchingClose(agenda_value, '}');
  if (!agenda_end) return;

  dashboard->agenda_available = extractBool(agenda_value, agenda_end, "available", 0);

  const char* events_value = findKeyInRange(agenda_value, agenda_end, "events");
  if (!events_value || *events_value != '[') return;
  const char* events_end = matchingClose(events_value, ']');
  if (!events_end || events_end > agenda_end) return;

  const char* cursor = events_value + 1;
  while (cursor < events_end && dashboard->agenda_event_count < kMaxAgendaEvents) {
    const char* object_start = strchr(cursor, '{');
    if (!object_start || object_start >= events_end) break;
    const char* object_end = matchingClose(object_start, '}');
    if (!object_end || object_end > events_end) break;

    AgendaEvent* event = &dashboard->agenda_events[dashboard->agenda_event_count];
    extractString(object_start, object_end, "uid", event->uid, sizeof(event->uid), "");
    extractString(object_start, object_end, "title", event->title, sizeof(event->title), "");
    extractString(object_start, object_end, "start", event->start, sizeof(event->start), "");
    extractString(object_start, object_end, "location", event->location, sizeof(event->location), "");
    event->all_day = extractBool(object_start, object_end, "all_day", 0);
    if (event->title[0] && event->start[0]) dashboard->agenda_event_count++;
    cursor = object_end + 1;
  }
}

int parseDashboard(const char* json, Dashboard* dashboard) {
  memset(dashboard, 0, sizeof(*dashboard));

  if (!json || !extractBool(json, NULL, "ok", 0)) return 0;
  extractString(json, NULL, "generated_at", dashboard->generated_at, sizeof(dashboard->generated_at), "unknown");
  extractString(json, NULL, "version", dashboard->version, sizeof(dashboard->version), "");

  parseWeather(json, dashboard);
  parseAgenda(json, dashboard);

  const char* lists_value = findKeyInRange(json, NULL, "lists");
  if (!lists_value || *lists_value != '[') return 1;
  const char* lists_end = matchingClose(lists_value, ']');
  if (!lists_end) return 1;

  const char* cursor = lists_value + 1;
  while (cursor < lists_end && dashboard->list_count < kMaxLists) {
    const char* object_start = strchr(cursor, '{');
    if (!object_start || object_start >= lists_end) break;
    const char* object_end = matchingClose(object_start, '}');
    if (!object_end || object_end > lists_end) break;

    List* list = &dashboard->lists[dashboard->list_count];
    extractString(object_start, object_end, "key", list->key, sizeof(list->key), "");
    extractString(object_start, object_end, "title", list->title, sizeof(list->title), list->key);
    parseItems(object_start, object_end, list);
    if (list->key[0] || list->title[0]) dashboard->list_count++;
    cursor = object_end + 1;
  }
  return 1;
}

void freeDashboard(Dashboard* dashboard) {
  (void)dashboard;
}

void fit(char* line) {
  size_t length = strlen(line);
  for (size_t i = 0; i < length; i++) {
    if (line[i] == '\n' || line[i] == '\r' || line[i] == '\t') line[i] = ' ';
  }
  if (length > static_cast<size_t>(kScreenColumns)) {
    line[kScreenColumns - 3] = '.';
    line[kScreenColumns - 2] = '.';
    line[kScreenColumns - 1] = '.';
    line[kScreenColumns] = '\0';
  }
}

void upperCopy(char* dest, size_t size, const char* source) {
  copyText(dest, size, source);
  for (size_t i = 0; dest[i]; i++) dest[i] = static_cast<char>(toupper(static_cast<unsigned char>(dest[i])));
}

void formatNumber(int value, char* out, size_t size) {
  char raw[32];
  snprintf(raw, sizeof(raw), "%d", value);
  const int len = static_cast<int>(strlen(raw));
  int commas = (len - 1) / 3;
  int out_len = len + commas;
  if (out_len + 1 > static_cast<int>(size)) {
    copyText(out, size, raw);
    return;
  }
  out[out_len] = '\0';
  int group = 0;
  for (int i = len - 1, j = out_len - 1; i >= 0; i--, j--) {
    if (group == 3) {
      out[j--] = ',';
      group = 0;
    }
    out[j] = raw[i];
    group++;
  }
}

// On-screen text is Brazilian Portuguese without accents: the 5x7 bitmap font
// only has A-Z. Internal status strings stay English (they also go to the log)
// and are translated only here, at display time.
const char* displayStatus(const char* status) {
  if (!status) return "?";
  if (strcmp(status, "live") == 0) return "AO VIVO";
  if (strcmp(status, "cached/offline") == 0) return "OFFLINE";
  if (strcmp(status, "cached/local") == 0) return "CACHE";
  if (strcmp(status, "fixture") == 0) return "EXEMPLO";
  return status;
}

// condition_label keeps kindle-dashboard-data.ts's English vocabulary, which
// drawWeatherIcon() matches on; only the printed label is translated.
const char* displayCondition(const char* label) {
  if (strcmp(label, "CLEAR") == 0) return "CEU LIMPO";
  if (strcmp(label, "CLOUDY") == 0) return "NUBLADO";
  if (strcmp(label, "FOG") == 0) return "NEBLINA";
  if (strcmp(label, "DRIZZLE") == 0) return "GAROA";
  if (strcmp(label, "RAIN") == 0) return "CHUVA";
  if (strcmp(label, "SNOW") == 0) return "NEVE";
  if (strcmp(label, "SHOWERS") == 0) return "PANCADAS";
  if (strcmp(label, "STORM") == 0) return "TEMPESTADE";
  if (strcmp(label, "UNKNOWN") == 0) return "--";
  return label;
}

void formatDisplayDate(const char* iso, const char* status, char* out, size_t size) {
  static const char* months[] = {"JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"};
  static const char* weekdays[] = {"DOMINGO", "SEGUNDA", "TERCA", "QUARTA", "QUINTA", "SEXTA", "SABADO"};
  int year = 0;
  int month = 0;
  int day = 0;
  if (!iso || sscanf(iso, "%4d-%2d-%2d", &year, &month, &day) != 3 || month < 1 || month > 12 || day < 1 || day > 31) {
    snprintf(out, size, "SEM DATA // %s", displayStatus(status));
    return;
  }

  int y = year;
  int m = month;
  if (m < 3) {
    m += 12;
    y--;
  }
  const int k = y % 100;
  const int j = y / 100;
  const int h = (day + (13 * (m + 1)) / 5 + k + k / 4 + j / 4 + 5 * j) % 7;
  const int weekday = (h + 6) % 7;
  snprintf(out, size, "%s, %d %s // %s", weekdays[weekday], day, months[month - 1], displayStatus(status));
}

void addLine(char lines[][96], int* count, const char* text) {
  if (*count >= kMaxRows) return;
  copyText(lines[*count], 96, text);
  fit(lines[*count]);
  (*count)++;
}

void addRule(char lines[][96], int* count) {
  addLine(lines, count, "+--------------------------------------+");
}

void addCardText(char lines[][96], int* count, const char* text) {
  char line[96];
  char clipped[64];
  copyText(clipped, sizeof(clipped), text);
  clipped[kCardInnerWidth] = '\0';
  snprintf(line, sizeof(line), "| %-36s |", clipped);
  addLine(lines, count, line);
}

void addCardPair(char lines[][96], int* count, const char* left, const char* right) {
  char left_clipped[32];
  char right_clipped[24];
  copyText(left_clipped, sizeof(left_clipped), left);
  copyText(right_clipped, sizeof(right_clipped), right);
  left_clipped[27] = '\0';
  right_clipped[8] = '\0';
  char line[96];
  snprintf(line, sizeof(line), "| %-27.27s %8.8s |", left_clipped, right_clipped);
  addLine(lines, count, line);
}

void addSectionTitle(char lines[][96], int* count, const char* title) {
  char upper[48];
  upperCopy(upper, sizeof(upper), title);
  char text[64];
  snprintf(text, sizeof(text), " %s", upper);
  addCardText(lines, count, text);
}

void addMetric(char lines[][96], int* count, const char* label, int value, int target, const char* unit) {
  const int percent = target > 0 ? (value * 100) / target : 0;
  const int clamped = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
  const int filled = (clamped * 14) / 100;
  char bar[20];
  for (int i = 0; i < 14; i++) bar[i] = i < filled ? '#' : '.';
  bar[14] = '\0';

  char value_text[32];
  char target_text[32];
  formatNumber(value, value_text, sizeof(value_text));
  formatNumber(target, target_text, sizeof(target_text));
  char left[40];
  char right[24];
  snprintf(left, sizeof(left), "%s %s/%s %s", label, value_text, target_text, unit);
  snprintf(right, sizeof(right), "%d%%", clamped);
  addCardPair(lines, count, left, right);

  char progress[64];
  snprintf(progress, sizeof(progress), " [%s]", bar);
  addCardText(lines, count, progress);
}

const char* displayListTitle(const List* list);
const char* displayListTitleForIndex(const List* list, int list_index);

void addList(char lines[][96], int* count, const List* list) {
  char title[48];
  copyText(title, sizeof(title), displayListTitle(list));
  addSectionTitle(lines, count, title);

  if (list->item_count == 0) {
    addCardText(lines, count, " [ ] Vazia");
    addRule(lines, count);
    return;
  }

  const int shown = list->item_count > 4 ? 4 : list->item_count;
  for (int i = 0; i < shown; i++) {
    char line[96];
    snprintf(line, sizeof(line), " %s %.30s", list->items[i].done ? "[x]" : "[ ]", list->items[i].text);
    addCardText(lines, count, line);
  }
  if (list->item_count > shown) {
    char more[48];
    snprintf(more, sizeof(more), " ... +%d itens", list->item_count - shown);
    addCardText(lines, count, more);
  }
  addRule(lines, count);
}

int renderLines(const Dashboard* dashboard, const char* status, char lines[][96]) {
  int count = 0;
  addRule(lines, &count);
  addCardText(lines, &count, " PAINEL KINDLE");
  char sync[64];
  snprintf(sync, sizeof(sync), " Sinc %.16s", dashboard->generated_at[0] ? dashboard->generated_at : "?");
  addCardText(lines, &count, sync);
  char mode[64];
  snprintf(mode, sizeof(mode), " Modo %s", displayStatus(status));
  addCardText(lines, &count, mode);
  addRule(lines, &count);
  addSectionTitle(lines, &count, "Clima");
  if (dashboard->weather.available) {
    addMetric(lines, &count, "CHUVA", dashboard->weather.precipitation_probability, 100, "%");
    char weather_line[64];
    snprintf(weather_line, sizeof(weather_line), " Agora %dC MAX%d MIN%d %s", dashboard->weather.temperature_c,
             dashboard->weather.high_c, dashboard->weather.low_c, displayCondition(dashboard->weather.condition_label));
    addCardText(lines, &count, weather_line);
  } else {
    addCardText(lines, &count, " Clima indisponivel");
  }
  addRule(lines, &count);
  addSectionTitle(lines, &count, "Agenda");
  if (!dashboard->agenda_available) {
    addCardText(lines, &count, " Agenda indisponivel");
  } else if (dashboard->agenda_event_count == 0) {
    addCardText(lines, &count, " Nenhum evento");
  } else {
    const int shown = dashboard->agenda_event_count > 4 ? 4 : dashboard->agenda_event_count;
    for (int i = 0; i < shown; i++) {
      char event_line[96];
      snprintf(event_line, sizeof(event_line), " %.16s %.30s", dashboard->agenda_events[i].start, dashboard->agenda_events[i].title);
      addCardText(lines, &count, event_line);
    }
  }
  addRule(lines, &count);
  for (int i = 0; i < dashboard->list_count; i++) addList(lines, &count, &dashboard->lists[i]);
  addCardText(lines, &count, " Atualize pelo Telegram");
  addRule(lines, &count);
  return count;
}

void clearCanvas(Canvas* canvas, unsigned char color) {
  if (!canvas || !canvas->pixels) return;
  memset(canvas->pixels, color, static_cast<size_t>(canvas->width) * static_cast<size_t>(canvas->height));
}

void setPixel(Canvas* canvas, int x, int y, unsigned char color) {
  if (!canvas || !canvas->pixels) return;
  if (x < 0 || y < 0 || x >= canvas->width || y >= canvas->height) return;
  canvas->pixels[y * canvas->width + x] = color;
}

void fillRect(Canvas* canvas, int x, int y, int w, int h, unsigned char color) {
  for (int yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= canvas->height) continue;
    for (int xx = x; xx < x + w; xx++) setPixel(canvas, xx, yy, color);
  }
}

// --- HUD chrome ------------------------------------------------------------
// The panels are framed as HUD brackets rather than plain rectangles: a
// hairline border, heavy L-corners, and the top-right corner cut off at 45
// degrees. Every box keeps its exact bounding rect, so the layout and the touch
// regions computed from the same numbers are untouched.
//
// Deliberately still two-tone. The obvious way to sell "cyberpunk" would be
// mid-grey glows and gradients, but e-ink renders greys by dithering and pays
// for them with a slower, ghost-prone refresh - so the look has to come from
// geometry, which costs nothing on this display.
const int kHudEdge = 2;      // hairline border thickness
const int kHudBracket = 4;   // corner bracket thickness
const int kHudCorner = 28;   // how far a bracket runs along each edge
const int kHudNotch = 16;    // 45-degree cut on the top-right corner

// The full-size kHud* triple above is for tiles; buttons and rows scale it
// down. Named rather than left as matching literals at each call site, since
// that's what let the two only-nearly-matching versions of the photo-tile
// carve (fixed with clampHudNotch()) go unnoticed for as long as they did.
const int kHudCornerButton = 14;
const int kHudNotchButton = 10;
const int kHudCornerSmallButton = 12;
const int kHudNotchSmallButton = 8;
const int kHudCornerRow = 16;
const int kHudNotchRow = 12;

void hLine(Canvas* canvas, int x0, int x1, int y, int thickness, unsigned char color) {
  if (x1 < x0) { const int swap = x0; x0 = x1; x1 = swap; }
  fillRect(canvas, x0, y, x1 - x0 + 1, thickness, color);
}

void dashedHLine(Canvas* canvas, int x0, int x1, int y, int dash, int gap, int thickness, unsigned char color) {
  for (int x = x0; x <= x1; x += dash + gap) {
    const int end = x + dash - 1 < x1 ? x + dash - 1 : x1;
    hLine(canvas, x, end, y, thickness, color);
  }
}

// A 45-degree chamfer drawn as a staircase of small squares. fillTriangle/line
// would do it too, but both are defined further down and neither is needed for
// a diagonal this short.
void chamfer(Canvas* canvas, int x, int y, int size, int thickness, unsigned char color) {
  for (int i = 0; i < size; i++) fillRect(canvas, x + i, y + i, thickness, thickness, color);
}

// Shared by hudFrame() and anything that fills all the way to a tile's edge
// and needs to carve the same top-right cut out of its own fill (the photo
// tile's bitmap, the title tab's background). Centralizing the clamp is what
// keeps a carved fill and hudFrame's own cut corner from disagreeing on
// whether a small box even has one.
int clampHudNotch(int w, int h, int notch) {
  return (notch * 2 > w || notch * 2 > h) ? 0 : notch;
}

// 45-degree staircase carve, one setPixel-row at a time via fillRect. Used to
// cut the same corner out of a fill that hudFrame() is about to frame, so the
// two corners line up instead of a diagonal frame sitting on a square fill.
void carveTopRightNotch(Canvas* canvas, int x, int y, int w, int h, int notch, unsigned char fill_color) {
  notch = clampHudNotch(w, h, notch);
  for (int i = 0; i < notch; i++) fillRect(canvas, x + w - notch + i, y + i, notch - i, 1, fill_color);
}

void hudFrame(Canvas* canvas, int x, int y, int w, int h, int edge, int corner, int notch, unsigned char color) {
  if (w <= 0 || h <= 0) return;
  notch = clampHudNotch(w, h, notch);
  if (corner * 2 > w) corner = w / 2;
  if (corner * 2 > h) corner = h / 2;

  fillRect(canvas, x, y, w - notch, edge, color);                    // top, stopping at the cut
  fillRect(canvas, x, y + h - edge, w, edge, color);                 // bottom
  fillRect(canvas, x, y, edge, h, color);                            // left
  fillRect(canvas, x + w - edge, y + notch, edge, h - notch, color); // right, starting below the cut
  if (notch > 0) chamfer(canvas, x + w - notch, y, notch, edge, color);

  const int b = kHudBracket;
  fillRect(canvas, x, y, corner, b, color);                          // top-left
  fillRect(canvas, x, y, b, corner, color);
  fillRect(canvas, x, y + h - b, corner, b, color);                  // bottom-left
  fillRect(canvas, x, y + h - corner, b, corner, color);
  fillRect(canvas, x + w - corner, y + h - b, corner, b, color);     // bottom-right
  fillRect(canvas, x + w - b, y + h - corner, b, corner, color);
  fillRect(canvas, x + w - notch - corner, y, corner, b, color);     // top-right, split by the cut
  fillRect(canvas, x + w - b, y + notch, b, corner, color);
}

// The rule under a panel title: solid where it leaves the frame, then dashed
// out to the far edge, with a tick at each end. Reads as a HUD scale rather
// than a plain divider, and still costs a single row of pixels.
void hudRail(Canvas* canvas, int x0, int x1, int y, unsigned char color) {
  if (x1 <= x0) return;
  const int solid = (x1 - x0) / 5;
  hLine(canvas, x0, x0 + solid, y, 2, color);
  dashedHLine(canvas, x0 + solid + 9, x1, y, 11, 7, 2, color);
  fillRect(canvas, x0, y - 5, 2, 12, color);
  fillRect(canvas, x1 - 1, y - 5, 2, 12, color);
}

void doubleRect(Canvas* canvas, int x, int y, int w, int h, unsigned char color) {
  hudFrame(canvas, x, y, w, h, 3, kHudCorner, kHudNotch, color);
  // The inner border used to be a second solid rectangle, which just read as a
  // thicker edge. Dashed, and only top and bottom, it reads as panel lining.
  dashedHLine(canvas, x + 9, x + w - 10, y + 8, 12, 7, 2, color);
  dashedHLine(canvas, x + 9, x + w - 10, y + h - 10, 12, 7, 2, color);
}

void line(Canvas* canvas, int x0, int y0, int x1, int y1, int thickness, unsigned char color) {
  const int dx = abs(x1 - x0);
  const int sx = x0 < x1 ? 1 : -1;
  const int dy = -abs(y1 - y0);
  const int sy = y0 < y1 ? 1 : -1;
  int err = dx + dy;
  while (1) {
    fillRect(canvas, x0 - thickness / 2, y0 - thickness / 2, thickness, thickness, color);
    if (x0 == x1 && y0 == y1) break;
    const int e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

void fillCircle(Canvas* canvas, int cx, int cy, int r, unsigned char color) {
  for (int dy = -r; dy <= r; dy++) {
    const int half = static_cast<int>(sqrt(static_cast<double>(r * r - dy * dy)));
    fillRect(canvas, cx - half, cy + dy, half * 2 + 1, 1, color);
  }
}

// Small filled triangle via a bounding-box scan + sign test on each edge - fine for icon-sized
// shapes (a few thousand pixels at most), no need for a proper scanline rasterizer here.
void fillTriangle(Canvas* canvas, int x0, int y0, int x1, int y1, int x2, int y2, unsigned char color) {
  int min_x = x0 < x1 ? x0 : x1; if (x2 < min_x) min_x = x2;
  int max_x = x0 > x1 ? x0 : x1; if (x2 > max_x) max_x = x2;
  int min_y = y0 < y1 ? y0 : y1; if (y2 < min_y) min_y = y2;
  int max_y = y0 > y1 ? y0 : y1; if (y2 > max_y) max_y = y2;
  auto sign = [](int px, int py, int ax, int ay, int bx, int by) {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
  };
  for (int y = min_y; y <= max_y; y++) {
    for (int x = min_x; x <= max_x; x++) {
      const int d0 = sign(x, y, x0, y0, x1, y1);
      const int d2 = sign(x, y, x1, y1, x2, y2);
      const int d3 = sign(x, y, x2, y2, x0, y0);
      const int has_neg = (d0 < 0) || (d2 < 0) || (d3 < 0);
      const int has_pos = (d0 > 0) || (d2 > 0) || (d3 > 0);
      if (!(has_neg && has_pos)) setPixel(canvas, x, y, color);
    }
  }
}

unsigned char glyphRow(char ch, int row) {
  static const unsigned char digits[10][7] = {
    {14, 17, 19, 21, 25, 17, 14}, {4, 12, 4, 4, 4, 4, 14}, {14, 17, 1, 2, 4, 8, 31}, {30, 1, 1, 14, 1, 1, 30}, {2, 6, 10, 18, 31, 2, 2},
    {31, 16, 30, 1, 1, 17, 14}, {6, 8, 16, 30, 17, 17, 14}, {31, 1, 2, 4, 8, 8, 8}, {14, 17, 17, 14, 17, 17, 14}, {14, 17, 17, 15, 1, 2, 12}
  };
  static const unsigned char letters[26][7] = {
    {14,17,17,31,17,17,17},{30,17,17,30,17,17,30},{14,17,16,16,16,17,14},{30,17,17,17,17,17,30},{31,16,16,30,16,16,31},{31,16,16,30,16,16,16},
    {14,17,16,23,17,17,14},{17,17,17,31,17,17,17},{14,4,4,4,4,4,14},{7,2,2,2,18,18,12},{17,18,20,24,20,18,17},{16,16,16,16,16,16,31},
    {17,27,21,21,17,17,17},{17,25,21,19,17,17,17},{14,17,17,17,17,17,14},{30,17,17,30,16,16,16},{14,17,17,17,21,18,13},{30,17,17,30,20,18,17},
    {15,16,16,14,1,1,30},{31,4,4,4,4,4,4},{17,17,17,17,17,17,14},{17,17,17,17,17,10,4},{17,17,17,21,21,21,10},{17,17,10,4,10,17,17},
    {17,17,10,4,4,4,4},{31,1,2,4,8,16,31}
  };
  if (ch >= '0' && ch <= '9') return digits[ch - '0'][row];
  if (ch >= 'a' && ch <= 'z') ch = static_cast<char>(ch - 'a' + 'A');
  if (ch >= 'A' && ch <= 'Z') return letters[ch - 'A'][row];
  switch (ch) {
    case ' ': return 0;
    case '/': { static const unsigned char g[7] = {1,1,2,4,8,16,16}; return g[row]; }
    case ':': { static const unsigned char g[7] = {0,4,4,0,4,4,0}; return g[row]; }
    case '-': { static const unsigned char g[7] = {0,0,0,31,0,0,0}; return g[row]; }
    case '_': { static const unsigned char g[7] = {0,0,0,0,0,0,31}; return g[row]; }
    case '.': { static const unsigned char g[7] = {0,0,0,0,0,12,12}; return g[row]; }
    case ',': { static const unsigned char g[7] = {0,0,0,0,0,4,8}; return g[row]; }
    case '%': { static const unsigned char g[7] = {17,18,4,8,19,17,0}; return g[row]; }
    case '[': { static const unsigned char g[7] = {14,8,8,8,8,8,14}; return g[row]; }
    case ']': { static const unsigned char g[7] = {14,2,2,2,2,2,14}; return g[row]; }
    case '+': { static const unsigned char g[7] = {0,4,4,31,4,4,0}; return g[row]; }
    case '|': { static const unsigned char g[7] = {4,4,4,4,4,4,4}; return g[row]; }
    case '!': { static const unsigned char g[7] = {4,4,4,4,4,0,4}; return g[row]; }
    case '#': { static const unsigned char g[7] = {10,31,10,10,31,10,0}; return g[row]; }
    default: { static const unsigned char g[7] = {31,1,2,4,4,0,4}; return g[row]; }
  }
}

int textWidth(const char* text, int scale) {
  return static_cast<int>(strlen(text ? text : "")) * 6 * scale;
}

void drawText(Canvas* canvas, int x, int y, const char* text, int scale, unsigned char color) {
  int cursor = x;
  for (size_t i = 0; text && text[i]; i++) {
    char ch = text[i];
    if (ch >= 'a' && ch <= 'z') ch = static_cast<char>(ch - 'a' + 'A');
    for (int row = 0; row < 7; row++) {
      const unsigned char bits = glyphRow(ch, row);
      for (int col = 0; col < 5; col++) {
        if (bits & (1 << (4 - col))) fillRect(canvas, cursor + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
}

void drawTextClipped(Canvas* canvas, int x, int y, int max_width, const char* text, int scale, unsigned char color) {
  char clipped[128];
  copyText(clipped, sizeof(clipped), text);
  const int max_chars = max_width / (6 * scale);
  if (max_chars > 0 && static_cast<int>(strlen(clipped)) > max_chars) clipped[max_chars] = '\0';
  drawText(canvas, x, y, clipped, scale, color);
}

void drawTextCentered(Canvas* canvas, int cx, int y, int max_width, const char* text, int scale, unsigned char color) {
  char clipped[128];
  copyText(clipped, sizeof(clipped), text);
  const int max_chars = max_width / (6 * scale);
  if (max_chars > 0 && static_cast<int>(strlen(clipped)) > max_chars) clipped[max_chars] = '\0';
  drawText(canvas, cx - textWidth(clipped, scale) / 2, y, clipped, scale, color);
}

// Panel titles sit in a filled tab with a cut corner, reversed out of the ink,
// instead of floating as plain centred text. Same centre and same baseline as
// the drawTextCentered() call it replaces, so nothing below it moves.
void hudTitleTab(Canvas* canvas, int cx, int y, int max_width, const char* title, int scale) {
  char clipped[64];
  copyText(clipped, sizeof(clipped), title);
  const int pad_x = 13;
  const int max_chars = (max_width - pad_x * 2) / (6 * scale);
  if (max_chars > 0 && static_cast<int>(strlen(clipped)) > max_chars) clipped[max_chars] = '\0';

  // textWidth() counts a trailing advance the last glyph never draws into, so
  // the tab would sit visibly off-centre without dropping it.
  const int text_w = textWidth(clipped, scale) - scale;
  const int pad_y = 7;
  const int box_w = text_w + pad_x * 2;
  const int box_h = 7 * scale + pad_y * 2;
  const int box_x = cx - box_w / 2;
  const int box_y = y - pad_y;
  const int notch = box_h / 2;

  fillRect(canvas, box_x, box_y, box_w, box_h, 0);
  carveTopRightNotch(canvas, box_x, box_y, box_w, box_h, notch, 255);
  drawText(canvas, box_x + pad_x, y, clipped, scale, 255);
}

// Skips the top kKindleStatusBarHeight rows: on the real device that strip is
// the Kindle OS's own status bar, never drawn to by this renderer (it stays
// at clearCanvas()'s 255) and never written to the framebuffer either
// (renderToFramebuffer() starts its pixel loop below it). Inverting it here
// would only matter for --dump-pgm/--save-pgm/--render previews, and would
// make them show a black strip that never appears on the device - the
// opposite of what those previews are for.
void invertCanvas(Canvas* canvas) {
  if (!canvas || !canvas->pixels) return;
  const int start_y = canvas->height > kKindleStatusBarHeight ? kKindleStatusBarHeight : 0;
  for (int y = start_y; y < canvas->height; y++) {
    unsigned char* row = canvas->pixels + static_cast<size_t>(y) * static_cast<size_t>(canvas->width);
    for (int x = 0; x < canvas->width; x++) row[x] = static_cast<unsigned char>(255 - row[x]);
  }
}

const char* displayListTitle(const List* list) {
  if (!list) return "";
  if (strcmp(list->key, "todo") == 0) return "TAREFAS";
  if (strcmp(list->key, "grocery") == 0) return "COMPRAS";
  if (strcmp(list->key, "notes") == 0) return "NOTAS";
  return list->title[0] ? list->title : list->key;
}

const char* displayListTitleForIndex(const List* list, int list_index) {
  // Fixed order sent by kindle-dashboard-data.ts: [todo, grocery, notes].
  if (list_index == 0) return "TAREFAS";
  if (list_index == 1) return "COMPRAS";
  if (list_index == 2) return "NOTAS";
  return displayListTitle(list);
}

Rect exitButtonRectForScreen(int width, int height);
Rect lockButtonRectForScreen(int width, int height);
void drawExitAndLockButtons(Canvas* canvas, int width, int height);
void drawBitmapDashboard(Canvas* canvas, const Dashboard* dashboard, const char* status);
void clearTouchRegions();
void addTouchRegion(Rect rect, TouchAction action, int list_index, int item_index, const char* item_id, int item_done);

// `start` is "YYYY-MM-DDTHH:MM:SS±HH:MM", already converted to local wall-clock
// time by the backend's toLocalIsoString() (the offset itself is local, but
// the date/hour/minute digits are what should be displayed as-is — the native
// renderer has no timezone tables of its own).
void agendaEventDateTime(const AgendaEvent* event, char* out, size_t out_size) {
  char date_part[6] = "--/--";
  if (strlen(event->start) >= 10) {
    date_part[0] = event->start[8];
    date_part[1] = event->start[9];
    date_part[2] = '/';
    date_part[3] = event->start[5];
    date_part[4] = event->start[6];
    date_part[5] = '\0';
  }
  if (event->all_day) {
    snprintf(out, out_size, "%s DIA TODO", date_part);
    return;
  }
  char clock[6] = "--:--";
  if (strlen(event->start) >= 16) {
    memcpy(clock, event->start + 11, 5);
    clock[5] = '\0';
  }
  snprintf(out, out_size, "%s %s", date_part, clock);
}

// Small pixel-art icons drawn with the existing shape primitives (no separate icon font/asset
// needed) so the weather bar can show something other than bare letters/numbers for condition,
// high/low and rain chance.
void drawArrowUp(Canvas* canvas, int cx, int cy, int size, unsigned char color) {
  const int r = size / 2;
  fillTriangle(canvas, cx, cy - r, cx - r, cy + r / 3, cx + r, cy + r / 3, color);
  fillRect(canvas, cx - r / 4, cy + r / 3, r / 2 + 1, r * 2 / 3, color);
}

void drawArrowDown(Canvas* canvas, int cx, int cy, int size, unsigned char color) {
  const int r = size / 2;
  fillTriangle(canvas, cx, cy + r, cx - r, cy - r / 3, cx + r, cy - r / 3, color);
  fillRect(canvas, cx - r / 4, cy - r, r / 2 + 1, r * 2 / 3, color);
}

void drawDroplet(Canvas* canvas, int cx, int cy, int size, unsigned char color) {
  const int r = size / 2;
  fillTriangle(canvas, cx, cy - r, cx - r * 2 / 3, cy, cx + r * 2 / 3, cy, color);
  fillCircle(canvas, cx, cy + r / 4, r * 2 / 3, color);
}

// Same solid-silhouette approach as the weather icons: a filled circle punched down to a
// semicircle (fillRect over its lower half, in the paper colour) gives the shackle's rounded top
// without an actual arc primitive. Closed has both legs seated in the body; open keeps only the
// right leg, with the whole shackle nudged right so the left side lifts clear of the body,
// leaving a visible gap - the standard flat-icon read for "unlocked" at low resolution.
void drawPadlockIcon(Canvas* canvas, int cx, int cy, int size, int locked, unsigned char color) {
  const unsigned char paper = static_cast<unsigned char>(255 - color);
  const int body_w = size;
  const int body_h = size * 11 / 16;
  const int body_x = cx - body_w / 2;
  const int body_y = cy + size / 2 - body_h;
  const int shackle_r = size * 3 / 8;
  const int leg_w = size / 6;

  if (locked) {
    const int shackle_cy = body_y - shackle_r / 2;
    fillCircle(canvas, cx, shackle_cy, shackle_r, color);
    fillRect(canvas, cx - shackle_r, shackle_cy, shackle_r * 2, shackle_r, paper);
    fillRect(canvas, cx - shackle_r, shackle_cy, leg_w, body_y - shackle_cy + 4, color);
    fillRect(canvas, cx + shackle_r - leg_w, shackle_cy, leg_w, body_y - shackle_cy + 4, color);
  } else {
    const int shift = shackle_r * 2 / 3;
    const int shackle_cy = body_y - shackle_r / 2 - leg_w;
    fillCircle(canvas, cx + shift, shackle_cy, shackle_r, color);
    fillRect(canvas, cx + shift - shackle_r, shackle_cy, shackle_r * 2, shackle_r, paper);
    fillRect(canvas, cx + shift + shackle_r - leg_w, shackle_cy, leg_w, body_y - shackle_cy + 4, color);
    fillRect(canvas, cx + shift - shackle_r, shackle_cy, leg_w, shackle_r * 2 / 3, color);
  }

  fillRect(canvas, body_x, body_y, body_w, body_h, color);
  const int hole_r = size / 7;
  fillCircle(canvas, cx, body_y + hole_r + 3, hole_r, paper);
  fillRect(canvas, cx - 2, body_y + hole_r + 3, 4, body_h - hole_r - 7, paper);
}

// Solid-silhouette style icons (filled shapes, no outline detail) since that reads clearly at
// small sizes on e-ink. condition_label comes from kindle-dashboard-data.ts's fixed vocabulary:
// CLEAR/CLOUDY/FOG/DRIZZLE/RAIN/SNOW/SHOWERS/STORM/UNKNOWN.
void drawWeatherIcon(Canvas* canvas, int cx, int cy, int size, const char* condition_label) {
  const int r = size / 2;
  if (strcmp(condition_label, "CLEAR") == 0) {
    fillCircle(canvas, cx, cy, r * 3 / 5, 0);
    for (int i = 0; i < 8; i++) {
      const double angle = i * (M_PI / 4.0);
      const int x0 = cx + static_cast<int>(cos(angle) * r * 0.72);
      const int y0 = cy + static_cast<int>(sin(angle) * r * 0.72);
      const int x1 = cx + static_cast<int>(cos(angle) * r);
      const int y1 = cy + static_cast<int>(sin(angle) * r);
      line(canvas, x0, y0, x1, y1, 3, 0);
    }
    return;
  }

  const int cloud_cy = cy + r / 6;
  fillCircle(canvas, cx - r * 3 / 8, cloud_cy, r * 3 / 8, 0);
  fillCircle(canvas, cx + r / 8, cloud_cy - r / 6, r / 2, 0);
  fillCircle(canvas, cx + r * 5 / 8, cloud_cy, r * 3 / 8, 0);
  fillRect(canvas, cx - r * 3 / 4, cloud_cy, r * 3 / 2, r / 3, 0);

  if (strstr(condition_label, "RAIN") || strstr(condition_label, "DRIZZLE") || strstr(condition_label, "SHOWER")) {
    for (int i = -1; i <= 1; i++) {
      const int x0 = cx + i * r / 3;
      line(canvas, x0, cy + r / 3, x0 - r / 8, cy + r, 3, 0);
    }
  } else if (strstr(condition_label, "SNOW")) {
    for (int i = -1; i <= 1; i++) {
      const int mx = cx + i * r / 3;
      const int my = cy + r * 3 / 5;
      line(canvas, mx - 6, my, mx + 6, my, 2, 0);
      line(canvas, mx, my - 6, mx, my + 6, 2, 0);
      line(canvas, mx - 5, my - 5, mx + 5, my + 5, 2, 0);
      line(canvas, mx - 5, my + 5, mx + 5, my - 5, 2, 0);
    }
  } else if (strstr(condition_label, "STORM")) {
    line(canvas, cx + 4, cy + r / 3, cx - 6, cy + r * 2 / 3, 4, 0);
    line(canvas, cx - 6, cy + r * 2 / 3, cx + 6, cy + r * 2 / 3, 4, 0);
    line(canvas, cx + 6, cy + r * 2 / 3, cx - 4, cy + r, 4, 0);
  } else if (strcmp(condition_label, "FOG") == 0) {
    for (int i = 0; i < 3; i++) line(canvas, cx - r, cy + r / 2 + i * 10, cx + r, cy + r / 2 + i * 10, 3, 0);
  }
  // CLOUDY/UNKNOWN: the cloud silhouette alone is enough, nothing extra to add.
}

// Replaces the old header ("DAILY OPS" title) + separate WEATHER quadrant with a single top bar:
// icon + big temperature on the left, small icon+value stats (high/low/rain chance) in the
// middle, EXIT on the right, generated-at/status on a second line.
void drawWeatherBar(Canvas* canvas, const Dashboard* dashboard, const char* status, int shell_x, int shell_y, int shell_w, int header_h) {
  doubleRect(canvas, shell_x + 10, shell_y + 10, shell_w - 20, header_h, 0);
  // The lock button, not EXIT, is the rightmost thing content has to clear now - it sits
  // between the header content and EXIT.
  const Rect lock_rect = lockButtonRectForScreen(canvas->width, canvas->height);
  const int text_w = lock_rect.x - shell_x - 44;

  const Weather& weather = dashboard->weather;
  const int icon_cx = shell_x + 28 + 36;
  const int icon_cy = shell_y + 24 + 34;
  if (weather.available) {
    drawWeatherIcon(canvas, icon_cx, icon_cy, 68, weather.condition_label);

    char temp[16];
    snprintf(temp, sizeof(temp), "%dC", weather.temperature_c);
    const int temp_x = shell_x + 28 + 84;
    // Scale 4, not 5: at 5 the glyphs' top row started at the same y as the frame's own
    // inner dashed rule (y+8 below the doubleRect() call above), so "24C" visibly cut
    // through it. Dropping to 4 and starting two rows lower clears the rule instead of
    // just drawing a smaller version of the same overlap.
    drawTextClipped(canvas, temp_x, shell_y + 24, text_w, temp, 4, 0);
    drawTextClipped(canvas, temp_x, shell_y + 62, 200, displayCondition(weather.condition_label), 2, 0);

    // Icon+value stat cluster (high/low/rain chance), so the numbers don't read as bare,
    // unlabeled letters - each one sits right next to the icon that explains it.
    const int stats_x = temp_x + 190;
    if (stats_x + 210 <= lock_rect.x - 12) {
      char hi[8]; snprintf(hi, sizeof(hi), "%d", weather.high_c);
      char lo[8]; snprintf(lo, sizeof(lo), "%d", weather.low_c);
      char rain[8]; snprintf(rain, sizeof(rain), "%d%%", weather.precipitation_probability);

      drawArrowUp(canvas, stats_x + 10, shell_y + 30, 20, 0);
      drawTextClipped(canvas, stats_x + 26, shell_y + 20, 70, hi, 3, 0);

      drawArrowDown(canvas, stats_x + 10, shell_y + 62, 20, 0);
      drawTextClipped(canvas, stats_x + 26, shell_y + 52, 70, lo, 3, 0);

      drawDroplet(canvas, stats_x + 120, shell_y + 46, 24, 0);
      drawTextClipped(canvas, stats_x + 138, shell_y + 36, 90, rain, 3, 0);
    }
  } else {
    drawTextClipped(canvas, shell_x + 28, shell_y + 24, text_w, "CLIMA INDISP.", 4, 0);
  }

  drawExitAndLockButtons(canvas, canvas->width, canvas->height);

  hudRail(canvas, shell_x + 20, lock_rect.x - 8, shell_y + 88, 0);
  char updated[96];
  formatDisplayDate(dashboard->generated_at, status, updated, sizeof(updated));
  drawTextClipped(canvas, shell_x + 28, shell_y + 102, text_w, updated, 2, 0);
}

// Minimal binary PGM (P5) reader - matches exactly what writePgm() produces and what
// ImageMagick emits by default for a .pgm target, no ASCII/comment handling needed for our own
// asset pipeline. Returns a malloc'd grayscale buffer the caller must free(), or NULL on failure.
unsigned char* readPgmP5(const char* path, int* out_w, int* out_h) {
  FILE* file = fopen(path, "rb");
  if (!file) return NULL;
  char magic[3] = {0, 0, 0};
  int width = 0, height = 0, maxval = 0;
  if (fscanf(file, "%2s", magic) != 1 || strcmp(magic, "P5") != 0 ||
      fscanf(file, "%d %d %d", &width, &height, &maxval) != 3 ||
      width <= 0 || height <= 0 || maxval <= 0 || maxval > 255) {
    fclose(file);
    return NULL;
  }
  fgetc(file);  // single whitespace byte separating the header from the pixel data
  const size_t count = static_cast<size_t>(width) * static_cast<size_t>(height);
  unsigned char* pixels = static_cast<unsigned char*>(malloc(count));
  if (!pixels) {
    fclose(file);
    return NULL;
  }
  if (fread(pixels, 1, count, file) != count) {
    free(pixels);
    fclose(file);
    return NULL;
  }
  fclose(file);
  *out_w = width;
  *out_h = height;
  return pixels;
}

// Nearest-neighbor "cover" blit: crops src to the dest box's aspect ratio (centered) before
// scaling, so a photo of any resolution fills the tile with no letterboxing or distortion.
void drawPgmCover(Canvas* canvas, int x, int y, int w, int h, const unsigned char* src, int sw, int sh) {
  int crop_w = sw;
  int crop_h = sh;
  if (sw * h > sh * w) {
    crop_w = sh * w / h;
  } else {
    crop_h = sw * h / w;
  }
  const int crop_x0 = (sw - crop_w) / 2;
  const int crop_y0 = (sh - crop_h) / 2;
  for (int dy = 0; dy < h; dy++) {
    const int sy = crop_y0 + dy * crop_h / h;
    for (int dx = 0; dx < w; dx++) {
      const int sx = crop_x0 + dx * crop_w / w;
      const unsigned char value = src[sy * sw + sx];
      // Pre-inverted in dark mode so the whole-canvas flip at the end of
      // drawCurrentDashboard() lands it back the right way round. Without this
      // the one real image on the screen would come out as a negative.
      setPixel(canvas, x + dx, y + dy, g_dark_mode ? static_cast<unsigned char>(255 - value) : value);
    }
  }
}

void drawPhotoTile(Canvas* canvas, int x, int y, int w, int h) {
  // Consume taps here with a no-op action so applyTouchWithDebounce() doesn't fall through to
  // its mirrored/rotated coordinate guesses (see applyTouchWithDebounce) and mistakenly land on
  // whichever list card happens to overlap one of those guessed coordinates.
  Rect tile_rect = {x, y, w, h};
  addTouchRegion(tile_rect, kTouchNone, -1, -1, "", 0);

  int pw = 0, ph = 0;
  unsigned char* pixels = g_photo_path[0] ? readPgmP5(g_photo_path, &pw, &ph) : NULL;
  if (pixels) {
    const int inset = 4;
    drawPgmCover(canvas, x + inset, y + inset, w - inset * 2, h - inset * 2, pixels, pw, ph);
    free(pixels);
    // The photo is the only tile whose fill reaches the border, so the cut
    // corner has to be carved back out of it before the frame goes on top -
    // otherwise the chamfer is a diagonal line sitting on a square photo.
    // Goes through the same clamp hudFrame() itself applies, so a photo tile
    // too small for a cut corner doesn't get one carved into it anyway.
    carveTopRightNotch(canvas, x, y, w, h, kHudNotch, 255);
  } else {
    fprintf(stderr, "photo=missing path=%s\n", g_photo_path);
  }
  hudFrame(canvas, x, y, w, h, kHudEdge, kHudCorner, kHudNotch, 0);
}

void drawAgendaTile(Canvas* canvas, int x, int y, int w, int h, const Dashboard* dashboard) {
  hudFrame(canvas, x, y, w, h, kHudEdge, kHudCorner, kHudNotch, 0);
  Rect tile_rect = {x, y, w, h};
  addTouchRegion(tile_rect, kTouchNone, -1, -1, "", 0);
  hudTitleTab(canvas, x + w / 2, y + 14, w - 24, "AGENDA", 4);
  hudRail(canvas, x + 10, x + w - 10, y + 52, 0);

  if (!dashboard->agenda_available) {
    drawTextCentered(canvas, x + w / 2, y + h / 2 - 12, w - 24, "AGENDA INDISPONIVEL", 3, 0);
    return;
  }
  if (dashboard->agenda_event_count == 0) {
    drawTextCentered(canvas, x + w / 2, y + h / 2 - 12, w - 24, "NENHUM EVENTO", 3, 0);
    return;
  }

  // Bigger rows/font than before (was scale 2 / 40px rows) and each line now
  // carries the date, not just the time - the tile is also full-width and
  // taller now, so there is room for it.
  // 44 rather than 52: the backend now returns the next AGENDA_MAX_EVENTS
  // events whatever their date, so the tile is what decides how many are
  // actually seen, and at 52 a 319px tile fit only five. At scale 3 the
  // glyphs are 21px tall, so this still leaves 23px of air between rows.
  const int row_h = 44;
  const int first_row_y = 62;     // just below the title rule at y + 52
  const int row_text_h = 3 * 7;   // scale 3 x the 5x7 bitmap glyph height
  const int bottom_pad = 8;
  // Only the *last* row needs its glyph height; the rows before it need a full row_h
  // of pitch. Dividing the whole tile by row_h charged a full row for the last one
  // too, which dropped one event that fits and left a visibly empty strip at the
  // bottom of the tile.
  const int usable = h - first_row_y - row_text_h - bottom_pad;
  const int max_rows = usable < 0 ? 0 : usable / row_h + 1;
  const int shown = dashboard->agenda_event_count < max_rows ? dashboard->agenda_event_count : max_rows;
  for (int i = 0; i < shown; i++) {
    const AgendaEvent& event = dashboard->agenda_events[i];
    char date_time[16];
    agendaEventDateTime(&event, date_time, sizeof(date_time));
    // 128 to match drawTextClipped()'s own buffer; the formatted row tops out at
    // 2 + 15 + 1 + 48 characters, so nothing is lost by not being larger.
    char row[128];
    snprintf(row, sizeof(row), "- %-11s %.48s", date_time, event.title);
    drawTextClipped(canvas, x + 18, y + first_row_y + i * row_h, w - 36, row, 3, 0);
  }
}

void drawListCard(Canvas* canvas, int x, int y, int w, int h, const List* list, int list_index) {
  hudFrame(canvas, x, y, w, h, kHudEdge, kHudCorner, kHudNotch, 0);
  Rect card_rect = {x, y, w, h};
  addTouchRegion(card_rect, kTouchOpenList, list_index, -1, "", 0);

  const char* title = displayListTitleForIndex(list, list_index);
  fprintf(stderr, "render=list-card-header index=%d title=%s rect=%d,%d,%d,%d\n", list_index, title, x, y, w, h);

  if (h < 112) {
    hudTitleTab(canvas, x + w / 2, y + 14, w - 24, title, 4);
    hudRail(canvas, x + 10, x + w - 10, y + 52, 0);
    if (list->item_count > 0) {
      char row[128];
      char item_text[96];
      upperCopy(item_text, sizeof(item_text), list->items[0].text);
      snprintf(row, sizeof(row), "%s %.52s", list->items[0].done ? "[X]" : "[ ]", item_text);
      drawTextClipped(canvas, x + 18, y + 66, w - 36, row, 2, 0);
    } else {
      drawTextCentered(canvas, x + w / 2, y + 66, w - 36, "LISTA VAZIA", 2, 0);
    }
    return;
  }

  hudTitleTab(canvas, x + w / 2, y + 14, w - 24, title, 4);
  hudRail(canvas, x + 10, x + w - 10, y + 52, 0);
  int row_capacity = (h - 124) / 42;
  if (row_capacity < 1) row_capacity = 1;
  // TASKS (0) and COMPRAS (1) are the two larger tiles in the current
  // layout, so they get more preview rows than NOTAS (2).
  const int max_preview_rows = (list_index == 0 || list_index == 1) ? 8 : 5;
  if (row_capacity > max_preview_rows) row_capacity = max_preview_rows;
  const int shown = list->item_count > row_capacity ? row_capacity : list->item_count;
  for (int i = 0; i < shown; i++) {
    char row[128];
    char item_text[96];
    upperCopy(item_text, sizeof(item_text), list->items[i].text);
    snprintf(row, sizeof(row), "%s %.52s", list->items[i].done ? "[X]" : "[ ]", item_text);
    drawTextClipped(canvas, x + 18, y + 74 + i * 42, w - 36, row, 3, 0);
  }
  if (list->item_count > shown && h >= 190) {
    char more[48];
    snprintf(more, sizeof(more), "+%d ITENS", list->item_count - shown);
    drawTextClipped(canvas, x + 18, y + h - 68, 180, more, 3, 0);
  }
  if (h >= 160) {
    const int hint_scale = h < 172 ? 2 : 3;
    drawTextCentered(canvas, x + w / 2, y + h - 34, w - 24, "[ TOQUE AQUI ]", hint_scale, 0);
  }
}

void drawTopHeader(Canvas* canvas, const Dashboard* dashboard, const char* status, int shell_x, int shell_y, int shell_w) {
  const int header_h = 132;
  doubleRect(canvas, shell_x + 10, shell_y + 10, shell_w - 20, header_h, 0);

  const Rect lock_rect = lockButtonRectForScreen(canvas->width, canvas->height);
  const int text_w = lock_rect.x - shell_x - 44;
  drawTextClipped(canvas, shell_x + 28, shell_y + 24, text_w, g_title, 4, 0);

  drawExitAndLockButtons(canvas, canvas->width, canvas->height);

  hudRail(canvas, shell_x + 20, lock_rect.x - 8, shell_y + 88, 0);
  char updated[96];
  formatDisplayDate(dashboard->generated_at, status, updated, sizeof(updated));
  drawTextClipped(canvas, shell_x + 28, shell_y + 102, text_w, updated, 2, 0);
}

void drawSubHeader(Canvas* canvas, int shell_x, int y, int shell_w, const char* title) {
  const int list_header_h = 80;
  doubleRect(canvas, shell_x + 10, y, shell_w - 20, list_header_h, 0);
  const int title_w = shell_w - 310;
  const int title_scale = textWidth(title, 5) <= title_w ? 5 : (textWidth(title, 4) <= title_w ? 4 : 3);
  const int title_y = y + (title_scale == 5 ? 22 : (title_scale == 4 ? 26 : 30));
  drawTextClipped(canvas, shell_x + 28, title_y, title_w, title, title_scale, 0);

  Rect back_rect = {shell_x + shell_w - 136, y + 14, 104, 52};
  Rect home_rect = {back_rect.x - 116, y + 14, 104, 52};
  hudFrame(canvas, home_rect.x, home_rect.y, home_rect.w, home_rect.h, kHudEdge, kHudCornerSmallButton, kHudNotchSmallButton, 0);
  drawTextCentered(canvas, home_rect.x + home_rect.w / 2, home_rect.y + 16, home_rect.w - 12, "INICIO", 2, 0);
  addTouchRegion(home_rect, kTouchHome, -1, -1, "", 0);

  hudFrame(canvas, back_rect.x, back_rect.y, back_rect.w, back_rect.h, kHudEdge, kHudCornerSmallButton, kHudNotchSmallButton, 0);
  drawTextCentered(canvas, back_rect.x + back_rect.w / 2, back_rect.y + 16, back_rect.w - 12, "VOLTAR", 2, 0);
  addTouchRegion(back_rect, kTouchBack, -1, -1, "", 0);
}

void drawFullListDashboard(Canvas* canvas, const Dashboard* dashboard, int list_index, const char* status) {
  clearCanvas(canvas, 255);
  clearTouchRegions();
  g_last_screen_width = canvas->width;
  g_last_screen_height = canvas->height;
  const int shell_w = canvas->width;
  const int shell_x = 0;
  const int shell_y = kKindleStatusBarHeight;
  const int shell_h = canvas->height - shell_y;
  hudFrame(canvas, shell_x, shell_y, shell_w, shell_h, 3, kHudCorner * 2, kHudNotch + 8, 0);

  if (list_index < 0 || list_index >= dashboard->list_count) list_index = 0;
  const List* list = &dashboard->lists[list_index];

  drawTopHeader(canvas, dashboard, status, shell_x, shell_y, shell_w);

  const int list_header_y = shell_y + 10 + 132 + 8;
  const int list_header_h = 80;

  const char* title = displayListTitleForIndex(list, list_index);
  drawSubHeader(canvas, shell_x, list_header_y, shell_w, title);

  const int row_x = shell_x + 18;
  const int row_w = shell_w - 36;
  const int row_h = 72;
  const int row_gap = 10;
  const int first_y = list_header_y + list_header_h + 18;
  const int max_rows = (shell_y + shell_h - first_y - 24) / (row_h + row_gap);
  const int shown = list->item_count < max_rows ? list->item_count : max_rows;
  for (int i = 0; i < shown; i++) {
    const int row_y = first_y + i * (row_h + row_gap);
    Rect row_rect = {row_x, row_y, row_w, row_h};
    hudFrame(canvas, row_rect.x, row_rect.y, row_rect.w, row_rect.h, kHudEdge, kHudCornerRow, kHudNotchRow, 0);
    // Solid rail down the left of each row. It is what makes a stack of rows
    // read as a HUD list rather than a column of boxes, and it sits in the
    // 18px of padding before the text, so nothing shifts.
    fillRect(canvas, row_rect.x, row_rect.y, 7, row_rect.h, 0);
    addTouchRegion(row_rect, kTouchToggleItem, list_index, i, list->items[i].id, list->items[i].done);
    char row[160];
    char item_text[96];
    upperCopy(item_text, sizeof(item_text), list->items[i].text);
    snprintf(row, sizeof(row), "%s %.46s", list->items[i].done ? "[X]" : "[ ]", item_text);
    drawTextClipped(canvas, row_x + 18, row_y + 20, row_w - 36, row, 3, 0);
  }
}

void drawCurrentDashboard(Canvas* canvas, const Dashboard* dashboard, const char* status) {
  if (g_active_list >= 0 && g_active_list < dashboard->list_count) {
    drawFullListDashboard(canvas, dashboard, g_active_list, status);
  } else {
    drawBitmapDashboard(canvas, dashboard, status);
  }
  // The single place dark mode happens. Every screen goes through here, so a
  // new view cannot forget to be dark.
  if (g_dark_mode) invertCanvas(canvas);
}

Rect exitButtonRectForScreen(int width, int) {
  const int shell_w = width;
  const int shell_x = 0;
  Rect rect;
  rect.w = 172;
  rect.h = 96;
  rect.x = shell_x + shell_w - rect.w - 28;
  rect.y = kKindleStatusBarHeight + 20;
  return rect;
}

// Sits immediately to EXIT's left, same row, same height - a habit formed in
// either header (bitmap dashboard or full-list view) carries to the other.
Rect lockButtonRectForScreen(int width, int height) {
  const Rect exit_rect = exitButtonRectForScreen(width, height);
  Rect rect;
  rect.w = 96;
  rect.h = exit_rect.h;
  rect.x = exit_rect.x - rect.w - 16;
  rect.y = exit_rect.y;
  return rect;
}

int containsPoint(const Rect* rect, int x, int y) {
  return rect && x >= rect->x && y >= rect->y && x < rect->x + rect->w && y < rect->y + rect->h;
}

void clearTouchRegions() {
  memset(g_touch_regions, 0, sizeof(g_touch_regions));
  g_touch_region_count = 0;
}

void setPendingTouchRect(Rect rect) {
  g_pending_touch_rect = rect;
  g_pending_touch_rect_valid = rect.w > 0 && rect.h > 0 ? 1 : 0;
}

void addTouchRegion(Rect rect, TouchAction action, int list_index, int item_index, const char* item_id, int item_done) {
  if (g_touch_region_count >= kMaxTouchRegions) return;
  TouchRegion* region = &g_touch_regions[g_touch_region_count++];
  region->rect = rect;
  region->action = action;
  region->list_index = list_index;
  region->item_index = item_index;
  copyText(region->item_id, sizeof(region->item_id), item_id ? item_id : "");
  region->item_done = item_done;
}

// Drawn identically by both header variants (the bitmap dashboard's weather bar and the
// full-list view's top header), one call each, so the two can't drift apart the way the
// hand-copied EXIT block they replaced already had once (see the small-HUD-constant cleanup a
// commit ago). Layout math (text widths, the rail's end point) still lives in each header, keyed
// off lockButtonRectForScreen() directly - this only draws the two buttons and registers their
// touch regions.
void drawExitAndLockButtons(Canvas* canvas, int width, int height) {
  const Rect exit_rect = exitButtonRectForScreen(width, height);
  const Rect exit_hit_rect = {exit_rect.x - 20, kKindleStatusBarHeight, exit_rect.w + 40, exit_rect.y - kKindleStatusBarHeight + exit_rect.h + 20};
  hudFrame(canvas, exit_rect.x, exit_rect.y, exit_rect.w, exit_rect.h, kHudEdge, kHudCornerButton, kHudNotchButton, 0);
  drawTextCentered(canvas, exit_rect.x + exit_rect.w / 2, exit_rect.y + 34, exit_rect.w - 16, "SAIR", 3, 0);
  addTouchRegion(exit_hit_rect, kTouchExit, -1, -1, "", 0);
  addTouchRegion(exit_rect, kTouchExit, -1, -1, "", 0);

  const Rect lock_rect = lockButtonRectForScreen(width, height);
  const Rect lock_hit_rect = {lock_rect.x - 16, kKindleStatusBarHeight, lock_rect.w + 32, lock_rect.y - kKindleStatusBarHeight + lock_rect.h + 20};
  hudFrame(canvas, lock_rect.x, lock_rect.y, lock_rect.w, lock_rect.h, kHudEdge, kHudCornerButton, kHudNotchButton, 0);
  drawPadlockIcon(canvas, lock_rect.x + lock_rect.w / 2, lock_rect.y + lock_rect.h / 2 + 4, 44, g_screen_locked, 0);
  addTouchRegion(lock_hit_rect, kTouchToggleLock, -1, -1, "", 0);
  addTouchRegion(lock_rect, kTouchToggleLock, -1, -1, "", 0);
}

[[maybe_unused]] int applyTouchAt(int x, int y) {
  for (int i = g_touch_region_count - 1; i >= 0; i--) {
    TouchRegion* region = &g_touch_regions[i];
    if (!containsPoint(&region->rect, x, y)) continue;
    g_pending_action = region->action;
    g_pending_list_index = region->list_index;
    g_pending_recipe_index = region->item_index;
    copyText(g_pending_item_id, sizeof(g_pending_item_id), region->item_id);
    g_pending_item_done = region->item_done;
    setPendingTouchRect(region->rect);
    return 1;
  }
  return 0;
}

void drawBitmapDashboard(Canvas* canvas, const Dashboard* dashboard, const char* status) {
  clearCanvas(canvas, 255);
  clearTouchRegions();
  g_last_screen_width = canvas->width;
  g_last_screen_height = canvas->height;
  const int shell_w = canvas->width;
  const int shell_x = 0;
  const int shell_y = kKindleStatusBarHeight;
  const int shell_h = canvas->height - shell_y;
  hudFrame(canvas, shell_x, shell_y, shell_w, shell_h, 3, kHudCorner * 2, kHudNotch + 8, 0);

  const int header_h = 132;
  drawWeatherBar(canvas, dashboard, status, shell_x, shell_y, shell_w, header_h);

  const int gap = 8;
  const int grid_y = shell_y + 10 + header_h + gap;
  // No separate footer bar anymore - that space goes to AGENDA instead, which
  // is meant to be the bigger area now (full width, more/taller event rows).
  const int lower_h = shell_y + shell_h - grid_y - 10;
  const int agenda_h = (lower_h * 2) / 5;
  const int middle_h = lower_h - agenda_h - gap;
  const int agenda_y = grid_y + middle_h + gap;

  const int col_w = (shell_w - 20 - gap) / 2;
  const int left_x = shell_x + 10;
  const int right_x = left_x + col_w + gap;

  // Asymmetric split per column, matching the hand-drawn layout: GIF (small)
  // over SHOPPING (big) on the left, TASKS (big) over NOTES (small) on the
  // right - each column's own divider sits at a different height on purpose.
  const int gif_h = (middle_h * 2) / 5;
  const int shopping_h = middle_h - gif_h - gap;
  const int tasks_h = (middle_h * 3) / 5;
  const int notes_h = middle_h - tasks_h - gap;

  drawPhotoTile(canvas, left_x, grid_y, col_w, gif_h);
  if (dashboard->list_count > 0) drawListCard(canvas, right_x, grid_y, col_w, tasks_h, &dashboard->lists[0], 0);
  if (dashboard->list_count > 1) drawListCard(canvas, left_x, grid_y + gif_h + gap, col_w, shopping_h, &dashboard->lists[1], 1);
  if (dashboard->list_count > 2) drawListCard(canvas, right_x, grid_y + tasks_h + gap, col_w, notes_h, &dashboard->lists[2], 2);

  drawAgendaTile(canvas, shell_x + 10, agenda_y, shell_w - 20, agenda_h, dashboard);
}

int writePgm(const char* path, const Canvas* canvas) {
  FILE* file = fopen(path, "wb");
  if (!file) return 0;
  fprintf(file, "P5\n%d %d\n255\n", canvas->width, canvas->height);
  const size_t bytes = static_cast<size_t>(canvas->width) * static_cast<size_t>(canvas->height);
  const int ok = fwrite(canvas->pixels, 1, bytes, file) == bytes;
  fclose(file);
  return ok;
}

#ifdef __linux__
struct TouchInput {
  struct Device {
    int fd;
    int grabbed;
    int min_x;
    int max_x;
    int min_y;
    int max_y;
    int has_x_range;
    int has_y_range;
  } devices[16];
  int count;
  int x;
  int y;
  int has_x;
  int has_y;
  int was_down;
  long long last_action_ms;
  // The physical power button's input device, if one was found - separate from devices[]
  // above, which only ever holds touchscreens (initTouchInput() requires an ABS X/Y range
  // to keep one open). -1 if none was found. Never grabbed: see pollPowerButtonUnlock().
  int power_fd;
};

int applyTouchWithDebounce(TouchInput* input) {
  // Use monotonicMs() (long long), not a hand-rolled long-based clock: tv_sec * 1000 for a
  // real epoch timestamp overflows a 32-bit long on this ARM target, wrapping negative and
  // making every debounce check below pass trivially, which permanently drops all touches.
  const long long now = monotonicMs();
  if (now - input->last_action_ms < 700) return 0;
  const int w = g_last_screen_width;
  const int h = g_last_screen_height;
  const int x = input->x;
  const int y = input->y;

  if (g_screen_locked) {
    // Every touch is inert while locked - deliberately including the lock button itself.
    // Unlocking only happens via the physical power button (see pollPowerButtonUnlock()):
    // if tapping the same pixels that locked the screen could also unlock it, that corner
    // of the touchscreen would still be "live", and an incidental brush while wiping the
    // screen or carrying the Kindle around would undo the lock without anyone meaning to.
    fprintf(stderr, "input=locked x=%d y=%d\n", x, y);
    return 0;
  }

  // Coarse EXIT fallback, checked ahead of the registered regions so a badly scaled
  // touch can always quit. Bound it to the button's own rect plus a margin instead of
  // a fixed 280x160 block: that block reached down to y = kKindleStatusBarHeight + 160
  // and, with the current layout, overlapped the top edge of the CHORES card, so taps
  // meant for the card fired EXIT.
  const Rect exit_rect = exitButtonRectForScreen(w, h);
  const int exit_pad = 24;
  if (x >= exit_rect.x - exit_pad && x <= exit_rect.x + exit_rect.w + exit_pad &&
      y >= kKindleStatusBarHeight && y <= exit_rect.y + exit_rect.h + exit_pad) {
    g_pending_action = kTouchExit;
    setPendingTouchRect(exit_rect);
  } else if (!applyTouchAt(x, y) &&
             !applyTouchAt(w - 1 - x, y) &&
             !applyTouchAt(x, h - 1 - y) &&
             !applyTouchAt(w - 1 - x, h - 1 - y) &&
             !applyTouchAt((static_cast<long>(y) * w) / (h > 1 ? h : 1), (static_cast<long>(x) * h) / (w > 1 ? w : 1)) &&
             !applyTouchAt(w - 1 - (static_cast<long>(y) * w) / (h > 1 ? h : 1), (static_cast<long>(x) * h) / (w > 1 ? w : 1)) &&
             !applyTouchAt((static_cast<long>(y) * w) / (h > 1 ? h : 1), h - 1 - (static_cast<long>(x) * h) / (w > 1 ? w : 1)) &&
             !applyTouchAt(w - 1 - (static_cast<long>(y) * w) / (h > 1 ? h : 1), h - 1 - (static_cast<long>(x) * h) / (w > 1 ? w : 1))) {
    fprintf(stderr, "input=miss x=%d y=%d width=%d height=%d regions=%d\n", x, y, w, h, g_touch_region_count);
    return 0;
  }
  g_pending_touch_x = x;
  g_pending_touch_y = y;
  input->last_action_ms = now;
  wakeFrontlightOnTouch();
  return 1;
}

int readAbsRange(int fd, int code, int* minimum, int* maximum) {
  input_absinfo abs_info;
  memset(&abs_info, 0, sizeof(abs_info));
  if (ioctl(fd, EVIOCGABS(code), &abs_info) != 0) return 0;
  if (abs_info.maximum <= abs_info.minimum) return 0;
  *minimum = abs_info.minimum;
  *maximum = abs_info.maximum;
  return 1;
}

// EVIOCGBIT capability query, the same mechanism evtest/libinput use to ask a device "do you
// ever send this key" without opening it exclusively or waiting for one to arrive - matches
// readAbsRange() just above, but for a specific EV_KEY code instead of an ABS axis.
int deviceHasKey(int fd, int key_code) {
  unsigned long bits[(KEY_MAX / (sizeof(unsigned long) * 8)) + 1];
  memset(bits, 0, sizeof(bits));
  if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(bits)), bits) < 0) return 0;
  return (bits[key_code / (sizeof(unsigned long) * 8)] >> (key_code % (sizeof(unsigned long) * 8))) & 1;
}

int scaleAbsValue(int value, int minimum, int maximum, int screen_size) {
  if (maximum <= minimum || screen_size <= 1) return value;
  long scaled = (static_cast<long>(value - minimum) * static_cast<long>(screen_size - 1)) / static_cast<long>(maximum - minimum);
  if (scaled < 0) scaled = 0;
  if (scaled >= screen_size) scaled = screen_size - 1;
  return static_cast<int>(scaled);
}

void initTouchInput(TouchInput* input) {
  memset(input, 0, sizeof(*input));
  input->x = -1;
  input->y = -1;
  input->power_fd = -1;
  for (int i = 0; i < 16 && input->count < 16; i++) {
    char path[48];
    snprintf(path, sizeof(path), "/dev/input/event%d", i);
    int fd = open(path, O_RDONLY | O_NONBLOCK);
    if (fd < 0) continue;

    TouchInput::Device* device = &input->devices[input->count];
    memset(device, 0, sizeof(*device));
    device->fd = fd;
    device->has_x_range = readAbsRange(fd, ABS_X, &device->min_x, &device->max_x) ||
                          readAbsRange(fd, ABS_MT_POSITION_X, &device->min_x, &device->max_x);
    device->has_y_range = readAbsRange(fd, ABS_Y, &device->min_y, &device->max_y) ||
                          readAbsRange(fd, ABS_MT_POSITION_Y, &device->min_y, &device->max_y);

    if (!device->has_x_range || !device->has_y_range) {
      // Not a touchscreen. Before giving up on it, check whether it is the physical power
      // button - the one hardware control every Kindle has, and the only way to unlock the
      // screen (see pollPowerButtonUnlock()). Left ungrabbed on purpose: this fd is a second,
      // passive reader alongside whatever the Kindle's own powerd already has open, so the
      // normal sleep/wake behaviour of that button is completely unaffected by our also
      // noticing the same press.
      if (input->power_fd < 0 && deviceHasKey(fd, KEY_POWER)) {
        input->power_fd = fd;
        fprintf(stderr, "input=power-button path=%s\n", path);
      } else {
        close(fd);
      }
      continue;
    }

    if (ioctl(fd, EVIOCGRAB, 1) == 0) device->grabbed = 1;
    fprintf(stderr, "input=device path=%s grabbed=%d xrange=%d..%d yrange=%d..%d\n",
            path, device->grabbed, device->min_x, device->max_x, device->min_y, device->max_y);
    input->count++;
  }
  fprintf(stderr, "input=opened count=%d power_button=%d\n", input->count, input->power_fd >= 0);
}

void closeTouchInput(TouchInput* input) {
  for (int i = 0; i < input->count; i++) {
    if (input->devices[i].grabbed) ioctl(input->devices[i].fd, EVIOCGRAB, 0);
    close(input->devices[i].fd);
  }
  input->count = 0;
  if (input->power_fd >= 0) {
    close(input->power_fd);
    input->power_fd = -1;
  }
}

int pollExitTouch(TouchInput* input) {
  if (!input || input->count <= 0) return 0;
  for (int i = 0; i < input->count; i++) {
    TouchInput::Device* device = &input->devices[i];
    while (1) {
      input_event event;
      const ssize_t bytes = read(device->fd, &event, sizeof(event));
      if (bytes != sizeof(event)) {
        if (bytes < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
          // Keep the fd open; intermittent event read errors are not fatal to rendering.
        }
        break;
      }

      if (event.type == EV_ABS) {
        if (event.code == ABS_X || event.code == ABS_MT_POSITION_X) {
          input->x = scaleAbsValue(event.value, device->min_x, device->max_x, g_last_screen_width);
          input->has_x = 1;
          input->was_down = 1;
        } else if (event.code == ABS_Y || event.code == ABS_MT_POSITION_Y) {
          input->y = scaleAbsValue(event.value, device->min_y, device->max_y, g_last_screen_height);
          input->has_y = 1;
          input->was_down = 1;
        } else if (event.code == ABS_MT_TRACKING_ID) {
          input->was_down = event.value >= 0 ? 1 : 0;
        }
      } else if (event.type == EV_KEY && (event.code == BTN_TOUCH || event.code == BTN_LEFT)) {
        if (event.value > 0) input->was_down = 1;
        if (event.value == 0 && input->was_down && input->has_x && input->has_y) {
          input->was_down = 0;
          if (applyTouchWithDebounce(input)) {
            fprintf(stderr, "input=action tap action=%d x=%d y=%d\n", static_cast<int>(g_pending_action), input->x, input->y);
            return 1;
          }
        }
      } else if (event.type == EV_SYN && input->has_x && input->has_y) {
        if (applyTouchWithDebounce(input)) {
          fprintf(stderr, "input=action touch action=%d x=%d y=%d\n", static_cast<int>(g_pending_action), input->x, input->y);
          return 1;
        }
      }
    }
  }
  return 0;
}

// The only way to clear g_screen_locked. Deliberately not routed through
// applyTouchWithDebounce() or any touch-region machinery - this is a hardware key, not a
// point on the screen, and the whole reason it exists is that a touch can't do this job (see
// the comment on that early return in applyTouchWithDebounce()). Sets g_pending_action and
// leaves the actual state change to handlePendingTouch(), like every other action, so the
// main loop's existing "an action is pending, handle it and redraw" plumbing needs no changes.
int pollPowerButtonUnlock(TouchInput* input) {
  if (!input || input->power_fd < 0) return 0;
  int unlocked = 0;
  while (1) {
    input_event event;
    const ssize_t bytes = read(input->power_fd, &event, sizeof(event));
    if (bytes != sizeof(event)) break;
    // value == 1 is the press (key-down); 0 is release, 2 is autorepeat while held. Acting
    // on press means one tap of the button is enough - no need to wait for release.
    if (event.type == EV_KEY && event.code == KEY_POWER && event.value == 1 && g_screen_locked) {
      g_pending_action = kTouchHardwareUnlock;
      unlocked = 1;
    }
  }
  return unlocked;
}
#else
struct TouchInput {
  int unused;
};

void initTouchInput(TouchInput*) {}
void closeTouchInput(TouchInput*) {}
[[maybe_unused]] int pollExitTouch(TouchInput*) { return 0; }
[[maybe_unused]] int pollPowerButtonUnlock(TouchInput*) { return 0; }
#endif

#ifdef __linux__
void putFramebufferPixel(unsigned char* fb, const fb_var_screeninfo* vinfo, const fb_fix_screeninfo* finfo, int x, int y, unsigned char gray) {
  if (x < 0 || y < 0 || x >= static_cast<int>(vinfo->xres) || y >= static_cast<int>(vinfo->yres)) return;
  if (vinfo->bits_per_pixel == 4) {
    const long location = static_cast<long>(y + vinfo->yoffset) * finfo->line_length +
                          static_cast<long>(x + vinfo->xoffset) / 2;
    const unsigned char nibble = static_cast<unsigned char>(gray >> 4);
    if (((x + vinfo->xoffset) & 1) == 0) {
      fb[location] = static_cast<unsigned char>((fb[location] & 0x0f) | (nibble << 4));
    } else {
      fb[location] = static_cast<unsigned char>((fb[location] & 0xf0) | nibble);
    }
    return;
  }

  if (vinfo->bits_per_pixel == 1) {
    const long location = static_cast<long>(y + vinfo->yoffset) * finfo->line_length +
                          static_cast<long>(x + vinfo->xoffset) / 8;
    const unsigned char mask = static_cast<unsigned char>(0x80 >> ((x + vinfo->xoffset) & 7));
    if (gray < 128) fb[location] &= static_cast<unsigned char>(~mask);
    else fb[location] |= mask;
    return;
  }

  const long location = static_cast<long>(x + vinfo->xoffset) * (vinfo->bits_per_pixel / 8) +
                        static_cast<long>(y + vinfo->yoffset) * finfo->line_length;
  if (vinfo->bits_per_pixel == 8) {
    fb[location] = gray;
  } else if (vinfo->bits_per_pixel == 16) {
    const unsigned short value = static_cast<unsigned short>(((gray >> 3) << 11) | ((gray >> 2) << 5) | (gray >> 3));
    memcpy(fb + location, &value, sizeof(value));
  } else if (vinfo->bits_per_pixel == 32) {
    const unsigned int value = 0xff000000u | (static_cast<unsigned int>(gray) << 16) | (static_cast<unsigned int>(gray) << 8) | gray;
    memcpy(fb + location, &value, sizeof(value));
  }
}

unsigned char getFramebufferPixel(unsigned char* fb, const fb_var_screeninfo* vinfo, const fb_fix_screeninfo* finfo, int x, int y) {
  if (x < 0 || y < 0 || x >= static_cast<int>(vinfo->xres) || y >= static_cast<int>(vinfo->yres)) return 255;

  if (vinfo->bits_per_pixel == 4) {
    const long location = static_cast<long>(y + vinfo->yoffset) * finfo->line_length +
                          static_cast<long>(x + vinfo->xoffset) / 2;
    const unsigned char value = fb[location];
    const unsigned char nibble = ((x + vinfo->xoffset) & 1) == 0
      ? static_cast<unsigned char>(value >> 4)
      : static_cast<unsigned char>(value & 0x0f);
    return static_cast<unsigned char>(nibble * 17);
  }

  if (vinfo->bits_per_pixel == 1) {
    const long location = static_cast<long>(y + vinfo->yoffset) * finfo->line_length +
                          static_cast<long>(x + vinfo->xoffset) / 8;
    const unsigned char mask = static_cast<unsigned char>(0x80 >> ((x + vinfo->xoffset) & 7));
    return (fb[location] & mask) ? 255 : 0;
  }

  const long location = static_cast<long>(x + vinfo->xoffset) * (vinfo->bits_per_pixel / 8) +
                        static_cast<long>(y + vinfo->yoffset) * finfo->line_length;
  if (vinfo->bits_per_pixel == 8) return fb[location];
  if (vinfo->bits_per_pixel == 16) {
    unsigned short value = 0;
    memcpy(&value, fb + location, sizeof(value));
    const int red = ((value >> 11) & 31) * 255 / 31;
    const int green = ((value >> 5) & 63) * 255 / 63;
    const int blue = (value & 31) * 255 / 31;
    return static_cast<unsigned char>((red + green + blue) / 3);
  }
  if (vinfo->bits_per_pixel == 32) {
    const unsigned char red = fb[location + 2];
    const unsigned char green = fb[location + 1];
    const unsigned char blue = fb[location];
    return static_cast<unsigned char>((static_cast<int>(red) + green + blue) / 3);
  }
  return 255;
}

void invertFramebufferArea(unsigned char* fb, const fb_var_screeninfo* vinfo, const fb_fix_screeninfo* finfo, int left, int top, int right, int bottom, int inset) {
  for (int y = top; y < bottom; y++) {
    for (int x = left; x < right; x++) {
      if (inset > 0 && (x < left + inset || x >= right - inset || y < top + inset || y >= bottom - inset)) continue;
      const unsigned char current = getFramebufferPixel(fb, vinfo, finfo, x, y);
      putFramebufferPixel(fb, vinfo, finfo, x, y, static_cast<unsigned char>(255 - current));
    }
  }
}

void flashTouchRectOnFramebuffer(Rect rect) {
  if (rect.w <= 0 || rect.h <= 0) return;
  if (rect.y < kKindleStatusBarHeight) {
    const int shift = kKindleStatusBarHeight - rect.y;
    rect.y += shift;
    rect.h -= shift;
  }
  if (rect.w <= 0 || rect.h <= 0) return;

  int fd = open("/dev/fb0", O_RDWR);
  if (fd < 0) {
    fprintf(stderr, "visual-feedback=framebuffer open_failed\n");
    return;
  }

  fb_var_screeninfo vinfo;
  fb_fix_screeninfo finfo;
  if (ioctl(fd, FBIOGET_VSCREENINFO, &vinfo) != 0 || ioctl(fd, FBIOGET_FSCREENINFO, &finfo) != 0) {
    fprintf(stderr, "visual-feedback=framebuffer ioctl_failed\n");
    close(fd);
    return;
  }

  const long screensize = static_cast<long>(finfo.line_length) * static_cast<long>(vinfo.yres_virtual ? vinfo.yres_virtual : vinfo.yres);
  unsigned char* fb = static_cast<unsigned char*>(mmap(0, screensize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0));
  if (fb == MAP_FAILED) {
    fprintf(stderr, "visual-feedback=framebuffer mmap_failed\n");
    close(fd);
    return;
  }

  const int left = rect.x < 0 ? 0 : rect.x;
  const int top = rect.y < kKindleStatusBarHeight ? kKindleStatusBarHeight : rect.y;
  const int right = rect.x + rect.w > static_cast<int>(vinfo.xres) ? static_cast<int>(vinfo.xres) : rect.x + rect.w;
  const int bottom = rect.y + rect.h > static_cast<int>(vinfo.yres) ? static_cast<int>(vinfo.yres) : rect.y + rect.h;
  // No msync() around these writes, for the same reason as renderToFramebuffer(): fbdev mmap
  // writes land directly in device memory (there is no page cache to flush) and MS_SYNC blocks
  // forever on this hardware's driver. Leaving it here would hang the app on the first tap.
  invertFramebufferArea(fb, &vinfo, &finfo, left, top, right, bottom, 0);
  system("eips '' >/dev/null 2>&1 || true");
  usleep(120000);
  invertFramebufferArea(fb, &vinfo, &finfo, left, top, right, bottom, 0);
  munmap(fb, screensize);
  close(fd);
  system("eips '' >/dev/null 2>&1 || true");
  fprintf(stderr, "visual-feedback=blink rect=%d,%d,%d,%d\n", rect.x, rect.y, rect.w, rect.h);
}

int renderToFramebuffer(const Dashboard* dashboard, const char* status, const char* save_pgm) {
  int fd = open("/dev/fb0", O_RDWR);
  if (fd < 0) {
    fprintf(stderr, "render=framebuffer open_failed\n");
    return 0;
  }
  fb_var_screeninfo vinfo;
  fb_fix_screeninfo finfo;
  if (ioctl(fd, FBIOGET_VSCREENINFO, &vinfo) != 0 || ioctl(fd, FBIOGET_FSCREENINFO, &finfo) != 0) {
    fprintf(stderr, "render=framebuffer ioctl_failed\n");
    close(fd);
    return 0;
  }
  if (vinfo.bits_per_pixel != 1 && vinfo.bits_per_pixel != 4 && vinfo.bits_per_pixel != 8 &&
      vinfo.bits_per_pixel != 16 && vinfo.bits_per_pixel != 32) {
    fprintf(stderr, "render=framebuffer unsupported_bpp width=%d height=%d bpp=%d line=%d\n",
            static_cast<int>(vinfo.xres), static_cast<int>(vinfo.yres), static_cast<int>(vinfo.bits_per_pixel), static_cast<int>(finfo.line_length));
    close(fd);
    return 0;
  }
  const long screensize = static_cast<long>(finfo.line_length) * static_cast<long>(vinfo.yres_virtual ? vinfo.yres_virtual : vinfo.yres);
  unsigned char* fb = static_cast<unsigned char*>(mmap(0, screensize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0));
  if (fb == MAP_FAILED) {
    fprintf(stderr, "render=framebuffer mmap_failed\n");
    close(fd);
    return 0;
  }

  Canvas canvas;
  canvas.width = static_cast<int>(vinfo.xres);
  canvas.height = static_cast<int>(vinfo.yres);
  canvas.pixels = static_cast<unsigned char*>(calloc(static_cast<size_t>(canvas.width) * static_cast<size_t>(canvas.height), 1));
  if (!canvas.pixels) {
    fprintf(stderr, "render=framebuffer alloc_failed\n");
    munmap(fb, screensize);
    close(fd);
    return 0;
  }
  drawCurrentDashboard(&canvas, dashboard, status);
  if (save_pgm && save_pgm[0]) {
    writePgm(save_pgm, &canvas);
    fprintf(stderr, "render=save-pgm %s width=%d height=%d\n", save_pgm, canvas.width, canvas.height);
  }
  fprintf(stderr, "render=framebuffer writing_pixels screensize=%ld\n", screensize);
  for (int y = kKindleStatusBarHeight; y < canvas.height; y++) {
    for (int x = 0; x < canvas.width; x++) putFramebufferPixel(fb, &vinfo, &finfo, x, y, canvas.pixels[y * canvas.width + x]);
  }
  fprintf(stderr, "render=framebuffer pixels_written\n");
  free(canvas.pixels);
  // No msync() here: writes to an mmap'd /dev/fb0 region land directly in device memory on
  // fbdev drivers (there is no page cache to flush), and MS_SYNC blocks indefinitely on this
  // hardware's framebuffer driver, hanging the render forever.
  munmap(fb, screensize);
  close(fd);
  fprintf(stderr, "render=framebuffer refreshing_eips\n");
  system("eips '' >/dev/null 2>&1 || true");
  fprintf(stderr, "render=framebuffer ok width=%d height=%d bpp=%d\n", static_cast<int>(vinfo.xres), static_cast<int>(vinfo.yres), static_cast<int>(vinfo.bits_per_pixel));
  return 1;
}
#else
int renderToFramebuffer(const Dashboard*, const char*, const char*) {
  fprintf(stderr, "render=framebuffer unavailable\n");
  return 0;
}

void flashTouchRectOnFramebuffer(Rect) {}
#endif

int commandExists(const char* command) {
  char probe[160];
  snprintf(probe, sizeof(probe), "command -v '%s' >/dev/null 2>&1", command);
  return system(probe) == 0;
}

void shellQuote(const char* text, char* out, size_t out_size) {
  size_t j = 0;
  if (j + 1 < out_size) out[j++] = '\'';
  for (size_t i = 0; text[i] && j + 5 < out_size; i++) {
    if (text[i] == '\'') {
      out[j++] = '\'';
      out[j++] = '\\';
      out[j++] = '\'';
      out[j++] = '\'';
    } else {
      out[j++] = text[i];
    }
  }
  if (j + 1 < out_size) out[j++] = '\'';
  out[j] = '\0';
}

void renderToEips(char lines[][96], int count) {
  if (!commandExists("eips")) {
    for (int i = 0; i < count; i++) printf("%s\n", lines[i]);
    fflush(stdout);
    return;
  }
  for (int i = 0; i < count; i++) {
    char quoted[180];
    char command[240];
    shellQuote(lines[i], quoted, sizeof(quoted));
    snprintf(command, sizeof(command), "eips 1 %d %s >/dev/null 2>&1", i + 3, quoted);
    system(command);
  }
}

void setFrontlightLevel(int level) {
  char command[80];
  snprintf(command, sizeof(command), "lipc-set-prop com.lab126.powerd flIntensity %d >/dev/null 2>&1 || true", level);
  system(command);
}

// Reads the device's current frontlight level before we touch it, so turning
// the light back on after a touch restores whatever brightness the user had
// set (via the Kindle's own settings) instead of a hardcoded guess. Returns
// kFrontlightFallbackLevel if lipc is unavailable (e.g. running off-device)
// or the value is unparsable.
//
// A genuine 0 is a real answer, not a failure: a user who keeps the frontlight
// off must not have it switched on at level 10 when they leave the dashboard.
// So only an unreadable/unparsable response falls back - hence the explicit
// digit check rather than treating atoi()'s 0 as "no value".
int readFrontlightLevel() {
  FILE* pipe = popen("lipc-get-prop com.lab126.powerd flIntensity 2>/dev/null", "r");
  if (!pipe) return kFrontlightFallbackLevel;
  char buffer[32] = {0};
  const size_t read_bytes = fread(buffer, 1, sizeof(buffer) - 1, pipe);
  pclose(pipe);
  if (read_bytes == 0) return kFrontlightFallbackLevel;
  const char* cursor = buffer;
  while (*cursor == ' ' || *cursor == '\t' || *cursor == '\n' || *cursor == '\r') cursor++;
  if (*cursor < '0' || *cursor > '9') return kFrontlightFallbackLevel;
  const int value = atoi(cursor);
  return value >= 0 ? value : kFrontlightFallbackLevel;
}

// Called once at startup: captures the current frontlight level (so it can be
// restored later) and turns the light off, since the dashboard should start
// dark and only light up in response to an actual touch.
void initFrontlightPowerManagement() {
  g_frontlight_saved_level = readFrontlightLevel();
  setFrontlightLevel(0);
  g_frontlight_is_on = 0;
  fprintf(stderr, "power=frontlight startup_off saved_level=%d\n", g_frontlight_saved_level);
}

void wakeFrontlightOnTouch() {
  if (g_frontlight_is_on) return;
  // > 0, not >= 0: a saved level of 0 (user keeps the light off) is honoured on
  // exit, but waking with 0 here would make touch-to-light a no-op, so light up at
  // the fallback level instead. The restore paths still use the true saved value.
  setFrontlightLevel(g_frontlight_saved_level > 0 ? g_frontlight_saved_level : kFrontlightFallbackLevel);
  g_frontlight_is_on = 1;
  fprintf(stderr, "power=frontlight on\n");
}

// Polled from the touch-watcher thread (see touchWatcherMain): turns the
// frontlight back off after kFrontlightIdleTimeoutMs with no further touch,
// so it never stays lit through periodic background refreshes.
void turnOffFrontlightIfIdle(long long last_action_ms) {
  if (!g_frontlight_is_on) return;
  if (monotonicMs() - last_action_ms < kFrontlightIdleTimeoutMs) return;
  setFrontlightLevel(0);
  g_frontlight_is_on = 0;
  fprintf(stderr, "power=frontlight off idle\n");
}

void showTouchVisualFeedback(TouchAction action, int x, int y) {
  if (action == kTouchNone) return;
  fprintf(stderr, "visual-feedback=tap action=%d x=%d y=%d\n", static_cast<int>(action), x, y);
  if (g_pending_touch_rect_valid) flashTouchRectOnFramebuffer(g_pending_touch_rect);
}

void returnToKindleHome() {
  fprintf(stderr, "exit=return-home\n");
  // Restore whatever frontlight level we captured at startup, so leaving the
  // dashboard doesn't strand the Kindle home screen dark.
  if (g_frontlight_saved_level >= 0) setFrontlightLevel(g_frontlight_saved_level);
  system(
    "lipc-set-prop com.lab126.powerd preventScreenSaver 0 >/dev/null 2>&1 || true; "
    "lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home >/dev/null 2>&1 || "
    "lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home/ >/dev/null 2>&1 || true; "
    "sleep 1; "
    "eips '' >/dev/null 2>&1 || true"
  );
}

int renderViaFbink(const Dashboard* dashboard, const char* status, const char* save_pgm) {
  (void)dashboard;
  (void)status;
  (void)save_pgm;
  fprintf(stderr, "render=fbink skipped preserve_status_bar\n");
  return 0;
#if 0
  if (!commandExists("fbink")) {
    fprintf(stderr, "render=fbink unavailable\n");
    return 0;
  }

  Canvas canvas;
  canvas.width = kBitmapFallbackWidth;
  canvas.height = kBitmapFallbackHeight;
  canvas.pixels = static_cast<unsigned char*>(calloc(static_cast<size_t>(canvas.width) * static_cast<size_t>(canvas.height), 1));
  if (!canvas.pixels) {
    fprintf(stderr, "render=fbink alloc_failed\n");
    return 0;
  }

  drawCurrentDashboard(&canvas, dashboard, status);
  const char* path = "/tmp/kindle-dashboard-render.pgm";
  if (!writePgm(path, &canvas)) {
    free(canvas.pixels);
    fprintf(stderr, "render=fbink pgm_failed\n");
    return 0;
  }
  if (save_pgm && save_pgm[0]) {
    writePgm(save_pgm, &canvas);
    fprintf(stderr, "render=save-pgm %s width=%d height=%d\n", save_pgm, canvas.width, canvas.height);
  }
  free(canvas.pixels);

  char quoted_path[180];
  char command[420];
  shellQuote(path, quoted_path, sizeof(quoted_path));
  snprintf(command, sizeof(command), "fbink -c -W GC16 -g file=%s,w=-1,h=-1,dither >/dev/null", quoted_path);
  const int status_code = system(command);
  if (status_code == 0) {
    fprintf(stderr, "render=fbink ok image=%s\n", path);
    return 1;
  }

  fprintf(stderr, "render=fbink failed status=%d\n", status_code);
  return 0;
#endif
}

int fetchToCache(const char* url, const char* read_token, const char* cache) {
  const long long started = monotonicMs();
  char tmp[320];
  snprintf(tmp, sizeof(tmp), "%s.tmp", cache);
  char quoted_tmp[400];
  char quoted_url[400];
  char quoted_header[260];
  char command[1100];
  shellQuote(tmp, quoted_tmp, sizeof(quoted_tmp));
  shellQuote(url, quoted_url, sizeof(quoted_url));
  char header[200];
  header[0] = '\0';
  if (read_token && read_token[0]) {
    snprintf(header, sizeof(header), "X-Dashboard-Read-Token: %.150s", read_token);
    shellQuote(header, quoted_header, sizeof(quoted_header));
  } else {
    quoted_header[0] = '\0';
  }

  if (commandExists("curl")) {
    snprintf(command, sizeof(command), "curl -fsSL --connect-timeout 20 --max-time 55 --max-filesize %ld %s%s%s -o %s %s",
             kMaxDashboardPayloadBytes,
             quoted_header[0] ? "-H " : "",
             quoted_header[0] ? quoted_header : "",
             quoted_header[0] ? " " : "",
             quoted_tmp,
             quoted_url);
  } else if (commandExists("wget")) {
    snprintf(command, sizeof(command), "wget -q -T 55 %s%s%s -O %s %s",
             quoted_header[0] ? "--header=" : "",
             quoted_header[0] ? quoted_header : "",
             quoted_header[0] ? " " : "",
             quoted_tmp,
             quoted_url);
  } else {
    return 0;
  }

  if (system(command) != 0) {
    remove(tmp);
    fprintf(stderr, "timing=fetch ok=0 ms=%lld\n", monotonicMs() - started);
    return 0;
  }
  if (rename(tmp, cache) != 0) {
    remove(tmp);
    fprintf(stderr, "timing=fetch ok=0 ms=%lld\n", monotonicMs() - started);
    return 0;
  }
  char* payload_check = readFile(cache);
  if (!payload_check) {
    remove(cache);
    fprintf(stderr, "timing=fetch ok=0 oversized_or_unreadable ms=%lld\n", monotonicMs() - started);
    return 0;
  }
  free(payload_check);
  fprintf(stderr, "timing=fetch ok=1 ms=%lld\n", monotonicMs() - started);
  return 1;
}

int writeTextFileAtomic(const char* path, const char* data, size_t size) {
  if (!path || !path[0] || !data) return 0;
  char tmp[320];
  snprintf(tmp, sizeof(tmp), "%s.tmp", path);
  FILE* file = fopen(tmp, "wb");
  if (!file) return 0;
  const int ok = fwrite(data, 1, size, file) == size;
  fclose(file);
  if (!ok) {
    remove(tmp);
    return 0;
  }
  if (rename(tmp, path) != 0) {
    remove(tmp);
    return 0;
  }
  return 1;
}

const char* findItemObjectById(const char* payload, const char* item_id, const char** object_end) {
  if (!payload || !item_id || !item_id[0]) return NULL;
  const char* cursor = payload;
  while ((cursor = strstr(cursor, item_id)) != NULL) {
    const char* object_start = cursor;
    while (object_start > payload && *object_start != '{') object_start--;
    if (*object_start != '{') {
      cursor += strlen(item_id);
      continue;
    }

    const char* end = matchingClose(object_start, '}');
    if (!end || cursor > end) {
      cursor += strlen(item_id);
      continue;
    }

    char parsed_id[48];
    extractString(object_start, end, "id", parsed_id, sizeof(parsed_id), "");
    if (strcmp(parsed_id, item_id) == 0) {
      if (object_end) *object_end = end;
      return object_start;
    }
    cursor += strlen(item_id);
  }
  return NULL;
}

int patchCachedItemDone(const char* cache, const char* item_id, int done) {
  char* payload = readFile(cache);
  if (!payload) return 0;

  const char* object_end = NULL;
  const char* object_start = findItemObjectById(payload, item_id, &object_end);
  const char* done_value = object_start ? findKeyInRange(object_start, object_end, "done") : NULL;
  if (!done_value || (strncmp(done_value, "true", 4) != 0 && strncmp(done_value, "false", 5) != 0)) {
    free(payload);
    return 0;
  }

  const char* replacement = done ? "true" : "false";
  const size_t old_value_len = strncmp(done_value, "true", 4) == 0 ? 4 : 5;
  const size_t replacement_len = strlen(replacement);
  const size_t payload_len = strlen(payload);
  const size_t prefix_len = static_cast<size_t>(done_value - payload);
  const size_t suffix_offset = prefix_len + old_value_len;
  const size_t suffix_len = payload_len - suffix_offset;
  const size_t next_len = prefix_len + replacement_len + suffix_len;

  char* next_payload = static_cast<char*>(malloc(next_len + 1));
  if (!next_payload) {
    free(payload);
    return 0;
  }
  memcpy(next_payload, payload, prefix_len);
  memcpy(next_payload + prefix_len, replacement, replacement_len);
  memcpy(next_payload + prefix_len + replacement_len, payload + suffix_offset, suffix_len);
  next_payload[next_len] = '\0';

  const int ok = writeTextFileAtomic(cache, next_payload, next_len);
  free(next_payload);
  free(payload);
  fprintf(stderr, "toggle=optimistic-cache ok=%d id=%s done=%d\n", ok, item_id, done);
  return ok;
}

void buildDashboardUrl(const char* base_url, char* out, size_t out_size) {
  if (!out || out_size == 0) return;
  snprintf(out, out_size, "%s", base_url ? base_url : "");
}

int postToggleItemAsync(const char* toggle_url, const char* toggle_token, const char* item_id, int done) {
  if (!toggle_url || !toggle_url[0] || !toggle_token || !toggle_token[0] || !item_id || !item_id[0]) {
    fprintf(stderr, "toggle=post-skipped missing_config id=%s\n", item_id ? item_id : "");
    return 0;
  }

  char escaped_id[120];
  jsonEscapeString(item_id, escaped_id, sizeof(escaped_id));
  char body[180];
  snprintf(body, sizeof(body), "{\"id\":\"%s\",\"done\":%s}", escaped_id, done ? "true" : "false");
  char header[200];
  snprintf(header, sizeof(header), "X-Dashboard-Toggle-Token: %.150s", toggle_token);

  char quoted_body[240];
  char quoted_header[260];
  char quoted_url[400];
  char command[900];
  shellQuote(body, quoted_body, sizeof(quoted_body));
  shellQuote(header, quoted_header, sizeof(quoted_header));
  shellQuote(toggle_url, quoted_url, sizeof(quoted_url));
  if (commandExists("curl")) {
    snprintf(command, sizeof(command),
             "curl -fsSL --connect-timeout 5 --max-time 12 -X POST -H 'Content-Type: application/json' -H %s -d %s %s >/dev/null 2>&1 &",
             quoted_header, quoted_body, quoted_url);
  } else if (commandExists("wget")) {
    snprintf(command, sizeof(command),
             "wget -q -T 12 --header='Content-Type: application/json' --header=%s --post-data=%s -O /dev/null %s >/dev/null 2>&1 &",
             quoted_header, quoted_body, quoted_url);
  } else {
    fprintf(stderr, "toggle=post-skipped missing_http_client id=%s\n", item_id);
    return 0;
  }

  const int status = system(command);
  if (status != 0) fprintf(stderr, "toggle=post-start-failed status=%d id=%s\n", status, item_id);
  else fprintf(stderr, "toggle=post-background id=%s done=%d\n", item_id, done);
  return status == 0;
}

int handlePendingTouch(const Options* options) {
  const TouchAction action = g_pending_action;
  const int touch_x = g_pending_touch_x;
  const int touch_y = g_pending_touch_y;
  g_pending_action = kTouchNone;
  g_pending_touch_x = -1;
  g_pending_touch_y = -1;
  showTouchVisualFeedback(action, touch_x, touch_y);
  g_pending_touch_rect_valid = 0;

  if (action == kTouchExit) {
    fprintf(stderr, "touch=exit\n");
    // Join the watcher first: returnToKindleHome() restores the frontlight, and an
    // idle timeout firing in the watcher right after that would turn it straight back
    // off. Safe from here - this runs on the main thread, never on the watcher.
    stopTouchWatcher();
    returnToKindleHome();
    g_running = 0;
    return 1;
  }

  if (action == kTouchBack || action == kTouchHome) {
    fprintf(stderr, "touch=%s\n", action == kTouchBack ? "back" : "home");
    g_active_list = -1;
    return 1;
  }

  if (action == kTouchOpenList) {
    fprintf(stderr, "touch=open-list index=%d\n", g_pending_list_index);
    g_active_list = g_pending_list_index;
    return 1;
  }

  if (action == kTouchToggleItem) {
    const int next_done = g_pending_item_done ? 0 : 1;
    fprintf(stderr, "touch=toggle-list-item id=%s done=%d\n", g_pending_item_id, next_done);
    patchCachedItemDone(options->cache, g_pending_item_id, next_done);
    postToggleItemAsync(options->toggle_url, options->toggle_token, g_pending_item_id, next_done);
    return 1;
  }

  if (action == kTouchToggleLock) {
    // Always a lock, never a toggle: this action cannot fire while already locked (see
    // the enum comment), so there is nothing to toggle away from.
    g_screen_locked = 1;
    fprintf(stderr, "touch=lock-screen\n");
    return 1;
  }

  if (action == kTouchHardwareUnlock) {
    g_screen_locked = 0;
    fprintf(stderr, "touch=hardware-unlock\n");
    return 1;
  }

  return 0;
}

#ifdef __linux__
struct TouchWatcherArgs {
  TouchInput* touch;
};

// Kept joinable (not detached) so shutdown can wait for it. The watcher calls
// turnOffFrontlightIfIdle(), so if it were still running while main restores the
// frontlight, a timeout firing in that window would push setFrontlightLevel(0)
// *after* the restore and leave the device dark - the exact failure the restore
// exists to prevent. The loop only ever blocks on a 250ms usleep (the touch fds are
// non-blocking), so the join returns promptly.
pthread_t g_touch_watcher_thread;
volatile sig_atomic_t g_touch_watcher_running = 0;

void* touchWatcherMain(void* raw) {
  TouchWatcherArgs* args = static_cast<TouchWatcherArgs*>(raw);
  TouchInput* touch = args ? args->touch : NULL;
  free(args);
  if (!touch) return NULL;

  // Checks its own flag too, not just g_running: the on-screen EXIT path leaves
  // g_running set and still needs the watcher stopped before the frontlight restore.
  while (g_running && g_touch_watcher_running) {
    pollExitTouch(touch);
    pollPowerButtonUnlock(touch);
    turnOffFrontlightIfIdle(touch->last_action_ms);
    usleep(250000);
  }
  return NULL;
}

void startTouchWatcher(TouchInput* touch) {
  // Started for the power button alone too, not just touch devices: a Kindle with no
  // detected touchscreen (unexpected, but initTouchInput() logs it either way) should still
  // be able to unlock, if it ever somehow got locked to begin with.
  if (!touch || (touch->count <= 0 && touch->power_fd < 0)) return;
  TouchWatcherArgs* args = static_cast<TouchWatcherArgs*>(calloc(1, sizeof(TouchWatcherArgs)));
  if (!args) return;
  args->touch = touch;
  g_touch_watcher_running = 1;
  if (pthread_create(&g_touch_watcher_thread, NULL, touchWatcherMain, args) != 0) {
    fprintf(stderr, "input=thread_failed\n");
    g_touch_watcher_running = 0;
    free(args);
    return;
  }
  fprintf(stderr, "input=thread_started\n");
}

// Must be called before closeTouchInput() (the watcher reads those fds) and before
// the frontlight is restored.
void stopTouchWatcher() {
  if (!g_touch_watcher_running) return;
  g_touch_watcher_running = 0;
  pthread_join(g_touch_watcher_thread, NULL);
  fprintf(stderr, "input=thread_stopped\n");
}
#else
void startTouchWatcher(TouchInput*) {}
void stopTouchWatcher() {}
#endif

struct EventWatcherArgs {
  char events_url[256];
  char read_token[160];
  int sleep_start_minute;
  int sleep_end_minute;
};

int parseClockMinute(const char* text, int* minute) {
  int hour = -1;
  int min = -1;
  char tail = '\0';
  if (!text || sscanf(text, "%d:%d%c", &hour, &min, &tail) != 2) return 0;
  if (hour < 0 || hour > 23 || min < 0 || min > 59) return 0;
  *minute = hour * 60 + min;
  return 1;
}

int parseSleepWindow(const char* text, int* start_minute, int* end_minute) {
  if (!text || !text[0] || strcmp(text, "off") == 0 || strcmp(text, "none") == 0) {
    *start_minute = -1;
    *end_minute = -1;
    return 1;
  }

  const char* dash = strchr(text, '-');
  if (!dash) return 0;

  char start[8];
  char end[8];
  const size_t start_len = static_cast<size_t>(dash - text);
  if (start_len == 0 || start_len >= sizeof(start)) return 0;
  const size_t end_len = strlen(dash + 1);
  if (end_len == 0 || end_len >= sizeof(end)) return 0;

  memcpy(start, text, start_len);
  start[start_len] = '\0';
  memcpy(end, dash + 1, end_len + 1);
  return parseClockMinute(start, start_minute) && parseClockMinute(end, end_minute);
}

int currentLocalMinute() {
  time_t now = time(NULL);
  struct tm local_time;
#if defined(_POSIX_THREAD_SAFE_FUNCTIONS) || defined(__linux__)
  localtime_r(&now, &local_time);
#else
  struct tm* local_ptr = localtime(&now);
  if (!local_ptr) return 0;
  local_time = *local_ptr;
#endif
  return local_time.tm_hour * 60 + local_time.tm_min;
}

int inSleepWindow(int start_minute, int end_minute) {
  if (start_minute < 0 || end_minute < 0 || start_minute == end_minute) return 0;
  const int now = currentLocalMinute();
  if (start_minute < end_minute) return now >= start_minute && now < end_minute;
  return now >= start_minute || now < end_minute;
}

void* eventWatcherMain(void* raw) {
  EventWatcherArgs* args = static_cast<EventWatcherArgs*>(raw);
  if (!args || !args->events_url[0]) return NULL;
  if (!commandExists("curl")) {
    fprintf(stderr, "events=disabled missing_curl\n");
    free(args);
    return NULL;
  }

  char quoted_url[400];
  char quoted_header[260];
  shellQuote(args->events_url, quoted_url, sizeof(quoted_url));
  char header[200];
  header[0] = '\0';
  if (args->read_token[0]) {
    snprintf(header, sizeof(header), "X-Dashboard-Read-Token: %.150s", args->read_token);
    shellQuote(header, quoted_header, sizeof(quoted_header));
  } else {
    quoted_header[0] = '\0';
  }
  fprintf(stderr, "events=watching %s\n", args->events_url);

  while (g_running) {
    if (inSleepWindow(args->sleep_start_minute, args->sleep_end_minute)) {
      fprintf(stderr, "events=quiet\n");
      sleep(60);
      continue;
    }

    char command[900];
    snprintf(command, sizeof(command), "curl -fsSL --no-buffer --connect-timeout 20 --max-time 65 %s%s%s %s 2>/dev/null",
             quoted_header[0] ? "-H " : "",
             quoted_header[0] ? quoted_header : "",
             quoted_header[0] ? " " : "",
             quoted_url);
    FILE* stream = popen(command, "r");
    if (!stream) {
      fprintf(stderr, "events=popen_failed\n");
      sleep(10);
      continue;
    }

    char line_buffer[512];
    while (g_running && fgets(line_buffer, sizeof(line_buffer), stream)) {
      if (inSleepWindow(args->sleep_start_minute, args->sleep_end_minute)) {
        fprintf(stderr, "events=quiet close_stream=1\n");
        break;
      }
      if (strncmp(line_buffer, "event: planner", 14) == 0) {
        g_event_refresh = 1;
        fprintf(stderr, "events=planner refresh=1\n");
      } else if (strncmp(line_buffer, "event: planner-error", 20) == 0) {
        fprintf(stderr, "events=planner-error\n");
      }
    }

    const int status = pclose(stream);
    if (g_running) {
      fprintf(stderr, "events=reconnect status=%d\n", status);
      sleep(2);
    }
  }

  free(args);
  return NULL;
}

void startEventWatcher(const char* events_url, const char* read_token, int sleep_start_minute, int sleep_end_minute) {
  if (!events_url || !events_url[0]) {
    fprintf(stderr, "events=disabled empty_url\n");
    return;
  }

  EventWatcherArgs* args = static_cast<EventWatcherArgs*>(calloc(1, sizeof(EventWatcherArgs)));
  if (!args) {
    fprintf(stderr, "events=alloc_failed\n");
    return;
  }
  copyText(args->events_url, sizeof(args->events_url), events_url);
  if (read_token) copyText(args->read_token, sizeof(args->read_token), read_token);
  args->sleep_start_minute = sleep_start_minute;
  args->sleep_end_minute = sleep_end_minute;

  pthread_t thread;
  if (pthread_create(&thread, NULL, eventWatcherMain, args) != 0) {
    fprintf(stderr, "events=thread_failed\n");
    free(args);
    return;
  }
  pthread_detach(thread);
}

int dumpBitmapPreview(const Dashboard* dashboard, const char* status, const char* path, int width, int height) {
  if (!path || !path[0]) return 0;
  Canvas canvas;
  canvas.width = width > 0 ? width : kBitmapFallbackWidth;
  canvas.height = height > 0 ? height : kBitmapFallbackHeight;
  canvas.pixels = static_cast<unsigned char*>(calloc(static_cast<size_t>(canvas.width) * static_cast<size_t>(canvas.height), 1));
  if (!canvas.pixels) return 0;
  drawCurrentDashboard(&canvas, dashboard, status);
  const int ok = writePgm(path, &canvas);
  free(canvas.pixels);
  return ok;
}

void renderPayload(const char* payload, const char* status, const char* dump_pgm, const char* save_pgm, int dump_width, int dump_height, RenderMode mode = kRenderForce) {
  const long long started = monotonicMs();
  g_last_render_skipped = 0;
  char lines[kMaxRows][96];
  Dashboard dashboard;
  if (!parseDashboard(payload, &dashboard)) {
    int count = 0;
    addRule(lines, &count);
    addCardText(lines, &count, " PAINEL KINDLE");
    addCardText(lines, &count, " Painel indisponivel");
    addCardText(lines, &count, " Dados do painel invalidos");
    addRule(lines, &count);
    renderToEips(lines, count);
    fprintf(stderr, "timing=render status=parse_failed ms=%lld\n", monotonicMs() - started);
    return;
  }
  if (dump_pgm && dump_pgm[0]) {
    dumpBitmapPreview(&dashboard, status, dump_pgm, dump_width, dump_height);
    fprintf(stderr, "render=pgm %s width=%d height=%d\n", dump_pgm, dump_width > 0 ? dump_width : kBitmapFallbackWidth, dump_height > 0 ? dump_height : kBitmapFallbackHeight);
    freeDashboard(&dashboard);
    fprintf(stderr, "timing=render status=dump ms=%lld\n", monotonicMs() - started);
    return;
  }
  // Everything that changes the pixels: data version, the header's date + status line,
  // which view is open, the lock icon and the theme.
  char signature[sizeof(g_last_drawn_signature)];
  char date_line[96];
  formatDisplayDate(dashboard.generated_at, status, date_line, sizeof(date_line));
  snprintf(signature, sizeof(signature), "%.31s|%.96s|%d|%d|%d", dashboard.version, date_line, g_active_list, g_screen_locked, g_dark_mode);
  if (mode == kRenderIfChanged && g_last_drawn_signature[0] && strcmp(signature, g_last_drawn_signature) == 0 &&
      started - g_last_drawn_ms < kForcedRedrawMs) {
    g_last_render_skipped = 1;
    fprintf(stderr, "render=skip unchanged version=%s\n", dashboard.version);
    freeDashboard(&dashboard);
    return;
  }
  if (renderViaFbink(&dashboard, status, save_pgm) || renderToFramebuffer(&dashboard, status, save_pgm)) {
    if (mode == kRenderForce) {
      g_last_drawn_signature[0] = '\0';
    } else {
      copyText(g_last_drawn_signature, sizeof(g_last_drawn_signature), signature);
      g_last_drawn_ms = started;
    }
    freeDashboard(&dashboard);
    fprintf(stderr, "timing=render status=drawn mode=%d ms=%lld\n", static_cast<int>(mode), monotonicMs() - started);
    return;
  }
  g_last_drawn_signature[0] = '\0';
  if (save_pgm && save_pgm[0]) {
    dumpBitmapPreview(&dashboard, status, save_pgm, kBitmapFallbackWidth, kBitmapFallbackHeight);
    fprintf(stderr, "render=save-pgm %s width=%d height=%d fallback=1\n", save_pgm, kBitmapFallbackWidth, kBitmapFallbackHeight);
  }
  if (getenv("KINDLE_DASHBOARD_TEXT_FALLBACK") == NULL) {
    fprintf(stderr, "render=bitmap unavailable text_fallback=disabled\n");
    freeDashboard(&dashboard);
    fprintf(stderr, "timing=render status=bitmap_unavailable ms=%lld\n", monotonicMs() - started);
    return;
  }
  fprintf(stderr, "render=eips fallback\n");
  const int count = renderLines(&dashboard, status, lines);
  renderToEips(lines, count);
  freeDashboard(&dashboard);
  fprintf(stderr, "timing=render status=eips ms=%lld\n", monotonicMs() - started);
}

int renderCachedPayload(const Options* options, const char* status, RenderMode mode = kRenderForce) {
  g_last_render_skipped = 0;
  char* payload = readFile(options->cache);
  if (!payload) {
    fprintf(stderr, "render=cache-miss path=%s\n", options->cache);
    return 0;
  }
  renderPayload(payload, status, options->dump_pgm, options->save_pgm, options->dump_width, options->dump_height, mode);
  free(payload);
  return 1;
}

int shouldRepaintCachedTick(int tick) {
  return tick == 5;
}

int waitForWakeEvent(const Options* options, int seconds, int allow_repaint) {
  for (int elapsed = 1; elapsed <= seconds && g_running; elapsed++) {
    if (g_pending_action != kTouchNone) {
      const int touch_result = handlePendingTouch(options);
      if (!g_running) return 0;
      if (touch_result == 1) renderCachedPayload(options, g_last_fetch_status);
      continue;
    }
    if (g_event_refresh) {
      fprintf(stderr, "events=refresh_now\n");
      return 1;
    }
    if (allow_repaint && shouldRepaintCachedTick(elapsed)) {
      fprintf(stderr, "render=repaint tick=%d\n", elapsed);
      // After a fetch draw this is the same data and status, so it may keep the signature.
      // After a touch draw the signature is already cleared and must stay that way.
      renderCachedPayload(options, g_last_fetch_status, g_last_drawn_signature[0] ? kRenderRecord : kRenderForce);
    }
    sleep(1);
  }
  return 1;
}

void handleSignal(int) {
  g_running = 0;
}

void applyInitialView(const char* view) {
  if (!view || !view[0]) return;
  g_active_list = -1;
  if (strcmp(view, "chores") == 0) g_active_list = 0;
  else if (strcmp(view, "grocery") == 0) g_active_list = 1;
}

void initOptions(Options* options) {
  copyText(options->url, sizeof(options->url), kDefaultUrl);
  copyText(options->events_url, sizeof(options->events_url), kDefaultEventsUrl);
  copyText(options->toggle_url, sizeof(options->toggle_url), kDefaultToggleUrl);
  options->read_token[0] = '\0';
  options->title[0] = '\0';
  options->toggle_token[0] = '\0';
  copyText(options->cache, sizeof(options->cache), kDefaultCache);
  options->render_only[0] = '\0';
  options->view[0] = '\0';
  options->dump_pgm[0] = '\0';
  options->save_pgm[0] = '\0';
  copyText(options->photo_path, sizeof(options->photo_path), kDefaultPhotoPath);
  options->dump_width = kBitmapFallbackWidth;
  options->dump_height = kBitmapFallbackHeight;
  options->interval = kDefaultIntervalSeconds;
  parseSleepWindow(kDefaultSleepWindow, &options->sleep_start_minute, &options->sleep_end_minute);
  options->once = 0;
  options->dark = 0;
}

int parseOptions(int argc, char** argv, Options* options) {
  initOptions(options);
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--url") == 0 && i + 1 < argc) copyText(options->url, sizeof(options->url), argv[++i]);
    else if (strcmp(argv[i], "--events-url") == 0 && i + 1 < argc) copyText(options->events_url, sizeof(options->events_url), argv[++i]);
    else if (strcmp(argv[i], "--toggle-url") == 0 && i + 1 < argc) copyText(options->toggle_url, sizeof(options->toggle_url), argv[++i]);
    else if (strcmp(argv[i], "--read-token") == 0 && i + 1 < argc) copyText(options->read_token, sizeof(options->read_token), argv[++i]);
    else if (strcmp(argv[i], "--toggle-token") == 0 && i + 1 < argc) copyText(options->toggle_token, sizeof(options->toggle_token), argv[++i]);
    else if (strcmp(argv[i], "--cache") == 0 && i + 1 < argc) copyText(options->cache, sizeof(options->cache), argv[++i]);
    else if (strcmp(argv[i], "--interval") == 0 && i + 1 < argc) {
      options->interval = atoi(argv[++i]);
      if (options->interval < 5) options->interval = 5;
    } else if (strcmp(argv[i], "--sleep-window") == 0 && i + 1 < argc) {
      if (!parseSleepWindow(argv[++i], &options->sleep_start_minute, &options->sleep_end_minute)) {
        fprintf(stderr, "Invalid sleep window. Use HH:MM-HH:MM or off, for example 00:00-08:00.\n");
        return 0;
      }
    } else if (strcmp(argv[i], "--once") == 0) options->once = 1;
    else if (strcmp(argv[i], "--dark") == 0) options->dark = 1;
    // The old name for the same thing, still passed by any config.sh written before --dark
    // existed. It used to counter-invert bitmaps under the Kindle's OS-level dark mode and then
    // did nothing at all once the cover images were dropped, so "Start (dark)" rendered exactly
    // like light. It now means what the menu entry always claimed it meant.
    else if (strcmp(argv[i], "--invert-images") == 0) options->dark = 1;
    else if (strcmp(argv[i], "--render") == 0 && i + 1 < argc) copyText(options->render_only, sizeof(options->render_only), argv[++i]);
    else if (strcmp(argv[i], "--view") == 0 && i + 1 < argc) copyText(options->view, sizeof(options->view), argv[++i]);
    else if (strcmp(argv[i], "--dump-pgm") == 0 && i + 1 < argc) copyText(options->dump_pgm, sizeof(options->dump_pgm), argv[++i]);
    else if (strcmp(argv[i], "--dump-size") == 0 && i + 1 < argc) {
      if (sscanf(argv[++i], "%dx%d", &options->dump_width, &options->dump_height) != 2 ||
          options->dump_width < 240 || options->dump_height < 320) {
        fprintf(stderr, "Invalid dump size. Use WIDTHxHEIGHT, for example 1072x1448.\n");
        return 0;
      }
    }
    else if (strcmp(argv[i], "--save-pgm") == 0 && i + 1 < argc) copyText(options->save_pgm, sizeof(options->save_pgm), argv[++i]);
    else if (strcmp(argv[i], "--photo") == 0 && i + 1 < argc) copyText(options->photo_path, sizeof(options->photo_path), argv[++i]);
    else if (strcmp(argv[i], "--title") == 0 && i + 1 < argc) copyText(options->title, sizeof(options->title), argv[++i]);
    else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      printf("Usage: %s [--url URL] [--events-url URL] [--toggle-url URL] [--read-token TOKEN] [--toggle-token TOKEN] [--cache PATH] [--interval SECONDS] [--sleep-window HH:MM-HH:MM|off] [--photo PGM_PATH] [--title TEXT] [--once] [--dark]\n", argv[0]);
      printf("       %s --render PATH [--view chores|grocery] [--title TEXT] [--dark] [--dump-pgm PATH] [--dump-size WIDTHxHEIGHT] [--save-pgm PATH]\n", argv[0]);
      exit(0);
    } else {
      fprintf(stderr, "Unknown or incomplete argument: %s\n", argv[i]);
      return 0;
    }
  }
  return 1;
}

}  // namespace

int main(int argc, char** argv) {
  // stderr is redirected to a log file by the KUAL wrapper scripts. It is already unbuffered by
  // default, but state it explicitly: this is a long-running background process whose log is the
  // only way to diagnose it, so no diagnostic may be left sitting in a buffer if it is killed or
  // crashes.
  setvbuf(stderr, NULL, _IONBF, 0);
  Options options;
  if (!parseOptions(argc, argv, &options)) return 1;
  copyText(g_photo_path, sizeof(g_photo_path), options.photo_path);
  if (options.title[0]) upperCopy(g_title, sizeof(g_title), options.title);
  g_dark_mode = options.dark;
  if (g_dark_mode) fprintf(stderr, "options=dark-mode enabled\n");

  if (options.render_only[0]) {
    applyInitialView(options.view);
    char* payload = readFile(options.render_only);
    if (!payload) {
      fprintf(stderr, "Could not read %s\n", options.render_only);
      return 1;
    }
    renderPayload(payload, "fixture", options.dump_pgm, options.save_pgm, options.dump_width, options.dump_height);
    free(payload);
    return 0;
  }

  signal(SIGINT, handleSignal);
  signal(SIGTERM, handleSignal);
  applyInitialView(options.view);

  TouchInput touch;
  initTouchInput(&touch);
  startTouchWatcher(&touch);
  if (!options.once && !options.render_only[0]) {
    // Only for the long-running "Start Dashboard" mode: a one-off "Refresh
    // Once" run exits right after rendering, so turning the light off here
    // would just leave the screen dark with no touch loop left to relight it.
    initFrontlightPowerManagement();
    startEventWatcher(options.events_url, options.read_token, options.sleep_start_minute, options.sleep_end_minute);
  }

  while (g_running) {
    int pending_result = 0;
    if (g_pending_action != kTouchNone) pending_result = handlePendingTouch(&options);
    if (!g_running) break;
    if (pending_result == 1 && renderCachedPayload(&options, g_last_fetch_status)) {
      g_event_refresh = 0;
      if (options.once) break;
      for (int remaining = options.interval; remaining > 0 && g_running;) {
        if (inSleepWindow(options.sleep_start_minute, options.sleep_end_minute)) break;
        const int chunk = remaining > 60 ? 60 : remaining;
        waitForWakeEvent(&options, chunk, remaining == options.interval);
        if (g_event_refresh) break;
        remaining -= chunk;
      }
      continue;
    }
    g_event_refresh = 0;

    if (!options.once && inSleepWindow(options.sleep_start_minute, options.sleep_end_minute)) {
      fprintf(stderr, "power=quiet sleep_window=1\n");
      if (!renderCachedPayload(&options, "sleep/quiet")) {
        char lines[kMaxRows][96];
        int count = 0;
        addRule(lines, &count);
        addCardText(lines, &count, " PAINEL KINDLE");
        addCardText(lines, &count, " Horario de silencio");
        addCardText(lines, &count, " Cache indisponivel");
        addRule(lines, &count);
        renderToEips(lines, count);
      }
      while (g_running && inSleepWindow(options.sleep_start_minute, options.sleep_end_minute)) {
        waitForWakeEvent(&options, 60, 0);
        if (g_manual_fetch_refresh) break;
        g_event_refresh = 0;
      }
      if (!g_manual_fetch_refresh) continue;
      fprintf(stderr, "power=quiet manual_fetch=1\n");
      g_manual_fetch_refresh = 0;
      g_event_refresh = 0;
    }

    if (g_manual_fetch_refresh) {
      fprintf(stderr, "events=manual-fetch\n");
      g_manual_fetch_refresh = 0;
    }
    char dashboard_url[320];
    buildDashboardUrl(options.url, dashboard_url, sizeof(dashboard_url));
    const int fetched = fetchToCache(dashboard_url, options.read_token, options.cache);
    copyText(g_last_fetch_status, sizeof(g_last_fetch_status), fetched ? "live" : "cached/offline");
    if (!renderCachedPayload(&options, g_last_fetch_status, kRenderIfChanged)) {
      char lines[kMaxRows][96];
      int count = 0;
      addRule(lines, &count);
      addCardText(lines, &count, " PAINEL KINDLE");
      addCardText(lines, &count, " Painel indisponivel");
      addCardText(lines, &count, " Verifique o Wi-Fi ou tente depois");
      addRule(lines, &count);
      renderToEips(lines, count);
    }

    if (options.once) break;
    const int drew = !g_last_render_skipped;
    for (int remaining = options.interval; remaining > 0 && g_running;) {
      if (inSleepWindow(options.sleep_start_minute, options.sleep_end_minute)) break;
      const int chunk = remaining > 60 ? 60 : remaining;
      waitForWakeEvent(&options, chunk, drew && remaining == options.interval);
      if (g_event_refresh) break;
      remaining -= chunk;
    }
  }

  // Order matters: join the watcher before closing the fds it reads, and before the
  // frontlight restore below, so it cannot turn the light back off afterwards.
  stopTouchWatcher();
  closeTouchInput(&touch);
  // Covers the "Stop Dashboard" KUAL menu path (SIGTERM -> g_running=0 here),
  // as opposed to the on-screen EXIT button which already restores it via
  // returnToKindleHome(). Without this, stopping via the menu could strand
  // the frontlight off if it happened to be in its idle-timeout state.
  if (g_frontlight_saved_level >= 0) setFrontlightLevel(g_frontlight_saved_level);
  return 0;
}
