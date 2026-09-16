import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readLinkedProject, resolveBaseUrl } from "./insforge-project.mjs";

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
  ["kindle-dashboard-data", "functions/kindle-dashboard-data.ts", "Painel Kindle - Dados"],
  ["kindle-dashboard-events", "functions/kindle-dashboard-events.ts", "Painel Kindle - Eventos ao vivo"],
  ["kindle-dashboard-toggle", "functions/kindle-dashboard-toggle.ts", "Painel Kindle - Marcar itens"],
  ["telegram-webhook", "functions/telegram-webhook.ts", "Painel Kindle - Bot do Telegram"]
];

const flags = new Set(process.argv.slice(2));
const skipSecrets = flags.has("--skip-secrets");
const skipDeploy = flags.has("--skip-deploy");

if (flags.has("--help")) {
  console.log(`Uso: npm run kit:backend -- [--skip-secrets] [--skip-deploy]

Aplica o schema do Painel Kindle no projeto InsForge vinculado, cria os
segredos gerados que estiverem faltando e publica as edge functions.

Antes de rodar:
  npx @insforge/cli login
  npx @insforge/cli create --name kindle-dashboard --region us-east --template empty

INSFORGE_BASE_URL e INSFORGE_API_KEY sao lidos do .insforge/project.json
(criado pelo create/link). Depois, configure os segredos que so voce sabe
(WEATHER_LAT, WEATHER_LON e, se quiser, DASHBOARD_TIMEZONE, LLM_API_KEY,
CALDAV_*) com:
  npx @insforge/cli secrets add <CHAVE> <VALOR>
Veja docs/CONFIGURACAO.md.
`);
  process.exit(0);
}

console.log("Verificando o projeto InsForge vinculado...");
run(["current"]);

console.log("Aplicando as migrations do banco...");
for (const migration of schemaMigrations) {
  applyMigration(migration);
}

if (!skipSecrets) {
  console.log("Garantindo que os segredos gerados existem...");
  const project = readLinkedProject();
  if (project?.oss_host && project?.api_key) {
    ensureSecret("INSFORGE_BASE_URL", resolveBaseUrl(project.oss_host));
    ensureSecret("INSFORGE_API_KEY", project.api_key);
  } else {
    console.log("- .insforge/project.json sem oss_host/api_key: configure INSFORGE_BASE_URL e INSFORGE_API_KEY manualmente");
  }
  ensureSecret("TELEGRAM_WEBHOOK_SECRET", randomSecret());
  ensureSecret("DASHBOARD_READ_TOKEN", randomSecret());
  ensureSecret("DASHBOARD_TOGGLE_TOKEN", randomSecret());
  ensureSecret("DAILY_DIGEST_TOKEN", randomSecret());
}

if (!skipDeploy) {
  console.log("Publicando as functions no InsForge...");
  for (const [slug, file, name] of functions) {
    run(["functions", "deploy", slug, "--file", file, "--name", name]);
  }
}

const baseUrl = resolveBaseUrl();
console.log("");
console.log("Backend pronto.");
if (baseUrl) console.log(`URL do seu backend: ${baseUrl}`);
console.log("Proximos passos (docs/INSTALACAO.md):");
console.log("  1. Clima: npx @insforge/cli secrets add WEATHER_LAT <latitude> (e WEATHER_LON)");
console.log("  2. Telegram: npm run telegram:chat-id e npm run telegram:configure");
console.log("  3. Resumo diario: npm run digest:schedule");

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
    console.log(`- ${key} ja existe`);
  } catch {
    run(["secrets", "add", key, value]);
    console.log(`- ${key} criado`);
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
