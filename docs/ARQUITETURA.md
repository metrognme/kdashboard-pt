# Arquitetura

Como as peças se encaixam, e as decisões menos óbvias por trás delas. Para
instalar, veja o [INSTALACAO.md](INSTALACAO.md).

## Visão Geral

```text
Telegram ──▶ telegram-webhook ──▶ Postgres (planner_items) ──▶ kindle-dashboard-data ──▶ Kindle
                  │                        │                            ▲    (a cada 3 min)
                  └──▶ CalDAV (agenda)     └──▶ kindle-dashboard-events ─┘ (opcional, SSE: "busque de novo")
                                                toque no Kindle ──▶ kindle-dashboard-toggle
```

O conteúdo nunca é editado no próprio Kindle. O fluxo é:

1. você fala com um bot do Telegram;
2. o bot grava no seu banco (ou no seu calendário);
3. o Kindle busca de novo um JSON pequeno e redesenha a tela: a cada
   `INTERVAL` (3 minutos por padrão) ou, com a atualização instantânea
   ligada, assim que o servidor avisa.

## As Peças

- **Tela:** programa nativo em C++.
- **Backend:** InsForge.
- **Entradas:** bot do Telegram, Open-Meteo (clima), CalDAV (agenda).

Pontos de entrada no código:

- Programa nativo: [`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)
- Funções do backend: [`functions/`](../functions/)
- Modelo de configuração do dono:
  [`kindle/kual/kindle-dashboard/config.sh.example`](../kindle/kual/kindle-dashboard/config.sh.example)

## Espinha Do Backend

O InsForge cuida da parte na nuvem:

- **Banco Postgres:** os itens de compras, tarefas e notas ficam numa única
  tabela `planner_items`, separados por `list_key`.
- **Edge functions:**
  - leitura dos dados do painel (clima + agenda + listas);
  - interpretação das mensagens do Telegram;
  - marcação de itens pelo Kindle;
  - eventos ao vivo por SSE.

Arquivos relevantes:

- Schema:
  [`migrations/001_planner_items.sql`](../migrations/001_planner_items.sql),
  [`migrations/002_enable_rls_private_tables.sql`](../migrations/002_enable_rls_private_tables.sql)
- Leitura do painel:
  [`functions/kindle-dashboard-data.ts`](../functions/kindle-dashboard-data.ts)
- Marcação de itens:
  [`functions/kindle-dashboard-toggle.ts`](../functions/kindle-dashboard-toggle.ts)
- Eventos ao vivo:
  [`functions/kindle-dashboard-events.ts`](../functions/kindle-dashboard-events.ts)
- Webhook do Telegram:
  [`functions/telegram-webhook.ts`](../functions/telegram-webhook.ts)

A função de leitura monta um JSON compacto e calcula um hash do estado visível
como versão:

```ts
const payload = {
  ...payloadWithoutVersion,
  version: hashText(JSON.stringify({
    weather: payloadWithoutVersion.weather,
    agenda: payloadWithoutVersion.agenda,
    lists: payloadWithoutVersion.lists
  }))
};
```

O clima e a agenda são buscados ao vivo a cada requisição, porque o Open-Meteo
e o CalDAV são baratos de chamar no intervalo de atualização do Kindle (3
minutos por padrão). Essas buscas nunca lançam erro: se uma fonte falhar, só
aquele módulo é marcado como `available: false`. Assim, um soluço no Wi-Fi de
um módulo nunca derruba o JSON inteiro:

```ts
const [itemsResult, weather, agenda] = await Promise.all([
  admin.database.from("planner_items").select(/* ... */),
  fetchWeather(lat, lon),   // nunca rejeita; devolve { available: false, ... } em caso de erro
  fetchAgenda(/* ... */)    // nunca rejeita; devolve { available: false, events: [] } em caso de erro
]);
```

Antes de sair, o texto dos itens e eventos é convertido para maiúsculas sem
acentos (`Pão` vira `PAO`), porque a fonte do Kindle só tem A–Z.

## Bot Do Telegram

`comprar leite`

1. O Telegram envia um webhook para o InsForge.
2. O webhook verifica o cabeçalho secreto e o ID do chat autorizado.
3. A mensagem é interpretada e vira uma ação rígida (veja "Interpretação das
   mensagens", abaixo).

Código: [`functions/telegram-webhook.ts`](../functions/telegram-webhook.ts)

Uma ação de lista fica assim:

```json
{
  "kind": "planner",
  "action": "add",
  "list_key": "grocery",
  "items": ["leite"],
  "all_lists": false
}
```

Ou, para a agenda:

```json
{
  "kind": "calendar",
  "action": "create",
  "title": "Reunião do time",
  "start": "2026-09-12T14:00:00-03:00",
  "end": "2026-09-12T15:00:00-03:00",
  "all_day": false,
  "location": null
}
```

A barreira do webhook é propositalmente pequena:

```ts
const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token");
if (receivedSecret !== configuredSecret) {
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
}

if (chatId !== allowedChatId) {
  return jsonResponse({ ok: true, ignored: true, reason: "chat_not_allowed" });
}
```

O nome de usuário de um bot é público, então a segunda verificação é o que
torna o bot seu. Um estranho que o encontrar e mandar mensagem não recebe
resposta nenhuma, e o texto dele nunca é interpretado, nunca vai para a IA e
nunca é gravado.

Toques em botões chegam como `callback_query`, outro formato de atualização,
sem `update.message`. Por isso eles são verificados separadamente, contra o
chat dono da mensagem.

O [BOT.md](BOT.md) explica o modelo de acesso por completo, inclusive como
entregar o bot à família por um grupo e o que se perde com isso.

O backend grava no banco (compras/tarefas/notas) ou no calendário CalDAV
(agenda) e manda uma confirmação de volta.

Todas as respostas são em português do Brasil, citam a lista mexida e
repetem o texto do item como está salvo. Assim, se a busca aproximada acertou
a linha errada, você vê na hora:

`✅ Anotei em 🛒 Compras: leite.`
`✅ Concluí em 🛒 Compras: Café.`
`🤔 Não achei "banana" em 🛒 Compras.`
`📅 Agendado: Reunião com o time`
`amanhã às 14:00 · sala 2`

O caso "não achei" é o ponto principal. Concluir, apagar e reabrir encontram
o item por um trecho do texto, então o webhook busca as linhas que combinam
*antes* de gravar e informa o que realmente mudou. Disparar um
`UPDATE ... ILIKE` às cegas e repetir as palavras pedidas confirmaria mudanças
que nunca aconteceram.

## Interpretação Das Mensagens

### Interpretação por IA

A mensagem do Telegram vai para um endpoint de IA compatível com OpenAI (por
padrão, o [Gemini](https://ai.google.dev/gemini-api/docs/openai), modelo
`gemini-3.5-flash-lite`) com uma instrução rígida: transformar a mensagem em
ações JSON, resolvendo datas relativas ("amanhã às 14h") a partir do horário
atual. Esse horário é enviado com o fuso real do usuário, e não com `Z`.

O prompt também fixa o idioma de saída: títulos de itens e eventos voltam com
as palavras do próprio usuário, nunca traduzidos para o inglês.

Código: [`parseTelegramMessage`](../functions/telegram-webhook.ts), em
[`functions/telegram-webhook.ts`](../functions/telegram-webhook.ts)

### Interpretação por regras

O backend usa regras escritas à mão nestes casos:

- a `LLM_API_KEY` não existe;
- a chamada à IA falha;
- a IA devolve um JSON inválido.

As regras seguem padrões fixos. Resolver datas relativas para eventos
propositalmente *não* está coberto, só casos triviais como "cancela a reunião
X": entender "segunda que vem" de forma confiável sem IA está fora do alcance
de uma regex.

Em qualquer caso, o backend valida o resultado antes de gravar no banco ou no
CalDAV.

O interpretador tenta uma passada rápida por regras, depois a IA, depois as
regras de reserva:

```ts
async function parseTelegramMessage(message: string): Promise<ParseOutcome> {
  const fastAction = parseFastHeuristicMessage(message);
  if (fastAction) return { action: fastAction };

  const config = llmConfig();
  if (!config) return { action: parseMessageHeuristically(message) };

  const result = await callLlm(config, buildSystemPrompt(), message);
  // A resposta da IA é interpretada e validada antes de qualquer gravação no banco/CalDAV.
}
```

### Uma mensagem, várias ações

O schema de resposta é uma lista. "anota o código do alarme, adiciona regar as
plantas nas tarefas e marca os ovos como comprados" são três pedidos, e um
schema de objeto único obrigava a IA a descartar dois deles. O prompt deixa
claro que não é para dividir demais: "comprar leite e pão" continua sendo uma
adição com dois itens.

Por isso, a passada rápida por regras recusa qualquer mensagem com verbos de
mais de uma família de ação: duas famílias significam dois pedidos, e uma
regex não consegue separá-los.

### Saída estruturada é obrigatória, não opcional

A requisição usa `response_format: { type: "json_schema" }`, com um único
schema plano que cobre os dois tipos de ação. Isso não é um refinamento sobre
`json_object`: é o que faz a integração funcionar.

Quando o prompt pede "um destes dois formatos" em texto, o Gemini responde com
frequência com *os dois* formatos, aninhados sob o tipo:

```json
{ "planner": { "action": "add", "list_key": "grocery", "items": ["leite"] },
  "calendar": { "action": "", "title": "" } }
```

Esse objeto falha em todos os validadores. Na prática, toda resposta era
descartada em silêncio, e quem respondia era a heurística. O `unwrapAction`
também achata esse formato aninhado por precaução, para backends que ignoram
o schema.

Uniões (`oneOf`) não funcionam igual em todos os backends compatíveis com
OpenAI. Por isso, o schema declara todos os campos dos dois tipos e preenche
a metade não usada com valores vazios. O `strict: true` também exige que o
`required` liste todas as propriedades declaradas.

### Latência e cota

`reasoning_effort: "low"` é essencial. Por padrão, o Gemini 3.x "pensa" antes
de responder, o que custa 9–13 s numa classificação tão pequena, contra um
tempo limite de 12 s. Com essa opção, as respostas chegam em ~1 s.

A escolha do modelo é uma decisão de cota. No plano gratuito do Gemini, os
modelos flash completos permitem cerca de 20 requisições *por dia*; os
flash-lite permitem bem mais, e por isso o `LLM_MODEL` padrão é
`gemini-3.5-flash-lite`.

Um erro 429 é, portanto, um estado esperado, não uma anomalia: o `callLlm` o
informa como `"quota"`, para o chat dizer "use os botões, eles sempre
funcionam" em vez de "não entendi". Só o erro 503 ganha uma nova tentativa
(uma vez); tentar de novo contra um limite diário só o gasta mais.

### Respostas interativas

As confirmações trazem um botão `↩️ Desfazer`. Uma busca ambígua pergunta com
botões, em vez de pegar todas as linhas que por acaso contenham o trecho.

Como isso funciona por baixo:

- **Token no botão:** o Telegram limita o `callback_data` a 64 bytes, então o
  botão leva um ID de 16 caracteres hex, e os dados ficam em `bot_actions`.
- **Uso único:** os tokens são consumidos no uso, então um toque duplo não
  aplica duas vezes.
- **Limpeza:** tokens com mais de 24 h são apagados.

Toda aplicação devolve `{summary, undo, choices}`: a operação inversa vem
junto com o resultado. É isso que permite desfazer uma mensagem com três ações
num só toque.

### Mensagens de voz

O áudio não passa pela camada compatível com OpenAI:

- essa camada só aceita `input_audio` nos formatos `[wav, mp3]`;
- o Telegram manda OGG/Opus;
- o endpoint nativo do Gemini aceita `audio/ogg` como `inline_data`.

Por isso, o `parseVoiceMessage` fala direto com o endpoint nativo, enquanto o
texto continua usando a camada portátil.

A transcrição e a interpretação são uma única requisição: o modelo que ouve o
áudio já devolve a ação. Assim, uma mensagem de voz custa a mesma unidade de
cota que uma mensagem digitada.

### Cache de interpretação

A tabela `bot_parse_cache` guarda os resultados da IA pelo hash da mensagem
normalizada, porque o plano gratuito conta requisições, não tokens.

Ações de agenda nunca entram no cache: elas dependem de "agora", então um
"reunião amanhã às 14h" guardado estaria errado amanhã.

Os nomes das listas têm apelidos fixos, em inglês e português. A detecção
ignora acentos, então a tabela fica em ASCII puro e ainda encontra
"pendências":

```ts
const LIST_ALIASES = {
  grocery: ["grocery", "groceries", "shopping", "market", "comprar", "compra", "compras", "mercado", "supermercado", "feira"],
  todo: ["todo", "to-do", "task", "tasks", "errand", "errands", "tarefa", "tarefas", "afazer", "afazeres", "pendencia", "pendencias"],
  notes: ["note", "notes", "nota", "notas", "anotacao", "anotacoes", "recado", "recados"]
};
```

Os verbos de ação são reconhecidos do mesmo jeito, com o português em
primeiro lugar. Sem chave (e, no plano gratuito, pelo resto do dia depois que
o limite acaba), esse interpretador é a única coisa entre o usuário e uma
resposta vazia.

### Teclado de menu (sem IA)

`/start` ou `/menu` mostram um teclado persistente de botões: 📋 Tarefa,
📝 Nota, 🛒 Compras, 📅 Agenda. O fluxo é:

1. tocar num botão faz o bot responder com uma pergunta de resposta
   obrigatória, cujo texto exato identifica a categoria;
2. o Telegram devolve essa pergunta como `reply_to_message` na mensagem
   seguinte;
3. o backend recupera a categoria por ela, sem guardar estado de sessão no
   servidor:

```ts
const repliedCategory = repliedPromptText
  ? MENU_CATEGORIES.find((category) => category.prompt === repliedPromptText)
  : undefined;

if (repliedCategory?.listKey) {
  action = buildPlannerAddAction(repliedCategory.listKey, text);  // nenhuma classificação
}
```

Itens adicionados pelo menu pulam a interpretação por completo. Só o
📅 Agenda ainda passa pela IA, para resolver datas relativas no texto livre.

## Clima

A função de leitura do painel chama a API de previsão do Open-Meteo (gratuita
e sem chave) para uma latitude/longitude fixa, configurada por
`WEATHER_LAT`/`WEATHER_LON`. O código de clima WMO recebido é convertido num
rótulo curto em inglês (`CLOUDY`, `RAIN`...), que o Kindle usa para escolher
o ícone e traduz ao exibir (`NUBLADO`, `CHUVA`...).

Código: [`fetchWeather`](../functions/kindle-dashboard-data.ts), em
[`functions/kindle-dashboard-data.ts`](../functions/kindle-dashboard-data.ts)

## Agenda

A função de leitura do painel e o webhook do Telegram falam CalDAV direto por
`fetch`, sem biblioteca, seguindo o estilo "sem dependências externas" do
resto do código. As três operações são:

- **Ler:** um `REPORT` `calendar-query` com filtro de intervalo de tempo.
- **Criar:** um `PUT` de um documento ICS com um `VEVENT` mínimo.
- **Apagar:** busca os eventos pelo título e faz um `DELETE` no recurso
  encontrado.

A caixa mostra os **próximos `AGENDA_MAX_EVENTS` eventos, seja qual for a
data**. O `AGENDA_LOOKAHEAD_DAYS` (padrão: 365) só limita a consulta e a
expansão de recorrências; ele não é um filtro de "dentro de N dias". Essa
lógica já foi ao contrário, com uma janela de 36 horas, e um calendário cujo
próximo compromisso estava a dez dias aparecia com a agenda vazia.

A camada CalDAV precisa fazer duas coisas por conta própria:

- **Expandir recorrências.** Uma `calendar-query` pode pedir ao servidor para
  expandir uma regra com `<C:expand>`, mas a implementação do Google ignora
  isso e devolve o `VEVENT` original. Assim, um aniversário anual chega com a
  data de 1996 e fica invisível para qualquer filtro de eventos futuros.

  Por isso, o `expandRecurrence` percorre o `RRULE` para frente (`FREQ`,
  `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` semanal, `EXDATE`), pulando direto até
  a janela, para uma regra diária de 1996 não custar 11.000 iterações. Uma
  regra que ele não consegue representar com exatidão devolve o início
  original intacto, em vez de uma data inventada.
- **Resolver o `TZID` por conta própria.**
  `DTSTART;TZID=America/Sao_Paulo:20260913T120000` é meio-dia *lá*. Ler isso
  com `new Date("2026-09-13T12:00:00")` resolve o horário pelo fuso do
  ambiente, que no servidor é UTC, e deslocava cada evento pelo fuso do
  próprio calendário.

  O `wallClockToUtc` calcula o deslocamento que o fuso tinha naquele
  instante, então continua correto mesmo com horário de verão.

Código: [`fetchAgenda`](../functions/kindle-dashboard-data.ts), em
[`functions/kindle-dashboard-data.ts`](../functions/kindle-dashboard-data.ts),
e [`applyCalendarAction`](../functions/telegram-webhook.ts), em
[`functions/telegram-webhook.ts`](../functions/telegram-webhook.ts)

## Atualização Do Painel No Kindle

O Kindle busca um único JSON compacto numa função de dados do InsForge. Ele
desenha o painel localmente e guarda o JSON para usar offline.

Arquivos relevantes:

- Função:
  [`functions/kindle-dashboard-data.ts`](../functions/kindle-dashboard-data.ts)
- Ciclo nativo de busca/cache/desenho:
  [`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)
- Inicializador do KUAL:
  [`kindle/kual/kindle-dashboard/bin/dashboard.sh`](../kindle/kual/kindle-dashboard/bin/dashboard.sh)

Exemplo de resposta:

```json
{
  "ok": true,
  "generated_at": "2026-09-11T12:00:00.000Z",
  "weather": {
    "available": true,
    "temperature_c": 27,
    "feels_like_c": 29,
    "condition_label": "CLOUDY",
    "precipitation_probability": 40,
    "high_c": 30,
    "low_c": 22,
    "wind_kph": 12
  },
  "agenda": {
    "available": true,
    "events": [
      { "uid": "abc", "title": "REUNIAO DO TIME", "start": "2026-09-11T14:00:00-03:00", "end": "2026-09-11T15:00:00-03:00", "all_day": false, "location": null }
    ]
  },
  "lists": [
    { "key": "todo",    "title": "Tarefas", "items": [
      { "id": "item-4", "number": 1, "text": "PAGAR LUZ", "done": false, "important": true },
      { "id": "item-1", "number": 2, "text": "LIMPAR A MESA", "done": false, "important": false }
    ] },
    { "key": "grocery", "title": "Compras", "items": [{ "id": "item-2", "number": 1, "text": "LEITE", "done": false, "important": false }] },
    { "key": "notes",   "title": "Notas",   "items": [{ "id": "item-3", "number": 1, "text": "SENHA DO WIFI NO ROTEADOR", "done": false, "important": false }] }
  ],
  "version": "a13f9c"
}
```

Três detalhes do contrato de que o programa do Kindle depende:

- **Ordem das listas:** `lists` sai sempre na ordem fixa `todo`, `grocery`,
  `notes`. O programa associa a posição na lista direto a uma caixa na tela,
  então o backend não pode reordenar.
- **Ordem e números dos itens:** dentro de cada lista, os itens saem na mesma
  ordem e com os mesmos números (`number`) que o `/listas` do bot usa:
  - abertos antes de concluídos;
  - importantes primeiro dentro de cada grupo;
  - mais antigos primeiro dentro disso (`created_at`, com `id` como
    desempate: itens gravados pela mesma mensagem têm o mesmo `created_at`).

  A função `orderForNumbering` existe em cópias idênticas no
  `kindle-dashboard-data.ts` e no `telegram-webhook.ts`. Os números são
  calculados sobre todas as linhas antes de esconder os itens concluídos há
  mais de 24 h, então esconder um item nunca muda o número de outro. O
  programa só imprime o `number` que recebe (`[ ] !1. PAGAR LUZ`). Depois de
  um toque que conclui ou reabre um item, ele não sabe renumerar (não recebe
  as linhas escondidas), então desenha os itens sem número
  (`g_item_numbers_stale`) até a próxima busca bem-sucedida.
- **Horários dos eventos:** eventos com horário são convertidos para o
  horário local do painel com o deslocamento explícito (`-03:00` acima), e
  não em UTC com `Z`. O programa não tem tabelas de fuso e imprime os dígitos
  da data e da hora como vieram. Eventos de dia inteiro mantêm a data
  original, sem horário.

O programa nativo primeiro grava a resposta num arquivo de cache e depois
desenha a partir dele:

```cpp
const int fetched = fetchToCache(dashboard_url, options.read_token, options.cache);
renderCachedPayload(&options, fetched ? "live" : "cached/offline");
```

## Desenho Nativo

O Kindle roda um programa nativo em C++. Ele desenha texto, caixas e ícones
rasterizados à mão numa tela monocromática do tamanho do display e-ink.

Não há fonte de ícones nem imagens para os ícones de clima. Sol, nuvem,
chuva, neve, tempestade e neblina são montados na hora de desenhar com
`fillCircle`, `fillTriangle`, `fillRect` e `line`, as mesmas primitivas usadas
em todo o resto:

```cpp
fillCircle(canvas, cx - r * 3 / 8, cloud_cy, r * 3 / 8, 0);
fillCircle(canvas, cx + r / 8, cloud_cy - r / 6, r / 2, 0);
fillCircle(canvas, cx + r * 5 / 8, cloud_cy, r * 3 / 8, 0);
```

O layout é uma tela única, não uma grade 2x2:

```text
+--------------------------------------------------+
| [icone] 27C  NUBLADO  ^30 v22  (o)40%  [cad] [SAIR]|  barra de clima
| SEXTA, 11 SET // AO VIVO                          |
+---------------------+----------------------------+
|  caixa de foto      |  TAREFAS                   |
+---------------------+                            |
|  COMPRAS            +----------------------------+
|                     |  NOTAS                     |
+---------------------+----------------------------+
|  AGENDA (largura total)                           |
+--------------------------------------------------+
```

Os textos da tela estão em português, sem acentos, porque a fonte bitmap 5x7
só tem A–Z. Os rótulos de status (`AO VIVO`, `OFFLINE`...) e de clima são
traduzidos na hora de exibir (`displayStatus`, `displayCondition`), enquanto
os valores internos continuam em inglês, porque também vão para o log e para
a escolha dos ícones.

O título configurado em `DASHBOARD_TITLE` (passado ao programa como
`--title`) aparece no cabeçalho das listas abertas em tela cheia.

Máxima/mínima e chance de chuva são indicadas por setas e uma gota
desenhadas, em vez de letras soltas, porque a fonte 5x7 não tem espaço para
palavras nesse tamanho.

Depois, o programa escreve esses pixels direto no framebuffer do Kindle.

Código:
[`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)

O programa lê o JSON para uma estrutura fixa. As buscas de campos do clima e
da agenda ficam restritas ao objeto de cada módulo (em vez de procurar no
documento inteiro), para os nomes de campos não colidirem entre módulos:

```cpp
const char* weather_start = findKeyInRange(json, NULL, "weather");
const char* weather_end = matchingClose(weather_start, '}');
dashboard->weather.temperature_c = extractInt(weather_start, weather_end, "temperature_c", 0);
```

Depois, desenha numa tela em memória e escreve em `/dev/fb0` quando
disponível:

```cpp
int fd = open("/dev/fb0", O_RDWR);
unsigned char* fb = static_cast<unsigned char*>(
  mmap(0, screensize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
);
```

## Visual

Os painéis têm molduras em estilo HUD, e não retângulos simples:

- **Borda:** uma linha fina.
- **Cantos:** em L, grossos, com o canto superior direito cortado a 45 graus.
- **Títulos:** numa aba preenchida com o texto vazado.
- **Linha sob o título:** sólida e depois tracejada, com um traço em cada
  ponta.

O `hudFrame()` mantém exatamente o retângulo que recebe, e é isso que torna o
visual uma troca de estilo e não uma mudança de layout: as áreas de toque são
calculadas com os mesmos números.

Tudo continua em duas cores de propósito. O jeito óbvio de valorizar o visual
seria usar brilhos e degradês em cinza, mas o e-ink desenha cinza com
pontilhado e paga isso com uma atualização mais lenta e com mais "fantasmas".
Geometria é de graça nessa tela; sombreamento, não.

## Modo Escuro

`--dark` (as opções "(escuro)" do KUAL, ou `DARK_MODE="1"` no `config.sh`)
desenha o painel em branco sobre preto.

Todas as chamadas de desenho continuam usando a paleta clara, e a tela pronta
é invertida uma única vez, em `drawCurrentDashboard()`:

```cpp
if (g_dark_mode) invertCanvas(canvas);
```

Passar uma cor de tinta/papel por todas as chamadas daria os mesmos pixels num
design de duas cores. A vantagem da inversão única é que ela não esquece
nenhuma chamada, como uma paleta trocada à mão pode esquecer, e uma tela nova
não tem como esquecer de ficar escura.

A caixa de foto é a exceção: ela é invertida antes, na entrada, para que a
inversão final a deixe do jeito certo em vez de virar um negativo.

A barra de status do próprio Kindle ocupa os 66 px do topo, e o programa
nunca escreve ali de propósito, então no modo escuro essa faixa continua
clara.

## Caixa De Foto

A caixa acima de Compras mostra uma imagem escolhida pelo dono. O programa lê
um PGM binário simples de 8 bits (`P5`), o mesmo formato que o seu próprio
`--dump-pgm` grava, e ajusta a imagem para preencher a caixa com um corte
centralizado. Assim, a imagem de origem não precisa ter a mesma proporção da
caixa nem a resolução do aparelho:

```cpp
if (sw * h > sh * w) crop_w = sh * w / h; else crop_h = sw * h / w;
```

Converta qualquer imagem com o ImageMagick:

```sh
magick foto.jpg -colorspace Gray -resize 512x512^ -gravity center \
  -extent 512x512 -depth 8 kindle/kual/kindle-dashboard/assets/profile.pgm
```

O caminho padrão é `/mnt/us/extensions/kindle-dashboard/assets/profile.pgm`;
mude com `--photo /caminho/para/arquivo.pgm`. Um arquivo ausente ou ilegível
não é fatal: a caixa aparece como uma moldura vazia e o motivo vai para o log.

A pasta `assets/` fica de fora do Git de propósito (`.gitignore`), porque a
foto é pessoal de cada dono. Os alvos `extension` / `extension-zig` do Make
copiam a foto para o pacote do KUAL, então coloque a sua antes de empacotar.

## Interatividade

Não há framework de botões. O toque é tratado à mão: coordenada do toque →
retângulo → ação do painel.

Cada área tocável é registrada como uma região:

- tocar nas caixas de Tarefas, Compras ou Notas abre a lista em tela cheia;
- tocar num item da lista marca como feito.

A faixa da agenda e a caixa de foto são só informativas, mas mesmo assim
registram uma região, com a ação vazia `kTouchNone`:

```cpp
addTouchRegion(tile_rect, kTouchNone, -1, -1, "", 0);
```

Isso não é redundante. Quando um toque não acerta nenhuma região, o programa
tenta de novo com sete transformações espelhadas/rotacionadas da coordenada,
porque a orientação dos eixos da tela de toque varia entre modelos de Kindle.
Deixar uma área grande sem região faz essas tentativas caírem em outro lugar
da tela: na prática, tocar na agenda abria Tarefas e tocar na foto abria
Compras. Registrar a área com uma ação vazia consome o toque antes dessas
tentativas.

Código:
[`handlePendingTouch`](../kindle/native/src/kindle_dashboard.cpp) e
[`postToggleItemAsync`](../kindle/native/src/kindle_dashboard.cpp), em
[`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)

As marcações de itens atualizam o cache offline na hora (de forma otimista) e
são enviadas ao InsForge:

```cpp
if (action == kTouchToggleItem) {
  const int next_done = g_pending_item_done ? 0 : 1;
  patchCachedItemDone(options->cache, g_pending_item_id, next_done);
  postToggleItemAsync(options->toggle_url, options->toggle_token, g_pending_item_id, next_done);
  return 1;
}
```

A função correspondente no backend atualiza `planner_items`:

```ts
await admin.database
  .from("planner_items")
  .update({ done: body.done, updated_at: new Date().toISOString() })
  .eq("id", id);
```

## Bloqueio De Tela

Um botão de cadeado fica à esquerda do SAIR nos dois cabeçalhos. Tocar nele
liga o `g_screen_locked` e redesenha na hora, trocando o cadeado aberto pelo
fechado. Serve para carregar o Kindle ou limpar a tela sem que um toque
acidental abra uma lista ou volte para a tela inicial do Kindle.

Bloquear é por toque. Desbloquear, de propósito, não. Se o mesmo toque que
bloqueou pudesse desbloquear, aquele ponto continuaria "vivo": um pano
limpando a tela, ou o Kindle esbarrando em algo dentro da bolsa, poderia
acertar exatamente aqueles pixels e desfazer o bloqueio sem querer. Por isso,
enquanto está bloqueado, todo toque é ignorado, inclusive no cadeado:

```cpp
if (g_screen_locked) {
  fprintf(stderr, "input=locked x=%d y=%d\n", x, y);
  return 0;
}
```

A única saída é o botão liga/desliga do próprio Kindle, que é hardware físico
e não um ponto na tela de toque.

O `initTouchInput()` procura um dispositivo de entrada que informe
`KEY_POWER` (com a mesma consulta `EVIOCGBIT` usada para os eixos da tela de
toque) e o abre só para leitura, *sem* `EVIOCGRAB`. Ele é um segundo leitor,
passivo, ao lado do que o `powerd` do Kindle já tem aberto. Assim, o
comportamento normal de dormir/acordar do botão não muda nada por o painel
também estar observando o mesmo botão.

```cpp
if (event.type == EV_KEY && event.code == KEY_POWER && event.value == 1 && g_screen_locked) {
  g_pending_action = kTouchHardwareUnlock;
}
```

O `kTouchHardwareUnlock` usa o mesmo caminho `g_pending_action` →
`handlePendingTouch()` → redesenho que todas as ações de toque já usam; ele só
nunca vem da tela de toque. O painel sempre começa desbloqueado: a flag é uma
variável global simples, zerada a cada nova execução.

## Detecção De Mudanças

Esta parte só é usada com `DASHBOARD_LIVE_UPDATES="1"`. Ela vem desligada por
padrão porque a conexão SSE fica aberta o tempo todo e impede o Wi-Fi do
Kindle de descansar, o que gasta bem mais bateria. Sem ela, o Kindle só busca
novidades a cada `INTERVAL`; os inicializadores esvaziam a
`DASHBOARD_EVENTS_URL`, e o programa não abre a conexão.

Uma edge function SSE no InsForge verifica se houve mudança nas listas. A
cada poucos segundos, ela calcula uma versão a partir dos itens:

- mesmos dados = mesma versão;
- dados diferentes = versão nova.

O clima e a agenda ficam de fora dessa versão de propósito. Eles mudam com o
relógio, não com gravações do usuário, então o intervalo normal de
atualização do Kindle basta. Consultar o Open-Meteo/CalDAV a cada dois
segundos pela função SSE só desperdiçaria requisições.

O filtro de listas aqui precisa acompanhar o do `kindle-dashboard-data.ts`.
Toda lista que o painel mostra precisa fazer parte desse hash; caso
contrário, as gravações nela nunca disparam atualização, e a caixa só se
atualiza no próximo ciclo agendado.

Código:
[`functions/kindle-dashboard-events.ts`](../functions/kindle-dashboard-events.ts)

```ts
const data = await loadDashboardData();
const version = getDashboardVersion(data);
if (!force && version === lastVersion) {
  controller.enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
  return;
}
```

## Eventos Ao Vivo

Quando a versão muda, o InsForge emite um pequeno evento SSE. O evento não
contém o painel inteiro; ele só avisa o Kindle: "busque o JSON mais recente".
O corpo do evento é só a versão:

```ts
lastVersion = version;
controller.enqueue(encoder.encode(`event: planner\n`));
controller.enqueue(encoder.encode(`data: ${version}\n\n`));
```

O observador nativo escuta com `curl` e liga uma flag de atualização:

```cpp
if (strncmp(line_buffer, "event: planner", 14) == 0) {
  g_event_refresh = 1;
}
```

## Redesenho

A cada `INTERVAL`, ou quando chega um evento SSE, o Kindle:

1. busca o JSON mais recente;
2. salva no cache offline;
3. redesenha o painel, **se algo mudou**.

Redesenhar um e-ink custa bateria e faz a tela piscar, então o programa
guarda uma "assinatura" do que está na tela: a versão dos dados, a linha de
data e status do cabeçalho, a lista aberta, o bloqueio e o tema. Se a busca
nova gerar a mesma assinatura, o desenho é pulado (`render=skip unchanged` no
log). Há três salvaguardas:

- **Toques:** um redesenho por toque sempre desenha e apaga a assinatura,
  então a busca seguinte sempre redesenha. Isso corrige a tela se o servidor
  não aceitar uma marcação feita no Kindle.
- **Redesenho periódico:** a cada 30 minutos (`kForcedRedrawMs`) a tela é
  redesenhada mesmo sem mudanças, para limpar avisos do próprio Kindle que
  tenham ficado por cima do painel.
- **Repintura:** a repintura de 5 segundos após uma atualização só acontece
  quando houve desenho de verdade.

Se a rede falhar, o painel continua sendo desenhado a partir do cache. E,
como o backend nunca derruba a requisição inteira só porque o clima ou a
agenda estão fora do ar, `OFFLINE` só aparece quando o próprio Kindle está sem
conexão, não quando uma API externa oscila.

Código:
[`kindle/native/src/kindle_dashboard.cpp`](../kindle/native/src/kindle_dashboard.cpp)

```cpp
const int fetched = fetchToCache(dashboard_url, options.read_token, options.cache);
if (!renderCachedPayload(&options, fetched ? "live" : "cached/offline")) {
  addCardText(lines, &count, " PAINEL KINDLE");
  addCardText(lines, &count, " Painel indisponivel");
  addCardText(lines, &count, " Verifique o Wi-Fi ou tente depois");
  renderToEips(lines, count);
}
```
