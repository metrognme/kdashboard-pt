import { createAdminClient } from "npm:@insforge/sdk";

// Must stay in sync with kindle-dashboard-data.ts: any list the dashboard renders
// has to be part of the version hash below, or writes to it never push an update.
type ListKey = "grocery" | "todo" | "notes";

type PlannerItem = {
  id: string;
  list_key: ListKey;
  text: string;
  done: boolean;
  created_at: string;
  updated_at: string;
};

type DashboardData = {
  items: PlannerItem[];
};

export default function(req: Request): Response {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  if (!isAuthorizedDashboardRead(req)) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" }
    });
  }

  const encoder = new TextEncoder();
  let lastVersion = "";
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      async function pushIfChanged() {
        if (closed) return;
        try {
          const data = await loadDashboardData();
          if (closed) return;
          const version = getDashboardVersion(data);
          if (version === lastVersion) {
            controller.enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
            return;
          }

          lastVersion = version;
          controller.enqueue(encoder.encode(`event: planner\n`));
          controller.enqueue(encoder.encode(`data: ${version}\n\n`));
        } catch (error) {
          controller.enqueue(encoder.encode(`event: planner-error\n`));
          controller.enqueue(encoder.encode(`data: ${errorMessage(error)}\n\n`));
        }
      }

      // The client is forced to reconnect roughly every 55s (this function's own
      // timeout below), and each connection starts with no memory of the last
      // one - lastVersion resets to "" every time. Emitting a forced "planner"
      // event here used to treat that reset as "something changed" on every
      // single reconnect, which made the Kindle refetch and fully repaint the
      // e-ink screen roughly once a minute all day, rather than only when a
      // list actually changed. Priming lastVersion silently, and only ever
      // emitting "planner" from the genuine-change check below, means a
      // reconnect that finds nothing new stays quiet.
      async function primeBaseline() {
        if (closed) return;
        try {
          const data = await loadDashboardData();
          if (closed) return;
          lastVersion = getDashboardVersion(data);
        } catch (error) {
          controller.enqueue(encoder.encode(`event: planner-error\n`));
          controller.enqueue(encoder.encode(`data: ${errorMessage(error)}\n\n`));
        }
      }

      controller.enqueue(encoder.encode(`: connected ${new Date().toISOString()}\n\n`));
      void primeBaseline();
      intervalId = setInterval(() => void pushIfChanged(), 2000);
      timeoutId = setTimeout(() => {
        closed = true;
        if (intervalId) clearInterval(intervalId);
        controller.close();
      }, 55000);
    },
    cancel() {
      closed = true;
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

async function loadDashboardData(): Promise<DashboardData> {
  const started = timeMs();
  const admin = createAdminClient({
    baseUrl: requiredEnv("INSFORGE_BASE_URL"),
    apiKey: requiredEnv("INSFORGE_API_KEY")
  });

  const { data: items, error: itemsError } = await admin.database
    .from("planner_items")
    .select("id,list_key,text,done,created_at,updated_at")
    .in("list_key", ["todo", "grocery", "notes"])
    .order("created_at", { ascending: false });
  if (itemsError) throw itemsError;

  const payload = { items: items as PlannerItem[] };
  logTiming("kindle-dashboard-events", { total_ms: elapsedMs(started) });
  return payload;
}

function getDashboardVersion(data: DashboardData): string {
  return hashText(JSON.stringify({
    items: [...data.items].sort((a, b) => a.updated_at.localeCompare(b.updated_at))
  }));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
