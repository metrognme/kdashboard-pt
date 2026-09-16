import { execFileSync } from "node:child_process";
import { resolveBaseUrl } from "./insforge-project.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const botToken = args.get("--bot-token") || process.env.TELEGRAM_BOT_TOKEN;
const chatId = args.get("--chat-id") || process.env.TELEGRAM_ALLOWED_CHAT_ID;
const baseUrl = resolveBaseUrl(args.get("--base-url"));
const webhookUrl =
  args.get("--webhook-url") ||
  process.env.TELEGRAM_WEBHOOK_URL ||
  (baseUrl ? `${baseUrl.replace(/\/+$/, "")}/functions/telegram-webhook` : "");

if (!botToken || !chatId || !webhookUrl) {
  console.error("Uso: npm run telegram:configure -- --bot-token <token> --chat-id <chat-id> [--base-url <url>]");
  console.error("A URL do backend vem do .insforge/project.json; passe --base-url (ou --webhook-url) se esta pasta nao estiver vinculada.");
  process.exit(1);
}

if (!/^\d+:[\w-]+$/.test(botToken)) {
  console.error("Esse token nao parece um token de bot. Copie de novo o que o @BotFather mandou (formato 123456789:AA...).");
  process.exit(1);
}
if (!/^-?\d+$/.test(String(chatId))) {
  console.error("O --chat-id deve ser so o numero (o valor de chat_id= no npm run telegram:chat-id).");
  process.exit(1);
}

setSecret("TELEGRAM_BOT_TOKEN", botToken);
setSecret("TELEGRAM_ALLOWED_CHAT_ID", chatId);

const webhookSecret = getSecret("TELEGRAM_WEBHOOK_SECRET");
const response = postTelegramWebhook(botToken, webhookUrl, webhookSecret);

if (!response.ok) {
  if (response.error_code === 401 || response.error_code === 404) {
    console.error("O Telegram recusou o token do bot. Copie de novo o token que o @BotFather mandou.");
  } else {
    console.error(JSON.stringify(response, null, 2));
  }
  process.exit(1);
}

console.log(`Webhook do Telegram registrado: ${webhookUrl}`);
console.log(`Chat autorizado: ${chatId}`);

function setSecret(key, value) {
  try {
    run(["secrets", "add", key, value]);
  } catch (error) {
    const output = String(error.stdout || "") + String(error.stderr || "") + String(error.message || "");
    if (!output.includes("Secret already exists")) {
      throw error;
    }
    run(["secrets", "update", key, "--value", value]);
  }
}

function getSecret(key) {
  try {
    return JSON.parse(run(["secrets", "get", key, "--json"])).value;
  } catch {
    console.error(`Nao encontrei o segredo ${key} no InsForge. Rode npm run kit:backend antes deste comando.`);
    process.exit(1);
  }
}

function postTelegramWebhook(token, url, secretToken) {
  const body = new URLSearchParams({
    url,
    secret_token: secretToken,
    drop_pending_updates: "true"
  });

  const response = fetchSync(`https://api.telegram.org/bot${token}/setWebhook`, body);
  return JSON.parse(response);
}

function fetchSync(url, body) {
  try {
    return execFileSync(
      "curl",
      ["-sS", "--max-time", "20", "--fail-with-body", "-X", "POST", url, "-H", "Content-Type: application/x-www-form-urlencoded", "--data", body.toString()],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (error) {
    // --fail-with-body keeps Telegram's JSON error on stdout.
    if (String(error.stdout || "").trim()) return String(error.stdout);
    console.error(`Nao consegui falar com o Telegram: ${String(error.stderr || error.message).trim()}`);
    console.error("Confira a internet e tente de novo.");
    process.exit(1);
  }
}

function run(args) {
  return execFileSync("npx", ["@insforge/cli", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
