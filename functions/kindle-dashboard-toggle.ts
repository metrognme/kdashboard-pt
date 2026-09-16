import { createAdminClient } from "npm:@insforge/sdk";

type ToggleRequest = {
  id?: string;
  done?: boolean;
};

export default async function(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const configuredToken = requiredEnv("DASHBOARD_TOGGLE_TOKEN");
  const receivedToken = req.headers.get("x-dashboard-toggle-token");
  if (!receivedToken || receivedToken !== configuredToken) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const body = await req.json() as ToggleRequest;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return jsonResponse({ ok: false, error: "Missing item id" }, 400);
    if (typeof body.done !== "boolean") return jsonResponse({ ok: false, error: "Missing done boolean" }, 400);

    const admin = createAdminClient({
      baseUrl: requiredEnv("INSFORGE_BASE_URL"),
      apiKey: requiredEnv("INSFORGE_API_KEY")
    });

    // completed_at is how the daily digest (telegram-webhook.ts) tells "finished
    // today" apart from "just moved lists today" — every write that flips `done`
    // must flip this too, not just the Telegram side of the bot.
    const { error } = await admin.database
      .from("planner_items")
      .update({
        done: body.done,
        completed_at: body.done ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      })
      .eq("id", id);

    if (error) throw error;
    return jsonResponse({ ok: true, item: { id, done: body.done } });
  } catch (error) {
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  }
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Dashboard-Toggle-Token"
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
