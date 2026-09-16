# Guia de Instalação

Este guia leva você de um Kindle desbloqueado até o painel funcionando. Você
vai usar seu próprio backend (InsForge), seu próprio bot do Telegram e o
pacote do KUAL no Kindle. Nada aqui se conecta ao servidor de outra pessoa.

Se quiser que um assistente de código faça isso junto com você, use o
[INSTALACAO_COM_ASSISTENTE.md](INSTALACAO_COM_ASSISTENTE.md). Todas as
configurações citadas abaixo estão descritas em
[CONFIGURACAO.md](CONFIGURACAO.md).

**Tempo:** cerca de uma hora, sem contar o jailbreak.

## Do Que Você Precisa

- Um Kindle desbloqueado com o KUAL instalado (passo 0).
- Um computador com macOS ou Linux, com Node.js 20+, npm e git.
- Um cabo USB para o Kindle.
- Uma conta no [InsForge](https://insforge.dev) (o plano gratuito basta).
- Uma conta no Telegram.
- Opcional: um calendário CalDAV para a agenda.
- Opcional: uma [chave gratuita do Gemini](https://aistudio.google.com/apikey)
  para mensagens de texto livre e de voz.
- Para compilar o pacote do Kindle: [Zig](https://ziglang.org/download/) (o
  mais fácil) ou um compilador cruzado ARM.

## 0. Faça O Jailbreak E Instale O KUAL

Este projeto roda como uma extensão do KUAL (Kindle Unified Application
Launcher), então o Kindle precisa de jailbreak e do KUAL antes de tudo. O
método depende do modelo e da versão do firmware e muda com o tempo. Por isso,
siga as instruções atualizadas para o seu aparelho em vez de uma cópia aqui:

- [kindlemodding.org](https://kindlemodding.org/): guias atualizados de
  jailbreak e KUAL (em inglês).
- [MobileRead Kindle Developer's Corner](https://www.mobileread.com/forums/forumdisplay.php?f=150):
  a comunidade por trás da maioria das ferramentas para Kindle (em inglês).

Você está pronto quando aparecer um item **KUAL** na biblioteca do Kindle e
ele abrir um menu. Se o guia que você seguir recomendar, desative também as
atualizações automáticas de firmware, porque uma atualização pode remover o
jailbreak.

O pacote do Kindle nunca guarda a chave de administrador do InsForge. Ele lê
os dados por URLs do painel protegidas por token e envia as marcações de
itens pela função de toggle.

## 1. Crie Seu Backend

Clone o repositório, instale as dependências e entre no InsForge:

```sh
git clone https://github.com/metrognme/kdashboard-pt.git kindle-dashboard
cd kindle-dashboard
npm install
npx @insforge/cli login
```

Crie um projeto novo no InsForge, ou vincule esta pasta a um projeto vazio que
você já tenha:

```sh
npx @insforge/cli create --name kindle-dashboard --region us-east --template empty
```

Prepare o banco, os segredos gerados e as funções:

```sh
npm run kit:backend
```

O script de preparação faz três coisas:

- aplica as migrations do banco;
- cria os segredos `TELEGRAM_WEBHOOK_SECRET`, `DASHBOARD_READ_TOKEN`,
  `DASHBOARD_TOGGLE_TOKEN` e `DAILY_DIGEST_TOKEN`, se ainda não existirem;
- publica as funções do painel.

> Se o comando terminar o trabalho mas não devolver o terminal, veja
> "Travou no deploy?" em [Solução de Problemas](#solução-de-problemas).

## 2. Adicione Os Segredos Do Backend

Configure a URL do backend e a chave de API. Esses valores são segredos das
funções no servidor, não do Kindle. Os dois ficam no painel do seu projeto no
InsForge.

```sh
npx @insforge/cli secrets add INSFORGE_BASE_URL https://seu-projeto.insforge.app
npx @insforge/cli secrets add INSFORGE_API_KEY sua-api-key-do-servidor
```

O fuso horário padrão é o de Brasília (`America/Sao_Paulo`). Se você estiver
em outro fuso, configure o seu [nome IANA](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones):

```sh
npx @insforge/cli secrets add DASHBOARD_TIMEZONE America/Manaus
```

Clima (Open-Meteo: gratuito, sem chave, só a sua localização em graus
decimais; no Google Maps, clique com o botão direito num ponto para copiar):

```sh
npx @insforge/cli secrets add WEATHER_LAT -23.5505
npx @insforge/cli secrets add WEATHER_LON -46.6333
```

Agenda (opcional; é o seu servidor CalDAV). Se pular este bloco, a faixa da
agenda só aparece como indisponível:

```sh
npx @insforge/cli secrets add CALDAV_BASE_URL https://seu-servidor-caldav
npx @insforge/cli secrets add CALDAV_CALENDAR_PATH /calendars/usuario/pessoal/
npx @insforge/cli secrets add CALDAV_USERNAME seu-usuario-caldav
npx @insforge/cli secrets add CALDAV_PASSWORD sua-senha-ou-senha-de-app
```

Interpretação de linguagem natural (opcional). Funciona com qualquer endpoint
compatível com OpenAI; o padrão é o
[Gemini](https://ai.google.dev/gemini-api/docs/openai), cuja chave você gera
no [Google AI Studio](https://aistudio.google.com/apikey):

```sh
npx @insforge/cli secrets add LLM_API_KEY sua-chave-do-gemini
npx @insforge/cli secrets add LLM_BASE_URL https://generativelanguage.googleapis.com/v1beta/openai
npx @insforge/cli secrets add LLM_MODEL gemini-3.5-flash-lite
npx @insforge/cli secrets add LLM_REASONING_EFFORT low
```

Vale entender duas dessas configurações em vez de só copiar:

- **`LLM_MODEL`** é uma decisão de cota. No plano gratuito do Gemini, os
  modelos flash completos permitem só cerca de **20 requisições por dia**, e
  uma tarde de uso acaba com isso; os modelos flash-lite permitem bem mais.
  Confira os seus números em [ai.dev/rate-limit](https://ai.dev/rate-limit).
- **`LLM_REASONING_EFFORT=low`** é o que deixa as respostas rápidas. Por
  padrão, o Gemini 3.x "pensa" antes de responder, o que transforma uma
  resposta de um segundo numa de nove a treze segundos, sem ganho nenhum numa
  tarefa tão pequena.

Mensagens repetidas não gastam cota. Uma frase que a IA já interpretou é
respondida a partir de um cache local, cerca de 5x mais rápido e de graça. Só
ações de lista entram no cache: uma frase de agenda como "reunião amanhã às
14h" depende da data atual, então guardá-la estaria errado amanhã.

Sem `LLM_API_KEY`, ou quando a cota do dia acaba, o webhook usa o
interpretador de comandos embutido, que entende verbos em português e em
inglês. Nesse modo:

- **Menu de botões (`/menu`):** funciona por completo para Tarefa, Nota e
  Compras, porque a categoria vem explícita no botão e nada precisa ser
  adivinhado.
- **Comandos de lista em texto livre:** adicionar, concluir, reabrir, apagar
  e limpar continuam funcionando.
- **Agenda:** cancelar um evento pelo nome funciona. Só agendar um evento com
  data relativa, como "amanhã", precisa da IA.

Quando o bot bate no limite de cota, ele avisa e sugere usar os botões.

## 3. Conecte O Telegram

1. No Telegram, abra o [@BotFather](https://t.me/BotFather), mande `/newbot`
   e siga as instruções. O BotFather responde com um token parecido com
   `123456789:AA...`.
2. Abra o seu bot novo, toque em **Iniciar** e mande qualquer mensagem.
3. Descubra o ID do seu chat:

```sh
npm run telegram:chat-id -- --bot-token 123456789:token-do-bot
```

Registre o webhook e salve o token do bot e o chat autorizado:

```sh
npm run telegram:configure -- \
  --bot-token 123456789:token-do-bot \
  --chat-id 123456789 \
  --webhook-url https://seu-projeto.insforge.app/functions/telegram-webhook
```

Ative o resumo diário (uma mensagem toda noite com o que foi feito). Isso só
precisa rodar uma vez:

```sh
npm run digest:schedule -- --base-url https://seu-projeto.insforge.app
```

Mande `/start` para o seu bot para ver o menu de botões, ou teste um comando
em texto livre:

```text
comprar leite e ovos
adicionar limpar a mesa nas tarefas
anota a senha do wifi
já comprei o leite
reunião amanhã às 14h com o time
```

## Mensagens Que O Telegram Entende

Há dois jeitos de falar com o bot:

- **Menu de botões:** sempre funciona e não usa IA.
- **Texto livre:** com `LLM_API_KEY` configurada, você pode escrever de forma
  natural. Sem ela, o interpretador embutido entende os padrões abaixo.

Esta seção é um tour. O [BOT.md](BOT.md) é a referência completa:

- controle de acesso;
- todas as respostas que o bot pode dar e o que significam;
- como a mensagem é interpretada;
- limites e operação no dia a dia.

### Quem pode usar o seu bot

O `@nome` do seu bot é público e qualquer pessoa pode abrir uma conversa com
ele, mas ele só responde ao chat que você registrou como
`TELEGRAM_ALLOWED_CHAT_ID`. Todos os outros recebem **silêncio**: a mensagem é
descartada antes de ser interpretada, antes de chegar à IA e antes de qualquer
gravação. Toques em botões passam pela mesma verificação, então encaminhar
uma confirmação para alguém não entrega um botão funcionando.

A verificação é feita no *chat*, não na pessoa. Para compartilhar o bot com a
família, coloque-o num grupo e autorize o ID desse grupo. Veja as duas
configurações que você precisa mudar antes em
[BOT.md](BOT.md#compartilhando-com-a-família).

### Menu de botões

Mande `/start` (ou `/menu`) uma vez. O bot fixa um teclado de 4 botões na
conversa:

```text
📋 Tarefa      📝 Nota
🛒 Compras     📅 Agenda
```

Toque num botão, o bot pergunta o que adicionar, e você responde. Só isso.
Para as três listas, nada é classificado nem adivinhado, então esse caminho
funciona igual com ou sem `LLM_API_KEY`. Separe várias entradas com vírgulas
para adicionar tudo numa mensagem só.

`📅 Agenda` é a exceção: o texto da sua resposta ainda vai para a IA, para que
"reuniao amanha as 14h" vire uma data e hora de verdade.

`👀 Ver listas` é o quinto botão e responde na hora, sem perguntar nada: mostra
a agenda e depois as três listas. `/listas` (ou `/ver`) faz o mesmo pelo
teclado.

`/exportar` manda os mesmos dados como arquivo em vez de mensagem:

- o formato padrão é `.json`; escreva `yaml` para receber `.yaml`;
- escreva o nome de uma categoria (`compras`, `tarefas`, `notas`, `agenda`)
  para exportar só ela, por exemplo `/exportar compras yaml`;
- sem categoria, exporta tudo.

O teclado é persistente: fica disponível até você escondê-lo, e `/menu` o traz
de volta. `/ajuda` mostra a colinha completa de frases em texto livre.

### Desfazer

Toda confirmação que realmente mudou algo vem com um botão `↩️ Desfazer`. Ele
reverte exatamente aquela mensagem:

- itens apagados voltam com o estado original de feito/não feito;
- o que foi marcado é desmarcado;
- o que foi criado é apagado;
- um evento cancelado é restaurado a partir do ICS original.

Isso importa porque concluir e apagar encontram o item por um trecho do
texto, então o bot pode acertar uma linha que você não queria. O botão vale
por 24 horas e funciona uma vez; tocar de novo avisa que a ação já foi
desfeita.

### Quando o bot não tem certeza, ele pergunta

Se uma palavra combina com mais de um item (por exemplo, "já comprei o pão"
com `pão` e `pão de forma` na lista), nada é alterado. O bot mostra as opções
como botões e aplica só a que você tocar. Há também:

- `⚡ Todos`, para quando você queria mesmo pegar todos;
- `✖️ Cancelar`, para desistir.

O mesmo acontece em dois outros casos:

- **Cancelar evento:** quando o nome combina com vários eventos.
- **Adicionar item sem citar a lista:** o bot precisa adivinhar a lista, então
  salva o item na hora e oferece movê-lo. Nada fica esperando um toque seu.

### Mensagens de voz

Segure para gravar e fale: "comprar leite, pão e ovos". O bot responde com o
que ouviu, seguido do que fez:

```text
🎤 "comprar leite, pão e ovos"
✅ Anotei 3 itens em 🛒 Compras: leite, pão, ovos.
```

A transcrição e a interpretação acontecem numa única chamada à IA, então um
áudio gasta da cota a mesma requisição que uma mensagem digitada. Os limites
são 5 minutos e 5 MB.

Esse caminho fala com o endpoint nativo do Gemini, e não com o compatível com
OpenAI, porque aquela camada só aceita áudio `wav` e `mp3`, enquanto o
Telegram manda OGG/Opus. O endereço é derivado de `LLM_BASE_URL`
automaticamente; defina `LLM_AUDIO_BASE_URL` para sobrescrever. Com outro
provedor, o bot avisa que o áudio está indisponível e o resto continua
funcionando.

### Listas de compras, tarefas e notas

Listas aceitas (os apelidos valem em português e inglês, com ou sem acento):

- Compras: `compras`, `comprar`, `mercado`, `supermercado`, `feira`, `grocery`, `groceries`, `shopping`, `market`
- Tarefas: `tarefa`, `tarefas`, `afazeres`, `pendências`, `todo`, `to-do`, `task`, `tasks`, `errand`, `errands`
- Notas: `nota`, `notas`, `anotação`, `recado`, `note`, `notes`

As três aparecem na tela do Kindle, cada uma na sua caixa, e as três podem ser
tocadas para abrir em tela cheia.

Os itens aparecem **numerados**, com os mesmos números do `/listas`, e os
**importantes** vêm primeiro, marcados com `!`:

```text
[ ] !1. PAGAR LUZ
[ ] 2. REGAR HORTA
[X] 3. LAVAR LOUCA
```

Use esses números nos comandos:

```text
exclua o item 2 da lista de tarefas
conclua a tarefa 1
mude o texto do item 2 das compras para leite integral
marca a tarefa 2 como importante
tira a importância da tarefa 1
```

Nas caixas pequenas da tela principal, textos longos aparecem cortados; abra a
lista (toque na caixa) para ver o texto inteiro.

Adicionar itens:

```text
comprar leite e pão
preciso de maçã, iogurte e aveia no mercado
adicionar limpar a mesa nas tarefas
anota o código do portão 4417 nas notas
```

Marcar como feito:

```text
já comprei o leite
feito: limpar a mesa
```

Reabrir um item:

```text
desmarca o leite
```

Remover itens:

```text
tira os ovos das compras
apaga limpar a mesa das tarefas
```

Limpar uma lista:

```text
limpa as tarefas
esvazia as compras
```

Uma mensagem pode ter vários pedidos diferentes:

```text
anota o código do alarme 7788, adiciona regar as plantas nas tarefas
e marca os ovos como comprados
```

Cada pedido vai para a sua lista, a resposta mostra todos, e um único
`↩️ Desfazer` desfaz a mensagem inteira. Vários itens do mesmo tipo contam
como um pedido só: "comprar leite e pão" é uma adição com dois itens, não duas
adições.

Se um comando de concluir, reabrir ou remover não citar a lista, o webhook
procura o texto em todas as listas e diz onde achou.

O bot responde sempre em português, dizendo qual lista mexeu e o texto exato
do item que encontrou. Se não encontrar nada, ele diz isso também
(`🤔 Não achei "banana" em 🛒 Compras.`) em vez de confirmar uma mudança que
não aconteceu.

### Agenda (calendário)

Agendar um evento precisa de `LLM_API_KEY`, porque entender "amanhã" ou
"segunda que vem" de forma confiável exige IA:

```text
reunião amanhã às 14h com o time
consulta no dentista dia 20/09 às 10h
agendar alinhamento do time segunda que vem das 9h às 9h30
```

Cancelar um evento funciona sem IA, buscando pelo título:

```text
cancela a reunião do time
apaga a consulta do dentista
```

Se mais de um evento futuro combinar com o título, o bot lista as opções com
as datas e pede para você escolher, em vez de adivinhar qual apagar. A busca
ignora acentos, então "reuniao" encontra "Reunião". Um evento recorrente conta
uma vez só, não uma por ocorrência: cancelá-lo remove a série inteira.

A agenda sempre mostra os **próximos eventos, seja qual for a data**:

- no Kindle, os próximos `AGENDA_MAX_EVENTS` (cabem 6 na tela);
- no `/listas`, os próximos cinco.

`AGENDA_LOOKAHEAD_DAYS` (padrão: 365) só limita a busca no CalDAV; diminuir o
valor esconde eventos em vez de organizar a visualização.

Eventos recorrentes (principalmente aniversários anuais) são expandidos
localmente, porque o CalDAV do Google ignora o pedido `<C:expand>` e devolve o
evento original, com data de 1996. Eles aparecem na próxima ocorrência.

## 4. Compile E Configure O Pacote Do Kindle

Se quiser, coloque a imagem da caixa de foto do painel. O programa só lê PGM
binário de 8 bits, então converta a sua foto:

```sh
magick foto.jpg -colorspace Gray -resize 512x512^ -gravity center \
  -extent 512x512 -depth 8 kindle/kual/kindle-dashboard/assets/profile.pgm
```

Essa pasta não entra no Git (a foto é pessoal), e a compilação não depende
dela: sem um `profile.pgm`, a caixa aparece como uma moldura vazia.

Rode a verificação local antes de empacotar:

```sh
npm run native:check
```

Se você tem o Zig instalado, gere um pacote ARM soft-float para o KUAL
(passe `ZIG=/caminho/para/zig` se o `zig` não estiver no seu `PATH`):

```sh
make -C kindle/native extension-zig
```

Se você tem um compilador ARM próprio para Kindle, use:

```sh
make -C kindle/native extension
```

A compilação GNU espera `arm-linux-gnueabi-g++` por padrão. Use
`KINDLE_CXX=/caminho/para/compilador` se o seu tiver outro nome.

O pacote é gravado em:

```text
kindle/native/build/kindle-dashboard-kual.tar.gz
```

### Copie para o Kindle

Conecte o Kindle por USB. Ele aparece como um pendrive, geralmente em:

- **macOS:** `/Volumes/Kindle`
- **Linux:** `/run/media/$USER/Kindle` ou `/media/$USER/Kindle`

A raiz desse drive é o `/mnt/us` do ponto de vista do Kindle, e ela já tem uma
pasta `extensions/` criada na instalação do KUAL.

**Opção A: script de instalação.** O script faz quatro coisas:

- extrai o pacote;
- copia o inicializador;
- cria o `config.sh` a partir das suas variáveis de ambiente;
- baixa os dados do painel, para a primeira execução já ter o que mostrar.

```sh
DASHBOARD_DATA_URL=https://seu-projeto.insforge.app/functions/kindle-dashboard-data \
DASHBOARD_EVENTS_URL=https://seu-projeto.function2.insforge.app/kindle-dashboard-events \
DASHBOARD_TOGGLE_URL=https://seu-projeto.insforge.app/functions/kindle-dashboard-toggle \
DASHBOARD_READ_TOKEN=<read-token> \
DASHBOARD_TOGGLE_TOKEN=<toggle-token> \
DASHBOARD_TITLE="Meu Kindle" \
npm run native:install -- /caminho/para/Kindle
```

Se já existir um `config.sh` no aparelho, ele é mantido como está.

**Opção B: manualmente.** Extraia o pacote no computador e copie a pasta
`kindle-dashboard` resultante para `extensions/` no drive do Kindle:

```sh
tar -C /caminho/para/Kindle/extensions -xzf kindle/native/build/kindle-dashboard-kual.tar.gz
cp /caminho/para/Kindle/extensions/kindle-dashboard/config.sh.example \
   /caminho/para/Kindle/extensions/kindle-dashboard/config.sh
```

Depois edite `extensions/kindle-dashboard/config.sh`. Ele deve ficar assim:

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

`INTERVAL` define de quantos em quantos segundos o Kindle busca novidades
(180 = 3 minutos). **Quanto menor o número, mais bateria o Kindle gasta.**
Com o padrão, uma mudança feita no Telegram aparece em até 3 minutos.

`DASHBOARD_LIVE_UPDATES="1"` faz as mudanças aparecerem em segundos, mas
mantém o Kindle conectado o tempo todo e gasta bem mais bateria; é mais
indicado para quem deixa o Kindle na tomada. A tabela completa está em
[Bateria e frequência de atualização](CONFIGURACAO.md#bateria-e-frequência-de-atualização).

Pegue os tokens no InsForge e cole no `config.sh`:

```sh
npx @insforge/cli secrets get DASHBOARD_READ_TOKEN --json
npx @insforge/cli secrets get DASHBOARD_TOGGLE_TOKEN --json
```

Se for usar a atualização instantânea, use o endereço direto
`function2.insforge.app` na URL de eventos. O gateway normal `/functions/...`
do InsForge pode segurar as respostas SSE.

Ejete o Kindle com segurança antes de desconectar o cabo.

## 5. Inicie No Kindle

No Kindle, abra o KUAL. Teste primeiro **Atualizar uma vez (claro)**: se o
painel aparecer, toda a cadeia está funcionando. Depois use **Iniciar painel**
para deixá-lo rodando.

- `Painel Kindle -> Atualizar uma vez (claro)`: busca e desenha uma
  atualização.
- `Painel Kindle -> Atualizar uma vez (escuro)`: o mesmo, em branco sobre
  preto.
- `Painel Kindle -> Iniciar painel (claro)`: inicia o ciclo de atualização
  contínua.
- `Painel Kindle -> Iniciar painel (escuro)`: o mesmo, em branco sobre preto.
- `Painel Kindle -> Parar painel`: encerra o processo.

As opções "(escuro)" invertem o painel inteiro: fundo preto, texto e molduras
brancos, e a caixa de foto continua aparecendo como foto. É um tema do próprio
painel e funciona seja qual for o tema do sistema do Kindle. Coloque
`DARK_MODE="1"` no `config.sh` para usá-lo sempre; as opções do menu têm
prioridade na execução que iniciam.

Dois cuidados antes de deixá-lo ligado:

- O Kindle desenha a própria barra de status nos 66 px do topo, e o painel
  não pinta por cima dela de propósito, então uma faixa clara fica ali.
- Uma tela quase toda preta deixa mais "fantasmas" no e-ink do que uma quase
  toda branca.

Arquivos úteis no Kindle:

```text
/mnt/us/documents/kindle-dashboard-native.log
/mnt/us/documents/kindle-dashboard-diagnose.log
/mnt/us/documents/kindle-dashboard-data.json
```

O programa usa um perfil "sempre ligado":

- busca novidades a cada `INTERVAL` segundos (3 minutos por padrão);
- atualização instantânea por SSE só se você ligar `DASHBOARD_LIVE_UPDATES`;
- atualização manual pelo KUAL quando você quiser;
- nenhum modo noturno silencioso, por padrão.

Para iniciar o painel junto com o Kindle, veja o `kindle/README.md`.

## Atualizando Depois

Quando baixar uma versão nova:

```sh
git pull
npm install
npm run kit:backend -- --skip-secrets
make -C kindle/native extension-zig
```

Depois substitua os arquivos da extensão instalada no Kindle, mantendo o seu
`config.sh`.

## Solução De Problemas

Comece testando o backend pelo computador. O comando deve mostrar um JSON com
`"ok": true`:

```sh
curl -sS -H "X-Dashboard-Read-Token: <read-token>" \
  https://seu-projeto.insforge.app/functions/kindle-dashboard-data
```

| Sintoma | O que verificar |
| --- | --- |
| O KUAL não mostra "Painel Kindle" | A pasta deve ser `extensions/kindle-dashboard/`, com o `config.xml` direto dentro dela, e não uma pasta a mais para dentro. |
| A tela não muda depois de "Atualizar uma vez" | Abra `documents/kindle-dashboard-native.log` no drive do Kindle. `missing DASHBOARD_DATA_URL` significa que o `config.sh` não existe ou está incompleto; `missing native app` significa que o pacote não foi copiado inteiro. |
| `OFFLINE` embaixo do cabeçalho | O Kindle está sem rede. Verifique o Wi-Fi dele. |
| `401` no `curl` acima | O `DASHBOARD_READ_TOKEN` não bate com o segredo do backend. |
| Clima ou agenda "indisponível" | A resposta tem `"available": false` naquele módulo: confira os segredos `WEATHER_*` ou `CALDAV_*`. O resto do painel continua funcionando. |
| Horários dos eventos errados por algumas horas | Se você não está no horário de Brasília, configure `DASHBOARD_TIMEZONE` no backend (e no `config.sh`, se o relógio do próprio Kindle estiver errado). |
| O bot não responde | Rode `npm run telegram:configure` de novo. O bot fica em silêncio para qualquer chat que não seja o `TELEGRAM_ALLOWED_CHAT_ID`, então confira o ID do chat. |
| O bot diz que a cota acabou | O limite diário do plano gratuito da IA foi atingido. Os botões do menu continuam funcionando, e a cota renova no dia seguinte. |
| As mudanças demoram minutos para aparecer | É o normal: elas aparecem em até `INTERVAL` segundos (3 minutos por padrão). Diminua o `INTERVAL` ou ligue `DASHBOARD_LIVE_UPDATES="1"`, sabendo que ambos gastam mais bateria. Com a atualização instantânea ligada, a `DASHBOARD_EVENTS_URL` precisa usar o endereço `function2.insforge.app`. |
| Tocar nos itens não faz nada | Confira `DASHBOARD_TOGGLE_URL` e `DASHBOARD_TOGGLE_TOKEN` no `config.sh`. |
| Travou no deploy? | O `npm run kit:backend` às vezes termina o trabalho e não devolve o terminal. Se nada aparecer por um ou dois minutos, aperte `Ctrl+C` e confira com `npx @insforge/cli functions code telegram-webhook` se a função foi publicada. |

Os logs do Kindle ficam em inglês. Se você tiver acesso SSH ao Kindle, o
`extensions/kindle-dashboard/bin/diagnose.sh` faz uma busca e um desenho
completos e grava um relatório detalhado em
`documents/kindle-dashboard-diagnose.log`.

## Privacidade

- Não compartilhe `INSFORGE_API_KEY`, o token do bot do Telegram, o segredo
  do webhook, a `LLM_API_KEY` nem a senha do seu CalDAV.
- Trate `DASHBOARD_READ_TOKEN` e `DASHBOARD_TOGGLE_TOKEN` como segredos do
  aparelho. O token de leitura dá acesso aos dados do painel, e o de toggle
  pode mudar o estado dos itens.
- O Kindle lê os dados do painel pelas URLs das suas funções publicadas,
  usando o token de leitura.
- Com `LLM_API_KEY` configurada, as mensagens do Telegram que o interpretador
  de regras não entende são enviadas a esse provedor de IA (por padrão, a API
  do Gemini, do Google, um serviço de terceiros). Não ative se não quiser que
  o texto das suas mensagens saia do seu projeto InsForge; o menu de botões
  cobre as três listas sem IA.
- O bot do Telegram responde a exatamente um chat e ignora todos os outros,
  então ter um nome de usuário público não é uma exposição. Veja "Quem pode
  usar o seu bot", acima.
- Este kit foi feito para um único dono. Um serviço hospedado para vários
  usuários precisaria separar cada tabela e função por usuário e parear os
  aparelhos.
