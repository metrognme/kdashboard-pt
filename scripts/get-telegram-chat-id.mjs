import { execFileSync } from "node:child_process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const botToken = args.get("--bot-token") || process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error("Uso: npm run telegram:chat-id -- --bot-token <token>");
  process.exit(1);
}

const response = JSON.parse(fetchSync(`https://api.telegram.org/bot${botToken}/getUpdates`));

if (!response.ok) {
  console.error(JSON.stringify(response, null, 2));
  process.exit(1);
}

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

function fetchSync(url) {
  return execFileSync("curl", ["-sS", "--fail-with-body", url], { encoding: "utf8" });
}
