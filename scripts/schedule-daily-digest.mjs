import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// One-time setup for the daily digest's automatic side: an hourly cron that
// posts to telegram-webhook, which decides on its own whether the current
// hour matches the locally-configured digest hour (see DIGEST_HOUR_SETTING
// in functions/telegram-webhook.ts). InsForge schedules carry no timezone, so
// "hourly, always" plus a config check in the function is what makes
// /resumo_hora take effect without ever touching this schedule again.

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const baseUrl = (args.get("--base-url") || process.env.INSFORGE_BASE_URL || "").replace(/\/+$/, "");
if (!baseUrl) {
  console.error("Usage: npm run digest:schedule -- --base-url https://your-project.region.insforge.app");
  process.exit(1);
}

const SCHEDULE_NAME = "Daily Digest Tick";
const url = `${baseUrl}/functions/telegram-webhook`;
const headers = JSON.stringify({ "X-Daily-Digest-Token": "${{secrets.DAILY_DIGEST_TOKEN}}" });

ensureSecret("DAILY_DIGEST_TOKEN", randomSecret());

const existing = findExistingSchedule();
if (existing) {
  run(["schedules", "update", existing.id, "--cron", "0 * * * *", "--url", url, "--method", "POST", "--headers", headers]);
  console.log(`Updated existing schedule (id ${existing.id}) to point at ${url}.`);
} else {
  run(["schedules", "create", "--name", SCHEDULE_NAME, "--cron", "0 * * * *", "--url", url, "--method", "POST", "--headers", headers]);
  console.log(`Created hourly schedule targeting ${url}.`);
}

console.log("It fires every hour; the function itself only acts during the configured digest hour (see /resumo_hora in the bot).");

function ensureSecret(key, value) {
  try {
    run(["secrets", "get", key, "--json"], { silent: true });
  } catch {
    run(["secrets", "add", key, value]);
    console.log(`- added ${key}`);
  }
}

function findExistingSchedule() {
  const output = run(["schedules", "list", "--json"], { silent: true });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : parsed.schedules ?? parsed.data ?? [];
  return list.find((schedule) => schedule.name === SCHEDULE_NAME) ?? null;
}

function randomSecret() {
  return randomBytes(32).toString("hex");
}

function run(args, options = {}) {
  return execFileSync("npx", ["@insforge/cli", ...args], {
    encoding: "utf8",
    stdio: options.silent ? ["ignore", "pipe", "pipe"] : "inherit"
  });
}
