# Instalação Com Um Assistente De Código

Use este guia se quiser que o Claude Code, Codex, Cursor, ChatGPT ou outro
assistente de código ajude a montar o seu Painel Kindle.

O assistente pode rodar comandos do repositório, editar arquivos de
configuração e ler logs. Mesmo assim, mantenha o controle dos segredos: cole
tokens só em comandos no terminal ou em arquivos `.env` locais, que o Git
ignora.

O repositório já traz um `CLAUDE.md` e um `AGENTS.md` com o contexto do
projeto para esses assistentes.

## Prepare Antes

- Uma cópia local deste repositório.
- Node.js 20+ e npm.
- Uma conta no InsForge.
- Um token de bot do Telegram, criado com o BotFather.
- Opcional: um calendário CalDAV para a agenda.
- Um Kindle desbloqueado com o KUAL instalado (veja o passo 0 do
  [INSTALACAO.md](INSTALACAO.md)).
- Opcional: Zig ou um compilador cruzado ARM para compilar o pacote.

## Prompt: Começar A Instalação

Cole isto no seu assistente, a partir da raiz do repositório:

```text
Quero instalar este Painel Kindle, com backend próprio, no meu Kindle.
Siga docs/INSTALACAO.md, docs/CONFIGURACAO.md e AGENTS.md (ou CLAUDE.md).

Importante:
- Não coloque segredos no código nem em commits.
- Use npx @insforge/cli para os comandos do InsForge.
- Só crie ou vincule um projeto InsForge depois de confirmar comigo.
- Prepare o backend com npm run kit:backend.
- Me ajude a configurar o Telegram, a localização do clima, o CalDAV, a gerar
  o config.sh do Kindle e a verificar as URLs publicadas do painel.
- Use as URLs de exemplo só como exemplo.
```

## Prompt: Preparar O Backend

Depois de entrar no InsForge, use este prompt:

```text
Verifique o projeto vinculado com npx @insforge/cli current. Se não houver
nenhum, me pergunte se devo criar um projeto novo ou vincular um vazio que já
existe. Depois rode npm run kit:backend e me diga se alguma migration, segredo
ou deploy de função falhou.
```

Se o assistente precisar que você crie o projeto manualmente, use:

```sh
npx @insforge/cli create --name kindle-dashboard --region us-east --template empty
```

## Prompt: Segredos

Use este prompt na hora de adicionar os segredos:

```text
Me ajude a adicionar os segredos do InsForge no servidor. Pergunte um valor
por vez e nunca mostre o segredo completo de volta depois que eu digitar.

Obrigatórios:
- INSFORGE_BASE_URL
- INSFORGE_API_KEY
- WEATHER_LAT
- WEATHER_LON

Opcionais:
- DASHBOARD_TIMEZONE (padrão: America/Sao_Paulo; só se eu estiver em outro fuso)
- CALDAV_BASE_URL, CALDAV_CALENDAR_PATH, CALDAV_USERNAME, CALDAV_PASSWORD
  (os quatro, ou nenhum)
- LLM_API_KEY
- LLM_BASE_URL (padrão: https://generativelanguage.googleapis.com/v1beta/openai)
- LLM_MODEL (padrão: gemini-3.5-flash-lite; é uma escolha de cota, porque os
  modelos flash completos permitem só ~20 requisições grátis por dia)
- LLM_REASONING_EFFORT (padrão: low; sem isso o Gemini 3.x gasta 9-13s
  pensando numa classificação de um segundo)
```

O assistente pode rodar comandos como:

```sh
npx @insforge/cli secrets add INSFORGE_BASE_URL https://seu-projeto.insforge.app
npx @insforge/cli secrets add INSFORGE_API_KEY sua-api-key-do-servidor
npx @insforge/cli secrets add WEATHER_LAT -23.5505
npx @insforge/cli secrets add WEATHER_LON -46.6333
npx @insforge/cli secrets add CALDAV_BASE_URL https://seu-servidor-caldav
npx @insforge/cli secrets add CALDAV_CALENDAR_PATH /calendars/usuario/pessoal/
```

## Prompt: Telegram

Depois de criar o bot no BotFather e mandar uma mensagem para ele, use:

```text
Me ajude a conectar o Telegram. Vou passar o token do meu bot. Primeiro rode
npm run telegram:chat-id para descobrir o ID do meu chat. Depois rode
npm run telegram:configure com o token, o ID do chat e a URL do
telegram-webhook do meu projeto. Não use URLs de exemplo e não coloque o
token em commits nem na documentação. Em seguida, rode npm run
digest:schedule com a URL do meu projeto para ativar o resumo diário.
```

A URL do webhook tem este formato:

```text
https://seu-projeto.insforge.app/functions/telegram-webhook
```

Com o Telegram conectado, peça ao assistente para revisar as mensagens aceitas
em `docs/INSTALACAO.md`:

```text
Mostre os exemplos de mensagens do Telegram em docs/INSTALACAO.md e me ajude
a testar um comando de compras/tarefas e um de agenda, sem expor tokens.
```

## Prompt: Configuração Do Kindle

Use este prompt quando o backend estiver publicado:

```text
Gere o config.sh do KUAL para o meu projeto. Use o endereço base do meu
InsForge nas URLs de dados e de toggle, e o endereço direto function2 na URL
de eventos. Busque DASHBOARD_READ_TOKEN e DASHBOARD_TOGGLE_TOKEN no InsForge e
coloque no meu config.sh local. Pergunte qual título devo usar em
DASHBOARD_TITLE e de quanto em quanto tempo o Kindle deve buscar novidades
(INTERVAL, padrão 180 segundos), explicando que intervalos menores e a
atualização instantânea (DASHBOARD_LIVE_UPDATES) gastam mais bateria.
Não altere o config.sh.example com os dados reais do meu projeto; crie ou
mostre um config.sh local.
```

O config gerado deve ficar assim:

```sh
DASHBOARD_DATA_URL="https://seu-projeto.insforge.app/functions/kindle-dashboard-data"
DASHBOARD_EVENTS_URL="https://seu-projeto.function2.insforge.app/kindle-dashboard-events"
DASHBOARD_TOGGLE_URL="https://seu-projeto.insforge.app/functions/kindle-dashboard-toggle"
DASHBOARD_READ_TOKEN="troque-pelo-seu-read-token"
DASHBOARD_TOGGLE_TOKEN="troque-pelo-seu-toggle-token"
DASHBOARD_TITLE="Meu Kindle"
INTERVAL="180"
DASHBOARD_LIVE_UPDATES="0"
DASHBOARD_KEEP_AWAKE="1"
DASHBOARD_SLEEP_WINDOW="off"
DARK_MODE="0"
```

## Prompt: Compilar O Pacote Do KUAL

Antes de empacotar, peça ao assistente:

```text
Rode npm run native:check e me diga se a verificação local passou.
```

Se o Zig estiver instalado:

```text
Compile o pacote do KUAL com make -C kindle/native extension-zig. Se o zig
não estiver no PATH, me pergunte o caminho. Depois me diga onde o
kindle-dashboard-kual.tar.gz foi gravado e me lembre de manter o config.sh
local. Se for instalar num Kindle conectado, descubra primeiro o caminho onde
ele está montado (me pergunte se não tiver certeza), defina as variáveis
DASHBOARD_* explicitamente e rode npm run native:install -- <caminho>.
```

Se houver um compilador ARM para Kindle instalado:

```text
Compile o pacote do KUAL com make -C kindle/native extension. Se o compilador
cruzado não existir, me pergunte o KINDLE_CXX ou sugira o caminho com Zig.
```

## Prompt: Verificar

Use depois do deploy e da instalação no Kindle:

```text
Verifique a instalação sem expor segredos. Confira se npm run check passa.
Teste a URL de dados com curl e confirme que ela devolve JSON com ok:true e
com weather.available e agenda.available iguais a true. Se o Kindle estiver
conectado (me pergunte o caminho), confira se o
extensions/kindle-dashboard/config.sh dele tem as chaves obrigatórias, sem
mostrar os valores secretos, e leia os logs do painel em documents/ no
Kindle. Não altere outros arquivos do Kindle.
```

Verificações úteis:

```sh
npm run check
curl -sS -H "X-Dashboard-Read-Token: <read-token>" https://seu-projeto.insforge.app/functions/kindle-dashboard-data
curl -N -H "X-Dashboard-Read-Token: <read-token>" https://seu-projeto.function2.insforge.app/kindle-dashboard-events
```

## Etapas Que Só Você Deve Fazer

Faça você mesmo, ou supervisione de perto:

- Criar o bot do Telegram no BotFather.
- Digitar as chaves de administrador do InsForge.
- Digitar os tokens do bot do Telegram.
- Digitar a senha (ou senha de app) do seu CalDAV.
- Copiar arquivos para o Kindle, se não se sentir à vontade com o assistente
  escrevendo num aparelho conectado.
- Ativar a inicialização automática do painel junto com o Kindle.

## Resolvendo Problemas Com Um Assistente

Se o painel estiver em branco ou desatualizado:

```text
Investigue o problema do meu Painel Kindle. Comece pela URL de dados
publicada, depois as URLs do config.sh do KUAL, e depois os logs do Kindle.
Lembre que, sem DASHBOARD_LIVE_UPDATES="1", as mudanças só aparecem a cada
INTERVAL. Se a atualização instantânea estiver ligada, considere que o
endpoint /functions normal não serve para SSE e teste os eventos pela URL
function2.insforge.app.
```

Se o clima ou a agenda aparecerem como indisponíveis:

```text
Investigue por que weather.available ou agenda.available está false na
resposta do kindle-dashboard-data. Confira WEATHER_LAT/WEATHER_LON, veja se
CALDAV_BASE_URL/CALDAV_CALENDAR_PATH/CALDAV_USERNAME/CALDAV_PASSWORD estão
configurados e se o servidor CalDAV é acessível a partir do InsForge. Não
mostre a senha do CalDAV.
```

Se os comandos do Telegram não fizerem nada:

```text
Investigue o Telegram deste kit. Confira a URL do webhook, o segredo do
webhook, o TELEGRAM_ALLOWED_CHAT_ID e o comportamento recente da função. Não
mostre tokens completos.
```

Se o menu do KUAL abrir mas nada for desenhado:

```text
Inspecione a instalação no Kindle. Confira se o programa existe, se os
scripts são executáveis, se o config.sh existe, e se os logs em
/mnt/us/documents (documents/ no drive conectado) mostram o comando que
falhou.
```
