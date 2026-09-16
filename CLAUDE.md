# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Um painel monocromático de tela única para um Kindle desbloqueado:

- **Kindle:** um programa nativo em C++ desenha em `/dev/fb0`.
- **Backend:** um projeto InsForge (BaaS sobre Postgres) entrega um único JSON.
- **Edição:** o conteúdo é editado por um bot do Telegram, não pelo Kindle.

É distribuído como kit com backend próprio: cada dono roda o seu projeto
InsForge, o seu bot e o seu config do KUAL. Por isso, nada pode ter endpoints
fixos no código.

Esta é a edição pública e compartilhável do projeto, feita para um público
brasileiro. Mantenha-a livre de dados pessoais:

- nada de URLs reais de projeto, tokens, IDs de chat ou conteúdo de
  calendário;
- nada de fotos (`*.pgm` está no `.gitignore`), nomes ou localizações reais;
- os exemplos usam endereços `seu-projeto` e dados genéricos
  (`kindle/native/fixtures/dashboard-data.json`).

### Idioma

Tudo o que o usuário vê está em português do Brasil: documentação, respostas
do bot, textos da tela, menu do KUAL, `config.sh.example`, `.env.example` e
mensagens dos scripts. Continuam em inglês os comentários de código, os nomes
de identificadores, as linhas de log (do Kindle e das funções) e os valores
internos do contrato JSON (`list_key`, `condition_label` etc.).

A fonte bitmap 5x7 do programa (`glyphRow`) só tem A–Z, dígitos e alguma
pontuação. Por isso:

- **Textos fixos da tela:** vão sem acento (`TERCA`, `INICIO`); um caractere
  desconhecido vira um glifo de `?`.
- **Textos vindos do backend:** `asciiFoldUpper` em `kindle-dashboard-data.ts`
  remove os acentos antes de enviar.
- **Status e rótulos de clima:** são traduzidos só na exibição
  (`displayStatus`, `displayCondition`), porque os valores em inglês também
  escolhem o ícone e vão para o log.
- **Tamanho:** botões e caixas têm largura fixa; confira na prévia se uma
  tradução nova não fica cortada.

### Documentação

A documentação faz parte do produto: o público são pessoas que não
programam, instalando no próprio Kindle.

| Arquivo | Papel |
| --- | --- |
| `README.md` | Apresentação e índice |
| `docs/INSTALACAO.md` | Passo a passo |
| `docs/INSTALACAO_COM_ASSISTENTE.md` | O mesmo, em forma de prompts |
| `docs/CONFIGURACAO.md` | Referência de todo segredo e chave do `config.sh` |
| `docs/ARQUITETURA.md` | Notas de design |
| `docs/BOT.md` | Referência do bot |
| `kindle/README.md` | Lado do Kindle |

Uma configuração nova ou uma mudança de comportamento precisa entrar no
documento correspondente. Se o layout mudar, gere de novo as imagens
`docs/images/preview-*.png`: desenhe o fixture com `--save-pgm` e depois rode
`magick in.pgm -resize 50% -strip out.png`.

O `AGENTS.md` cobre as convenções da plataforma InsForge e quais skills do
InsForge usar. Leia antes de mexer em qualquer coisa do backend.

## Comandos

Backend (CLI do InsForge, lê `.insforge/project.json`):

```sh
npm run kit:backend                            # aplica migrations + garante segredos + publica as 4 funções
npm run kit:backend -- --skip-secrets           # republica sem mexer nos segredos
npm run kit:backend -- --skip-deploy            # só migrations/segredos
npx @insforge/cli functions deploy <slug> --file functions/<slug>.ts --name "<Nome>"
npx @insforge/cli functions code <slug>         # baixa o código publicado — o único jeito real de confirmar um deploy
npx @insforge/cli db query "<sql>"
npx @insforge/cli logs function.logs
```

Telegram e resumo diário:

```sh
npm run telegram:chat-id -- --bot-token <token>     # descobre o chat id pelo getUpdates
npm run telegram:configure -- --bot-token <token> --chat-id <id> --base-url <url>
npm run digest:schedule -- --base-url <INSFORGE_BASE_URL>   # disparo de hora em hora do resumo, uma vez só
```

Programa nativo:

```sh
npm run check                          # == native:check == make -C kindle/native check
make -C kindle/native local            # compilação local -> build/kindle-dashboard-local
make -C kindle/native kindle           # compilação ARM, precisa de arm-linux-gnueabi-g++ (KINDLE_CXX= para trocar)
make -C kindle/native extension-zig    # compilação ARM + tarball do KUAL via Zig (ZIG= se não estiver no PATH)
make -C kindle/native extension        # o mesmo, com o compilador cruzado GNU
npm run native:install -- /caminho/do/Kindle [--force]
npm run native:proof -- /caminho/do/Kindle
```

### Verificando mudanças no programa nativo

O `npm run native:check` só prova que o parser de JSON e o layout não quebram.
Fora do aparelho não há framebuffer, então nada é desenhado
(`render=framebuffer open_failed` é esperado e mesmo assim sai com 0). Para
ver uma mudança de verdade, gere um PGM e abra:

```sh
cd kindle/native && make local
./build/kindle-dashboard-local --render fixtures/dashboard-data.json --save-pgm /tmp/out.pgm
./build/kindle-dashboard-local --render fixtures/dashboard-data.json --view chores --dark --save-pgm /tmp/dark.pgm
./build/kindle-dashboard-local --render fixtures/dashboard-data.json --view grocery --title "algum texto" --save-pgm /tmp/title.pgm
```

O título do cabeçalho (`g_title`, vindo de `--title` / `DASHBOARD_TITLE` no
`config.sh`, padrão `PAINEL KINDLE`) só aparece nas listas em tela cheia; o
cabeçalho da tela principal é a barra de clima.

Uma flag nova do programa precisa passar por todos estes lugares:

- os dois inicializadores:
  - `kindle/kual/kindle-dashboard/bin/dashboard.sh` (duas chamadas: o ciclo e
    o `--once`);
  - `kindle/launch-dashboard.sh`;
- o `config.sh.example`;
- o gerador de config em `scripts/install-kindle-native.mjs`;
- o `docs/CONFIGURACAO.md`.

`--view chores|grocery` abre a lista em tela cheia, o mais perto de rodar um
"caso de teste" isolado. Edite `kindle/native/fixtures/dashboard-data.json`
para testar um formato de JSON sem chamar o backend real.

Não há framework de testes nem linter neste repositório. **`npx tsc --noEmit`
não passa e não é uma verificação**: o `tsconfig.json` inclui
`functions/**/*.ts`, mas esses arquivos rodam em Deno (`Deno.env.get`,
`npm:@insforge/sdk`), então todo arquivo dá erro de globais ausentes. As edge
functions só são validadas de verdade no deploy; o InsForge compila ao
publicar.

O `npm run native:proof` só funciona no macOS (usa `sips`), e os dois scripts
do Kindle usam `/Volumes/Kindle` como padrão. No Linux, passe sempre o caminho
de montagem.

## Arquitetura

```
Telegram ──▶ telegram-webhook ──▶ Postgres (planner_items)  ──▶ kindle-dashboard-data ──▶ Kindle
                   │                       │                            ▲      (a cada 3 min)
                   └──▶ CalDAV (agenda)    └──▶ kindle-dashboard-events ─┘ (SSE opcional: "busque de novo")
                                                toque no Kindle ──▶ kindle-dashboard-toggle
```

O código se divide assim:

- **`functions/`:** quatro edge functions em Deno. O
  `functions/telegram-webhook.ts` tem ~3,5 mil linhas e contém o bot inteiro:
  interpretação, ações, respostas, resumo e exportação.
- **`migrations/`:** o schema, uma tabela por assunto.
- **`kindle/native/src/kindle_dashboard.cpp`:** um único arquivo C++ de ~3 mil
  linhas, com parser de JSON, layout, glifos desenhados à mão, escrita no
  framebuffer e toque.

Cada função é independente e não existe módulo compartilhado. Por isso,
funções auxiliares como `jsonResponse`, `requiredEnv` e `corsHeaders` são
duplicadas em cada arquivo de propósito (o InsForge publica um arquivo por
função). Não tente extraí-las.

A autenticação é por cabeçalhos com segredo compartilhado, um por superfície,
sem contas de usuário: `x-telegram-bot-api-secret-token`,
`x-dashboard-read-token` e `x-dashboard-toggle-token`. O projeto tem um único
dono, de propósito: não há separação por usuário em lugar nenhum, e o
`TELEGRAM_ALLOWED_CHAT_ID` é o que torna o bot privado.

O Kindle busca o JSON a cada `INTERVAL` (padrão 180 s, em
`kDefaultIntervalSeconds` e nos dois inicializadores). O SSE é opcional
(`DASHBOARD_LIVE_UPDATES`, padrão `0`) por causa da bateria: quando está
desligado, os inicializadores esvaziam `DASHBOARD_EVENTS_URL` e o
`startEventWatcher` não abre a conexão. Qualquer mudança nesses padrões
precisa refletir a troca entre rapidez e bateria na documentação.

Depois de cada busca, o `renderPayload` (modo `kRenderIfChanged`) pula o
desenho se a assinatura da tela (versão + linha de data/status + lista aberta
+ bloqueio + tema) for igual à última desenhada; há redesenho forçado a cada
`kForcedRedrawMs`. Qualquer coisa nova que mude os pixels precisa entrar
nessa assinatura. Desenhos por toque usam `kRenderForce`, que apaga a
assinatura, para a próxima busca sempre corrigir a tela. Fora do Kindle nada
é "desenhado" (sem framebuffer), então o skip só aparece no log de um
aparelho real, ou numa cópia de teste em que `dumpBitmapPreview` conte como
desenho.

O `DASHBOARD_TIMEZONE` cai para `"America/Sao_Paulo"` tanto em `kindle-dashboard-data.ts`
quanto em `telegram-webhook.ts` (`DEFAULT_TIMEZONE`); mantenha os dois padrões
iguais.

Os segredos ficam nos **segredos do InsForge** em tempo de execução
(`Deno.env.get` dentro das funções). O `.env` / `.env.example` só alimentam os
`scripts/*.mjs` locais e documentam o que configurar; nada em `functions/` lê
um `.env` local.

### Invariantes entre arquivos

Estes são os que quebram em silêncio se você esquecer:

- **A ordem de `lists` é um contrato.** O `kindle-dashboard-data.ts` precisa
  emitir `todo`, `grocery`, `notes` nessa ordem: o programa associa o índice
  do array direto a uma caixa na tela. Reordenar a consulta troca as caixas
  sem aviso.
- **O hash de versão do SSE precisa cobrir tudo o que o painel mostra.**
  - O `kindle-dashboard-events.ts` recalcula uma versão a partir de
    `planner_items` e só avisa o Kindle quando ela muda.
  - Qualquer lista ou campo que o painel mostre e o hash ignore nunca dispara
    aviso; só aparece na próxima busca por `INTERVAL`.
  - O clima e a agenda ficam de fora de propósito: mudam com o relógio, não
    com gravações.
- **Toda gravação que muda `done` também precisa mudar `completed_at`**
  (preencher quando vira true, limpar quando vira false).
  - O resumo diário usa esse campo para distinguir "concluído hoje" de "mudou
    de lista hoje"; o `updated_at` não serve para isso.
  - Vale para o `kindle-dashboard-toggle.ts` e para os caminhos de concluir e
    reabrir do webhook.
- **Os números dos itens no Kindle precisam bater com os do `/listas`.**
  - O `orderForNumbering` está duplicado, idêntico, em
    `kindle-dashboard-data.ts` e `telegram-webhook.ts`, e os dois consultam
    ordenando por `created_at` crescente.
  - O `kindle-dashboard-data.ts` numera todas as linhas **antes** de esconder
    as concluídas antigas (`shouldShowPlannerItem`) e envia `number` e
    `important` por item.
  - Mudar a ordem num lado sem mudar no outro faz "exclua o item 2" apagar a
    linha errada.
- **Horários saem com deslocamento explícito, nunca com `Z`.** O programa não
  tem tabelas de fuso e imprime os dígitos como vieram. Eventos de dia inteiro
  ficam só com a data.
- **Migrations novas precisam ser adicionadas a `schemaMigrations` em
  `scripts/bootstrap-insforge-kit.mjs`**, porque não há varredura do
  diretório.
  - O script aplica cada `.sql` via `db query`, então
    `insforge db migrations list` fica sempre vazio aqui.
  - Confira o schema com consultas a `information_schema`.
- **Toda região visível precisa de uma região de toque, mesmo as inertes.**
  Toques que não acertam nada são tentados de novo com sete transformações
  espelhadas/rotacionadas (os eixos da tela de toque variam entre modelos),
  então uma área sem região manda o palpite para outro lugar da tela. Ocupe a
  área com `kTouchNone`.

### Interpretação das mensagens do Telegram

O `parseTelegramMessage` segue três etapas, e o resultado é validado antes de
qualquer gravação:

1. passada determinística rápida;
2. IA;
3. reserva determinística.

Estes pontos são essenciais, não preferências:

- **Formato da requisição:** a chamada à IA usa `response_format: json_schema`
  com `strict: true` e uma resposta em **array** (uma mensagem pode ter várias
  ações). Um prompt em texto do tipo "um destes dois formatos" faz o Gemini
  devolver os dois formatos aninhados, o que falha em todos os validadores.
- **Sem uniões:** uniões não funcionam igual em todos os backends compatíveis
  com OpenAI. Por isso, o schema declara todos os campos dos tipos `planner` e
  `calendar` e preenche a metade não usada com valores vazios.
- **Latência:** `reasoning_effort: "low"` mantém as respostas em ~1 s contra
  um tempo limite de 12 s; sem isso, o Gemini 3.x gasta 9–13 s pensando.
- **Cota:** um 429 é esperado no plano gratuito e é informado como `"quota"`,
  para a resposta apontar os botões. Só o 503 ganha uma nova tentativa, uma
  vez.
- **Cache:** o `bot_parse_cache` guarda resultados pelo hash da mensagem
  normalizada; **ações de agenda nunca entram no cache** (dependem de
  "agora").
- **Tokens:** o `bot_actions` guarda os tokens de desfazer e desambiguação,
  consumidos no uso e apagados depois de 24 h.
- **Menu sem estado:** as respostas aos botões do menu recuperam a categoria
  pelo texto da pergunta de resposta obrigatória. Assim, o bot não guarda
  estado de sessão, e adições a listas pulam a IA por completo.

Os textos do bot ficam no bloco `MSG` no topo do `telegram-webhook.ts`. As
respostas repetem o texto do item **como está salvo**, para que uma busca
aproximada errada fique visível. Busque as linhas antes de gravar; nunca
dispare um `UPDATE ... ILIKE` às cegas repetindo o pedido.

## Peculiaridade conhecida das ferramentas

O `npx @insforge/cli functions deploy` (e, portanto, o `npm run kit:backend`)
costuma terminar o trabalho e travar em vez de sair, com a saída presa no
buffer. Se a saída de um deploy ficar vazia por mais de um ou dois minutos,
ele não está travado no meio do deploy:

1. Confira de forma independente: compare `functions code <slug>` com o
   arquivo local, ou faça um `db query` pela coluna de uma migration.
2. Rode `kill -TERM` no processo filho `node .../insforge`; o pai `npm exec`
   sai junto.
3. Processos órfãos se acumulam em silêncio entre sessões, então rode
   `ps aux | grep insforge` ao verificar um deploy.
