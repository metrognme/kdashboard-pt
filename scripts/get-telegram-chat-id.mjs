import { execFileSync } from "node:child_process";
import { parseArgs } from "./insforge-project.mjs";

const { flags, values } = parseArgs(process.argv.slice(2), ["--delete-webhook"]);
const botToken = values.get("--bot-token") || process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error("Uso: npm run telegram:chat-id -- --bot-token <token> [--delete-webhook]");
  process.exit(1);
}

if (flags.has("--delete-webhook")) {
  // Telegram only hands out getUpdates while no webhook is set. Deleting it takes the bot
  // offline until telegram:configure registers it again.
  const result = telegram("deleteWebhook");
  if (!result.ok) explainAndExit(result);
  console.log("Webhook desligado: o bot fica sem responder ate voce rodar o npm run telegram:configure de novo.");
  console.log("Agora mande uma mensagem no chat (ou grupo) que voce quer usar e rode este comando de novo, sem --delete-webhook.");
  process.exit(0);
}

const response = telegram("getUpdates");

if (!response.ok) explainAndExit(response);

const chats = new Map();
for (const update of response.result || []) {
  const message = update.message || update.edited_message;
  const chat = message?.chat;
  if (!chat?.id) continue;

  chats.set(String(chat.id), {
    id: chat.id,
    type: chat.type,
    title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "Chat sem nome",
    lastMessage: message.text || ""
  });
}

if (chats.size === 0) {
  console.log("Nenhuma mensagem ainda. Mande qualquer mensagem para o seu bot no Telegram e rode este comando de novo.");
  process.exit(0);
}

for (const chat of chats.values()) {
  console.log(`chat_id=${chat.id} type=${chat.type} name="${chat.title}" last_message="${chat.lastMessage}"`);
}
console.log("");
console.log("Use o numero de chat_id da sua conversa em --chat-id no npm run telegram:configure.");

function telegram(method) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  try {
    return JSON.parse(
      execFileSync("curl", ["-sS", "--max-time", "20", "--fail-with-body", url], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    );
  } catch (error) {
    // --fail-with-body still prints Telegram's JSON error on stdout; keep it for the hints above.
    try {
      return JSON.parse(String(error.stdout || ""));
    } catch {
      console.error(`Nao consegui falar com o Telegram: ${String(error.stderr || error.message).trim()}`);
      console.error("Confira a internet e tente de novo.");
      process.exit(1);
    }
  }
}

function explainAndExit(response) {
  if (response.error_code === 409) {
    // getUpdates is refused while a webhook is set, i.e. after telegram:configure ran.
    console.error("O bot ja esta ligado ao seu backend (webhook ativo), entao o Telegram nao entrega mais as mensagens para este comando.");
    console.error("Se so quer confirmar o ID, mande /start ao bot: se ele responder, o ID configurado esta certo.");
    console.error("Para descobrir o ID de outro chat (ex.: um grupo), rode com --delete-webhook e siga as instrucoes.");
  } else if (response.error_code === 401 || response.error_code === 404) {
    console.error("Token do bot invalido. Copie de novo o token que o @BotFather mandou (formato 123456789:AA...).");
  } else {
    console.error(JSON.stringify(response, null, 2));
  }
  process.exit(1);
}
