import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const schemaMigrations = [
  "migrations/001_planner_items.sql",
  "migrations/002_enable_rls_private_tables.sql",
  "migrations/003_planner_items_allow_notes.sql",
  "migrations/004_bot_actions.sql",
  "migrations/005_bot_parse_cache.sql",
  "migrations/006_daily_digest.sql",
  "migrations/007_important_flag.sql"
];

const functions = [
  ["kindle-dashboard-data", "functions/kindle-dashboard-data.ts", "Kindle Dashboard Data"],
  ["kindle-dashboard-events", "functions/kindle-dashboard-events.ts", "Kindle Dashboard Events"],
  ["kindle-dashboard-toggle", "functions/kindle-dashboard-toggle.ts", "Kindle Dashboard Toggle"],
  ["telegram-webhook", "functions/telegram-webhook.ts", "Telegram Planner Webhook"]
];

const flags = new Set(process.argv.slice(2));
const skipSecrets = flags.has("--skip-secrets");
const skipDeploy = flags.has("--skip-deploy");

if (flags.has("--help")) {
  console.log(`Usage: npm run kit:backend -- [--skip-secrets] [--skip-deploy]

Applies the public Kindle Dashboard schema to the currently linked InsForge
project, creates missing generated secrets, and deploys edge functions.

Before running:
  npx @insforge/cli login
  npx @insforge/cli create --name kindle-dashboard --region us-east --template empty

Afterwards, set the secrets that cannot be generated automatically (LLM_API_KEY,
WEATHER_LAT, WEATHER_LON, CALDAV_BASE_URL, CALDAV_USERNAME, CALDAV_PASSWORD,
CALDAV_CALENDAR_PATH, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_ID) with:
  npx @insforge/cli secrets add <KEY> <VALUE>
`);
  process.exit(0);
}

console.log("Checking linked InsForge project...");
run(["current"]);

console.log("Applying schema migrations...");
for (const migration of schemaMigrations) {
  applyMigration(migration);
}

if (!skipSecrets) {
  console.log("Ensuring generated backend secrets exist...");
  ensureSecret("TELEGRAM_WEBHOOK_SECRET", randomSecret());
  ensureSecret("DASHBOARD_READ_TOKEN", randomSecret());
  ensureSecret("DASHBOARD_TOGGLE_TOKEN", randomSecret());
  ensureSecret("DAILY_DIGEST_TOKEN", randomSecret());
}

if (!skipDeploy) {
  console.log("Deploying InsForge functions...");
  for (const [slug, file, name] of functions) {
    run(["functions", "deploy", slug, "--file", file, "--name", name]);
  }
}

console.log("Backend kit bootstrap complete.");
console.log("Next: set Telegram secrets with npm run telegram:configure, then copy the endpoints into kindle-dashboard/config.sh.");
console.log("Then: npm run digest:schedule -- --base-url <your INSFORGE_BASE_URL> to turn on the daily digest's hourly tick.");

function applyMigration(path) {
  console.log(`- ${path}`);
  // The "--" separator is required: a migration that opens with a SQL comment starts
  // with "--", which the CLI's argument parser would otherwise read as an option and
  // fail on. Everything after the separator is treated as positional.
  run(["db", "query", "--", readFileSync(path, "utf8")]);
}

function ensureSecret(key, value) {
  try {
    run(["secrets", "get", key, "--json"], { silent: true });
    console.log(`- ${key} already exists`);
  } catch {
    run(["secrets", "add", key, value]);
    console.log(`- added ${key}`);
  }
}

function randomSecret() {
  return randomBytes(32).toString("hex");
}

function run(args, options = {}) {
  const output = execFileSync("npx", ["@insforge/cli", ...args], {
    encoding: "utf8",
    stdio: options.silent ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  return output || "";
}
