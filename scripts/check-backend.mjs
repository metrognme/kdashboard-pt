import { parseArgs, readSecret, resolveBaseUrl } from "./insforge-project.mjs";

// Plain-language health check of the published dashboard, for people following
// docs/INSTALACAO.md: fetches exactly what the Kindle fetches and says what is missing.

const { values } = parseArgs(process.argv.slice(2));
const baseUrl = resolveBaseUrl(values.get("--base-url"));
if (!baseUrl) {
  console.error("Nao encontrei a URL do backend. Rode dentro da pasta vinculada ao InsForge ou passe --base-url <url>.");
  process.exit(1);
}

const token = process.env.DASHBOARD_READ_TOKEN || readSecret("DASHBOARD_READ_TOKEN");
if (!token) {
  console.error("Nao consegui ler o DASHBOARD_READ_TOKEN. Rode npm run kit:backend (com o login do InsForge feito).");
  process.exit(1);
}

const url = `${baseUrl}/functions/kindle-dashboard-data`;
console.log(`Testando ${url}`);

let response;
try {
  response = await fetch(url, { headers: { "X-Dashboard-Read-Token": token } });
} catch (error) {
  fail(`Sem resposta do backend (${error.message}). Confira a URL e a sua internet.`);
}

if (response.status === 401) fail("O backend recusou o token (401): o DASHBOARD_READ_TOKEN nao bate com o segredo.");
if (response.status === 404) fail("Funcao nao encontrada (404): rode npm run kit:backend para publicar as funcoes.");

let payload;
try {
  payload = await response.json();
} catch {
  fail(`Resposta inesperada (HTTP ${response.status}), nao e JSON.`);
}
if (!response.ok || !payload.ok) {
  const detail = String(payload.error || "");
  const hint = /INSFORGE_(BASE_URL|API_KEY)/.test(detail)
    ? " Rode npm run kit:backend de novo para configurar INSFORGE_BASE_URL e INSFORGE_API_KEY."
    : "";
  fail(`O backend respondeu com erro (HTTP ${response.status}): ${detail}.${hint}`);
}

console.log("OK   Backend respondendo");

const weather = payload.weather || {};
if (weather.available) {
  console.log(`OK   Clima: ${weather.temperature_c} C, ${weather.condition_label}`);
} else {
  console.log("--   Clima indisponivel: configure WEATHER_LAT e WEATHER_LON (docs/INSTALACAO.md, etapa 3)");
}

const agenda = payload.agenda || {};
if (agenda.available) {
  console.log(`OK   Agenda: ${(agenda.events || []).length} proximo(s) evento(s)`);
} else {
  console.log("--   Agenda indisponivel (opcional): configure os segredos CALDAV_* se quiser usa-la");
}

const names = { todo: "Tarefas", grocery: "Compras", notes: "Notas" };
const counts = (payload.lists || []).map((list) => `${names[list.key] || list.key}: ${(list.items || []).length}`);
console.log(`OK   Listas (itens na tela): ${counts.join(", ")}`);

function fail(message) {
  console.error(`ERRO ${message}`);
  process.exit(1);
}
