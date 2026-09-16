# Referência de Configuração

A configuração fica em dois lugares, que nunca compartilham valores:

1. **Segredos do backend**: ficam no seu projeto InsForge e são lidos pelas
   edge functions enquanto elas rodam. Configure com
   `npx @insforge/cli secrets add <CHAVE> <VALOR>`.
2. **Configurações do Kindle**: ficam no `config.sh`, dentro da extensão do
   KUAL instalada (`/mnt/us/extensions/kindle-dashboard/config.sh`).

O arquivo local `.env` (copiado do `.env.example`) serve só para você guardar
suas anotações e alimentar os scripts em `scripts/`. As funções publicadas
nunca leem esse arquivo.

## Segredos do backend

### Criados automaticamente

O `npm run kit:backend` gera estes segredos se eles ainda não existirem. Você
só precisa ler dois deles, para colocar no `config.sh`:

| Chave | Usado por | Para quê |
| --- | --- | --- |
| `DASHBOARD_READ_TOKEN` | Kindle | Permite que o Kindle leia o painel. Copie para o `config.sh`. |
| `DASHBOARD_TOGGLE_TOKEN` | Kindle | Permite que o Kindle marque itens como feitos. Copie para o `config.sh`. |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram | Prova que a mensagem veio mesmo do Telegram. |
| `DAILY_DIGEST_TOKEN` | Agendador | Autentica o disparo de hora em hora do resumo diário. |

O `npm run native:install` lê os dois e grava no `config.sh` para você. Para
ver os valores (campo `value`):

```sh
npx @insforge/cli secrets get DASHBOARD_READ_TOKEN --json
npx @insforge/cli secrets get DASHBOARD_TOGGLE_TOKEN --json
```

O `npm run telegram:configure` configura `TELEGRAM_BOT_TOKEN` e
`TELEGRAM_ALLOWED_CHAT_ID` para você.

### Obrigatórios

O `npm run kit:backend` configura estes dois sozinho, lendo o
`.insforge/project.json` que o `create` (ou o `link`) grava na pasta. Só
configure à mão se a pasta não estiver vinculada.

| Chave | Exemplo | Observações |
| --- | --- | --- |
| `INSFORGE_BASE_URL` | `https://abc123.us-east.insforge.app` | A URL da API do seu projeto (campo `oss_host` do `.insforge/project.json`, ou no painel do InsForge). |
| `INSFORGE_API_KEY` | — | A chave de API de servidor do projeto (campo `api_key`). Nunca coloque no Kindle. |

### Fuso horário

| Chave | Padrão | Observações |
| --- | --- | --- |
| `DASHBOARD_TIMEZONE` | `America/Sao_Paulo` | Um [fuso horário IANA](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). Só precisa configurar se você não estiver no horário de Brasília (ex.: `America/Manaus`, `America/Cuiaba`, `America/Rio_Branco`, `America/Noronha`). Com o fuso errado, os horários dos eventos e o "amanhã" saem errados. |

### Clima

Usa o [Open-Meteo](https://open-meteo.com): gratuito, sem conta, sem chave.
Sem estas chaves, a barra de clima aparece como indisponível e o resto
continua funcionando.

| Chave | Exemplo | Observações |
| --- | --- | --- |
| `WEATHER_LAT` | `-23.5505` | Latitude em graus decimais. No Google Maps, clique com o botão direito num ponto para copiar. |
| `WEATHER_LON` | `-46.6333` | Longitude em graus decimais. |

### Agenda (CalDAV)

Sem estas chaves, a faixa da agenda aparece como indisponível e o resto
continua funcionando.

| Chave | Exemplo | Observações |
| --- | --- | --- |
| `CALDAV_BASE_URL` | `https://caldav.exemplo.com` | Endereço do servidor, sem caminho. |
| `CALDAV_CALENDAR_PATH` | `/calendars/voce/pessoal/` | Caminho do calendário a exibir, com barra no final. |
| `CALDAV_USERNAME` | — | |
| `CALDAV_PASSWORD` | — | Use uma senha de app, se o seu provedor oferecer. |
| `AGENDA_MAX_EVENTS` | `6` | Quantos próximos eventos mostrar (o padrão no código é 8; cabem 6 na tela). |
| `AGENDA_LOOKAHEAD_DAYS` | `365` | Até quantos dias à frente buscar. **Não** é um filtro de "mostrar só os próximos N dias": diminuir o valor só esconde eventos. |

Os eventos agendados pelo Telegram são gravados nesse mesmo calendário.

### Linguagem natural e voz (IA)

Opcional. Sem `LLM_API_KEY`:

- o menu de botões e os comandos simples continuam funcionando;
- o texto livre passa por um interpretador de regras;
- não dá para agendar eventos com datas relativas ("amanhã às 14h").

| Chave | Padrão | Observações |
| --- | --- | --- |
| `LLM_API_KEY` | — | Qualquer provedor compatível com OpenAI. Uma [chave gratuita do Gemini](https://aistudio.google.com/apikey) funciona. |
| `LLM_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | Endpoint compatível com OpenAI. |
| `LLM_MODEL` | `gemini-3.5-flash-lite` | No plano gratuito do Gemini, os modelos flash completos permitem só ~20 requisições por dia; o flash-lite permite bem mais. |
| `LLM_REASONING_EFFORT` | `low` | Mantém as respostas em ~1 s, em vez de 9–13 s. |
| `LLM_AUDIO_BASE_URL` | derivado de `LLM_BASE_URL` | Só para mensagens de voz, que precisam do endpoint nativo do Gemini. Com outro provedor, o bot avisa que o áudio está indisponível. |

Com a chave configurada, as mensagens que o interpretador de regras não
entende são enviadas a esse provedor.

## `config.sh` do Kindle

Comece pelo `config.sh.example` da pasta da extensão. Os valores são
variáveis de shell, então mantenha as aspas duplas.

| Chave | Padrão | Observações |
| --- | --- | --- |
| `DASHBOARD_DATA_URL` | — | **Obrigatório.** `https://<projeto>.insforge.app/functions/kindle-dashboard-data` |
| `DASHBOARD_EVENTS_URL` | — | `https://<projeto>.function2.insforge.app/kindle-dashboard-events`. Só é usada com `DASHBOARD_LIVE_UPDATES="1"`. Repare que o endereço é outro: o gateway normal `/functions/` segura os eventos ao vivo. |
| `DASHBOARD_TOGGLE_URL` | — | `https://<projeto>.insforge.app/functions/kindle-dashboard-toggle`. Sem ela, tocar nos itens não faz nada. |
| `DASHBOARD_READ_TOKEN` | — | **Obrigatório.** Vem dos segredos do backend, acima. |
| `DASHBOARD_TOGGLE_TOKEN` | — | Vem dos segredos do backend, acima. |
| `DASHBOARD_TITLE` | `Painel Kindle` | Texto do cabeçalho, em maiúsculas e sem acentos. Aparece nas listas abertas em tela cheia. |
| `INTERVAL` | `180` | De quantos em quantos segundos o Kindle busca novidades no backend (180 = 3 minutos). **Quanto menor, mais bateria gasta.** Veja [Bateria](#bateria-e-frequência-de-atualização). |
| `DASHBOARD_LIVE_UPDATES` | `0` | `1` liga a atualização instantânea (SSE): mudanças aparecem em segundos, mas a bateria dura bem menos. Precisa de `DASHBOARD_EVENTS_URL`. |
| `DARK_MODE` | `0` | `1` para branco sobre preto. As opções "(claro)"/"(escuro)" do KUAL têm prioridade naquela execução. |
| `DASHBOARD_KEEP_AWAKE` | `1` | `0` deixa o Kindle dormir normalmente. |
| `DASHBOARD_SLEEP_WINDOW` | `off` | `HH:MM-HH:MM` pausa as atualizações à noite, ex.: `23:00-07:00`. |
| `DASHBOARD_TIMEZONE` | o do Kindle | Defina (ex.: `America/Sao_Paulo`) se o relógio do Kindle mostrar o fuso errado. |

### Bateria e frequência de atualização

O painel não fica "ao vivo" o tempo todo por padrão. A cada `INTERVAL`
segundos, o Kindle faz três coisas:

1. usa o Wi-Fi para buscar os dados no backend;
2. redesenha a tela e-ink, **só se algo mudou**;
3. volta a esperar.

Se nada mudou, a tela não é redesenhada, o que economiza bateria e evita
piscadas à toa. Mesmo assim, a cada 30 minutos o painel é redesenhado por
completo, para limpar qualquer aviso do próprio Kindle que tenha ficado por
cima.

Cada busca gasta bateria com o Wi-Fi. Por isso:

- **Quanto menor o `INTERVAL`, mais rápido as mudanças aparecem e mais
  bateria o Kindle gasta.**
- **Quanto maior, mais a bateria dura**, mas uma mudança feita no Telegram
  pode demorar até esse tempo para aparecer.

| `INTERVAL` | Mudanças aparecem em até | Bateria |
| --- | --- | --- |
| `60` | 1 minuto | Gasta mais |
| `180` (padrão) | 3 minutos | Equilíbrio |
| `600` | 10 minutos | Gasta menos |
| `1800` | 30 minutos | Gasta bem menos |

Isso vale para o que vem de fora (Telegram, clima, agenda). Tocar num item no
próprio Kindle atualiza a tela na hora, seja qual for o intervalo.

**Atualização instantânea (`DASHBOARD_LIVE_UPDATES="1"`):** o Kindle mantém
uma conexão aberta com o servidor (SSE), e o servidor avisa na hora quando
uma lista muda. As mudanças do Telegram aparecem em segundos, mas o Wi-Fi
nunca descansa, e a bateria dura **bem menos**. Vale a pena se o Kindle
ficar ligado na tomada.

Outras opções que ajudam a bateria:

- `DASHBOARD_SLEEP_WINDOW="23:00-07:00"`: não busca nada durante a noite.
- `DASHBOARD_KEEP_AWAKE="0"`: deixa o Kindle entrar em descanso normalmente.
  O painel para de atualizar enquanto ele estiver descansando.

Se o Kindle ficar sempre na tomada, você pode usar um intervalo curto e a
atualização instantânea sem preocupação.

### Sobre os acentos

A fonte da tela do Kindle só tem letras de A a Z, sem acentos. O backend
remove os acentos antes de enviar os dados ("Pão de queijo" aparece como
`PAO DE QUEIJO`). No Telegram, os textos continuam com acentos.

### Caixa de foto

A caixa do canto superior esquerdo mostra o arquivo
`/mnt/us/extensions/kindle-dashboard/assets/profile.pgm`, uma imagem PGM em
tons de cinza de 8 bits. Converta qualquer foto com o ImageMagick:

```sh
magick foto.jpg -colorspace Gray -resize 512x512^ -gravity center \
  -extent 512x512 -depth 8 profile.pgm
```

Você pode colocar a imagem de dois jeitos:

- copiar para `extensions/kindle-dashboard/assets/` no Kindle;
- ou colocar em `kindle/kual/kindle-dashboard/assets/profile.pgm` antes de
  compilar, e o pacote já a inclui.

Essa pasta é ignorada pelo Git, então sua foto nunca vai parar num commit.
Sem o arquivo, a caixa aparece como uma moldura vazia.

## Configurações do bot

Estas configurações ficam no banco de dados e são alteradas pelo Telegram,
não por aqui:

- `/resumo_hora <0-23>`: a hora local em que o resumo diário é enviado
  (padrão: 22).
- O resumo diário só funciona depois que você roda `npm run digest:schedule`
  uma vez.

Veja [BOT.md](BOT.md).
