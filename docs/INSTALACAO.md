# Guia de Instalação

Este guia leva você de um Kindle desbloqueado até o painel funcionando na
tela, com o bot do Telegram editando as listas. Tudo roda em contas suas: o
seu backend (InsForge), o seu bot e o seu Kindle. Nada aqui se conecta ao
servidor de outra pessoa.

- **Tempo:** cerca de uma hora, sem contar o jailbreak.
- **Nível:** você vai copiar e colar comandos num terminal. Não precisa saber
  programar.
- **Cada etapa termina com um ✅ "Deu certo se…".** Só avance quando ele
  bater. Se não bater, a [Solução de problemas](#solução-de-problemas) está
  organizada pelas mesmas etapas.

Prefere que um assistente de código (Claude Code, Codex, Cursor…) faça junto
com você? Use o [INSTALACAO_COM_ASSISTENTE.md](INSTALACAO_COM_ASSISTENTE.md).

## Visão Geral

| Etapa | Onde | Tempo |
| --- | --- | --- |
| [0. Jailbreak e KUAL](#0-jailbreak-e-kual) | Kindle | varia |
| [1. Prepare o computador](#1-prepare-o-computador) | Computador | 10 min |
| [2. Crie o backend](#2-crie-o-backend) | Computador | 10 min |
| [3. Clima, fuso e extras](#3-clima-fuso-e-extras) | Computador | 5 min |
| [4. Crie o bot do Telegram](#4-crie-o-bot-do-telegram) | Celular e computador | 10 min |
| [5. Instale no Kindle](#5-instale-no-kindle) | Computador e cabo USB | 10 min |
| [6. Ligue o painel](#6-ligue-o-painel) | Kindle | 5 min |
| [7. Primeiro uso](#7-primeiro-uso) | Telegram e Kindle | 5 min |

Você só vai precisar anotar **duas coisas**: o token do bot (etapa 4) e o
número do seu chat (etapa 4). As URLs e os tokens do painel são preenchidos
pelos scripts.

## 0. Jailbreak E KUAL

O painel roda como uma extensão do KUAL (Kindle Unified Application
Launcher), então o Kindle precisa de jailbreak e do KUAL. O método depende do
modelo e da versão do firmware e muda com o tempo, então siga as instruções
atualizadas para o seu aparelho:

- [kindlemodding.org](https://kindlemodding.org/): guias de jailbreak e KUAL
  (em inglês).
- [MobileRead Kindle Developer's Corner](https://www.mobileread.com/forums/forumdisplay.php?f=150):
  a comunidade por trás da maioria das ferramentas para Kindle (em inglês).

Se o guia que você seguir recomendar, desative as atualizações automáticas de
firmware: uma atualização pode remover o jailbreak. Deixe também o **Wi-Fi do
Kindle configurado**, porque o painel busca os dados pela internet.

✅ **Deu certo se** aparece um item **KUAL** na biblioteca do Kindle e ele abre
um menu.

## 1. Prepare O Computador

Os comandos deste guia são para **macOS ou Linux**. No Windows, o caminho mais
próximo é o WSL (Ubuntu), mas este guia não foi testado nele.

Instale o que falta:

| Programa | Para quê | Como instalar |
| --- | --- | --- |
| Node.js 20 ou mais novo | Rodar os scripts de instalação | [nodejs.org](https://nodejs.org/pt) (versão LTS) |
| git, make, curl e tar | Baixar e compilar | macOS: `xcode-select --install`. Linux: já vêm na maioria das distribuições (Ubuntu/Debian: `sudo apt install git make curl`) |
| Zig | Compilar o programa do Kindle | macOS: `brew install zig`. Linux: pelo gerenciador de pacotes da distribuição, ou baixe em [ziglang.org/download](https://ziglang.org/download/) |

Abra um terminal e baixe o projeto:

```sh
git clone https://github.com/metrognme/kdashboard-pt.git kindle-dashboard
cd kindle-dashboard
npm install
```

**Rode todos os comandos seguintes dentro dessa pasta `kindle-dashboard`.** Se
fechar o terminal, volte para ela com `cd kindle-dashboard` antes de continuar.

✅ **Deu certo se** `node -v` mostra `v20` ou mais, `zig version` mostra uma
versão e o `npm install` terminou sem `ERR!`.

## 2. Crie O Backend

O backend é onde ficam as listas e o bot. Ele roda no
[InsForge](https://insforge.dev), e o plano gratuito basta.

Entre na sua conta (o navegador abre para você confirmar):

```sh
npx @insforge/cli login
```

Crie um projeto novo. `us-east` é a região mais próxima do Brasil entre as
disponíveis:

```sh
npx @insforge/cli create --name kindle-dashboard --region us-east --template empty
```

<details>
<summary>Já tenho um projeto vazio no InsForge e quero usar ele</summary>

Descubra o ID dele e vincule esta pasta:

```sh
npx @insforge/cli list
npx @insforge/cli link --project-id <id-do-projeto>
```

Use um projeto **vazio**: o kit cria as próprias tabelas.

</details>

Agora prepare tudo de uma vez:

```sh
npm run kit:backend
```

Esse comando:

- cria as tabelas do banco;
- configura a URL e a chave do backend (lidas do projeto que você acabou de
  criar);
- gera os tokens que o Kindle e o bot usam;
- publica as quatro funções do painel.

Ele leva alguns minutos. Se o terminal ficar parado por mais de dois minutos
sem mostrar nada, veja [Travou no deploy?](#travou-no-deploy).

✅ **Deu certo se** o comando termina com `Backend pronto.` e mostra a URL do
seu backend (algo como `https://abc123.us-east.insforge.app`).

## 3. Clima, Fuso E Extras

### Clima (recomendado)

O clima vem do [Open-Meteo](https://open-meteo.com): gratuito e sem cadastro.
Ele só precisa da sua localização em graus decimais. No
[Google Maps](https://maps.google.com), clique com o botão direito no mapa, e
o primeiro item do menu mostra a latitude e a longitude (clique para copiar).

```sh
npx @insforge/cli secrets add WEATHER_LAT -23.5505
npx @insforge/cli secrets add WEATHER_LON -46.6333
```

Troque os números pelos seus. O primeiro é a latitude, o segundo, a longitude;
os dois costumam ser negativos no Brasil.

### Fuso horário (só fora do horário de Brasília)

O padrão é `America/Sao_Paulo`. Se você estiver em outro fuso, configure o
[nome IANA](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
dele (ex.: `America/Manaus`, `America/Cuiaba`, `America/Rio_Branco`,
`America/Noronha`):

```sh
npx @insforge/cli secrets add DASHBOARD_TIMEZONE America/Manaus
```

### Extras opcionais

Dá para pular os dois e voltar aqui depois: o resto funciona sem eles.

<details>
<summary><b>IA: mensagens em texto livre e áudio</b></summary>

Sem IA, o bot funciona pelo menu de botões e entende comandos simples ("comprar
leite", "já comprei o leite"). Com IA, você escreve como quiser, manda áudios e
agenda eventos com datas como "amanhã às 14h".

Gere uma chave gratuita do Gemini no
[Google AI Studio](https://aistudio.google.com/apikey) e configure:

```sh
npx @insforge/cli secrets add LLM_API_KEY sua-chave-do-gemini
```

Os outros valores já têm padrões bons. Só mexa se souber por quê:

- **`LLM_MODEL`** (padrão `gemini-3.5-flash-lite`) é uma decisão de cota. No
  plano gratuito, os modelos flash completos permitem só cerca de 20
  requisições por dia; o flash-lite permite bem mais. Veja os seus limites em
  [ai.dev/rate-limit](https://ai.dev/rate-limit).
- **`LLM_REASONING_EFFORT`** (padrão `low`) deixa as respostas em cerca de
  1 segundo, em vez de 9 a 13.
- **`LLM_BASE_URL`** permite usar outro provedor compatível com OpenAI. Nesse
  caso, os áudios ficam indisponíveis (eles precisam do Gemini).

Quando a cota do dia acaba, o bot avisa e os botões continuam funcionando.

**Privacidade:** com a IA ligada, as mensagens que o bot não entende sozinho
vão para o provedor da IA (o Google, no padrão).

</details>

<details>
<summary><b>Agenda (calendário CalDAV)</b></summary>

A agenda mostra os seus próximos compromissos e deixa o bot criar e cancelar
eventos. Ela funciona com qualquer calendário que ofereça CalDAV (Nextcloud,
iCloud, Radicale, Home Assistant, entre outros). Na documentação do seu
provedor, procure o endereço CalDAV e, se houver, crie uma **senha de app**
em vez de usar a sua senha principal.

```sh
npx @insforge/cli secrets add CALDAV_BASE_URL https://seu-servidor-caldav
npx @insforge/cli secrets add CALDAV_CALENDAR_PATH /calendars/usuario/pessoal/
npx @insforge/cli secrets add CALDAV_USERNAME seu-usuario
npx @insforge/cli secrets add CALDAV_PASSWORD sua-senha-de-app
```

Configure os quatro, ou nenhum. O caminho do calendário termina com `/`.

</details>

### Teste o backend

```sh
npm run backend:check
```

✅ **Deu certo se** aparece `OK   Backend respondendo` e `OK   Clima: ...`. A
agenda aparece como indisponível se você não a configurou, o que é normal.

## 4. Crie O Bot Do Telegram

1. No Telegram, abra o [@BotFather](https://t.me/BotFather), mande `/newbot`
   e escolha um nome e um usuário para o bot. O BotFather responde com um
   **token** parecido com `123456789:AAH...`. **Anote.** Ele é a senha do seu
   bot: não mostre para ninguém.
2. Abra a conversa com o seu bot novo (o BotFather manda o link), toque em
   **Iniciar** e mande qualquer mensagem, como "oi". Ele ainda não vai
   responder; isso é esperado.
3. No computador, descubra o número do seu chat:

   ```sh
   npm run telegram:chat-id -- --bot-token 123456789:AAH...
   ```

   Procure a linha com o seu nome e **anote o número** depois de `chat_id=`.

4. Ligue o bot ao seu backend, usando o token e o número:

   ```sh
   npm run telegram:configure -- --bot-token 123456789:AAH... --chat-id 123456789
   ```

5. Ative o resumo diário (uma mensagem por noite com o que foi feito):

   ```sh
   npm run digest:schedule
   ```

O bot só obedece o chat que você configurou e ignora qualquer outra pessoa.
Para usá-lo em família, veja
[Compartilhando com a família](BOT.md#compartilhando-com-a-família).

✅ **Deu certo se** você manda `/start` para o bot e ele responde com um
teclado de botões (📋 Tarefa, 📝 Nota, 🛒 Compras, 📅 Agenda). Mande
`comprar leite`: ele deve confirmar que anotou em 🛒 Compras.

## 5. Instale No Kindle

### Compile o pacote

```sh
make -C kindle/native extension-zig
```

✅ **Deu certo se** a última linha é
`Packaged build/kindle-dashboard-kual.tar.gz`.

<details>
<summary>Quero uma foto na caixa do canto superior esquerdo</summary>

Antes de compilar, converta a foto para o formato que o Kindle lê (requer o
[ImageMagick](https://imagemagick.org)):

```sh
magick foto.jpg -colorspace Gray -resize 512x512^ -gravity center \
  -extent 512x512 -depth 8 kindle/kual/kindle-dashboard/assets/profile.pgm
```

Depois rode o `make` acima de novo. A foto nunca vai para o Git. Sem foto, a
caixa aparece como uma moldura vazia.

</details>

<details>
<summary>Não consigo usar o Zig</summary>

Com um compilador cruzado ARM próprio para Kindle, use
`make -C kindle/native extension`. Ele espera `arm-linux-gnueabi-g++`; se o
seu tiver outro nome, acrescente `KINDLE_CXX=/caminho/para/o/compilador`. Se o
`zig` estiver instalado fora do `PATH`, acrescente `ZIG=/caminho/para/zig` ao
comando com Zig.

</details>

### Copie para o Kindle

Conecte o Kindle ao computador pelo cabo USB. Ele aparece como um pendrive
chamado **Kindle**. O caminho dele costuma ser:

- **macOS:** `/Volumes/Kindle`
- **Linux:** `/run/media/SEU-USUARIO/Kindle` ou `/media/SEU-USUARIO/Kindle`
  (no gerenciador de arquivos, abra o Kindle e copie o caminho da barra de
  endereço)

Instale, trocando o caminho pelo seu e o título pelo que quiser ver no
cabeçalho das listas:

```sh
npm run native:install -- /Volumes/Kindle --title "Casa da Ana"
```

O script copia a extensão, cria o arquivo de configuração do Kindle (o
`config.sh`) com as URLs e os tokens do seu backend, e já baixa os dados atuais
para a primeira tela. Se você rodar de novo mais tarde, o `config.sh` que já
está no Kindle é mantido.

Depois, **ejete o Kindle** pelo Finder ou pelo gerenciador de arquivos e
desconecte o cabo.

✅ **Deu certo se** o script termina com `Extensao do Painel Kindle
instalada` e não mostra `Nao foi possivel baixar os dados iniciais`.

<details>
<summary>Prefiro copiar os arquivos à mão</summary>

```sh
tar -C /Volumes/Kindle/extensions -xzf kindle/native/build/kindle-dashboard-kual.tar.gz
cp /Volumes/Kindle/extensions/kindle-dashboard/config.sh.example \
   /Volumes/Kindle/extensions/kindle-dashboard/config.sh
```

Abra `extensions/kindle-dashboard/config.sh` num editor de texto e preencha:

- `DASHBOARD_DATA_URL`: a URL do seu backend + `/functions/kindle-dashboard-data`;
- `DASHBOARD_TOGGLE_URL`: a URL do seu backend + `/functions/kindle-dashboard-toggle`;
- `DASHBOARD_READ_TOKEN` e `DASHBOARD_TOGGLE_TOKEN`: o campo `value` de

  ```sh
  npx @insforge/cli secrets get DASHBOARD_READ_TOKEN --json
  npx @insforge/cli secrets get DASHBOARD_TOGGLE_TOKEN --json
  ```

Mantenha as aspas duplas em volta de cada valor.

</details>

## 6. Ligue O Painel

1. No Kindle, abra o **KUAL** e toque em **Painel Kindle**.
2. Toque em **Atualizar uma vez (claro)**. O Kindle liga o Wi-Fi, busca os
   dados e desenha o painel.
3. Se o painel apareceu, volte ao KUAL e toque em **Iniciar painel (claro)**
   para deixá-lo sempre ligado.

✅ **Deu certo se** a tela mostra o clima, as caixas de Tarefas, Compras e
Notas (com o `LEITE` da etapa 4) e a agenda. Embaixo do clima aparece a data e
`AO VIVO`.

O que cada parte da tela faz:

- **Caixa de uma lista:** toque para abrir a lista em tela cheia.
- **Item de uma lista aberta:** toque para marcar ou desmarcar como feito.
  `VOLTAR` e `INICIO` levam de volta à tela principal.
- **Cadeado:** bloqueia a tela para você poder carregar o Kindle sem apertar
  nada sem querer. **Para desbloquear, aperte o botão liga/desliga do
  Kindle**; nenhum toque na tela desbloqueia.
- **`SAIR`:** fecha o painel e volta para a tela inicial do Kindle.

Opções do menu **Painel Kindle** no KUAL:

| Opção | O que faz |
| --- | --- |
| Iniciar painel (claro) | Deixa o painel sempre ligado, atualizando sozinho |
| Iniciar painel (escuro) | O mesmo, em branco sobre preto |
| Atualizar uma vez (claro/escuro) | Busca e desenha uma vez só; bom para testar |
| Parar painel | Encerra o painel e devolve o descanso normal do Kindle |

Por padrão, o Kindle busca novidades **a cada 3 minutos**. Uma mudança feita
no Telegram leva até esse tempo para aparecer; tocar num item no próprio
Kindle muda a tela na hora. Dá para trocar esse intervalo, ligar a atualização
instantânea, pausar à noite ou deixar o modo escuro fixo; veja
[Personalizando](#personalizando).

## 7. Primeiro Uso

Mande algumas mensagens para o bot e acompanhe a tela:

```text
comprar leite e ovos
adicionar regar as plantas nas tarefas
anota a senha do wifi
```

Os itens aparecem **numerados**, com os mesmos números que o bot mostra em
`/listas`. Use o número para mexer num item sem digitar o texto:

```text
conclua a tarefa 1
exclua o item 2 das compras
marca a tarefa 1 como importante
```

Itens importantes sobem para o topo e ganham um `!`:

```text
[ ] !1. REGAR AS PLANTAS
[ ] 2. PAGAR LUZ
```

Mais coisas para experimentar:

- `/menu` mostra os botões; `/listas` mostra tudo; `/ajuda` mostra as frases
  que o bot entende.
- Toda confirmação tem um botão `↩️ Desfazer`.
- Com a IA ligada: `reunião amanhã às 14h com o time` (com a agenda
  configurada) e mensagens de voz.

A lista completa de comandos, frases e respostas está no [BOT.md](BOT.md).

## Personalizando

As configurações do Kindle ficam no arquivo
`extensions/kindle-dashboard/config.sh`, no próprio Kindle. Para mudar:

1. no KUAL, toque em **Parar painel**;
2. conecte o Kindle ao computador e abra o `config.sh` num editor de texto;
3. mude o valor, mantendo as aspas, salve e ejete o Kindle;
4. no KUAL, toque em **Iniciar painel**.

As mais usadas:

| Configuração | Padrão | O que faz |
| --- | --- | --- |
| `INTERVAL` | `"180"` | De quantos em quantos segundos o Kindle busca novidades. **Menor = mais rápido, mas gasta mais bateria.** |
| `DASHBOARD_LIVE_UPDATES` | `"0"` | `"1"` mostra as mudanças em segundos, mas a bateria dura bem menos. Ideal com o Kindle na tomada. |
| `DASHBOARD_SLEEP_WINDOW` | `"off"` | `"23:00-07:00"` pausa as atualizações à noite. |
| `DARK_MODE` | `"0"` | `"1"` deixa o modo escuro fixo. |
| `DASHBOARD_TITLE` | `"Painel Kindle"` (ou o seu `--title`) | O texto do cabeçalho das listas. |

A referência completa, com a tabela de bateria, está no
[CONFIGURACAO.md](CONFIGURACAO.md). Para o painel iniciar sozinho quando o
Kindle liga, veja o [kindle/README.md](../kindle/README.md#opcional-iniciar-junto-com-o-kindle).

Sobre o modo escuro: a barra de status do próprio Kindle, no topo, continua
clara, e uma tela quase toda preta deixa mais "fantasmas" no e-ink.

## Atualizando Para Uma Versão Nova

Dentro da pasta `kindle-dashboard`:

```sh
git pull
npm install
npm run kit:backend -- --skip-secrets
make -C kindle/native extension-zig
```

No Kindle, toque em **Parar painel**, conecte o cabo e reinstale (o seu
`config.sh` é mantido):

```sh
npm run native:install -- /Volumes/Kindle
```

Ejete, abra o KUAL e toque em **Iniciar painel**.

## Solução De Problemas

Na dúvida, comece por aqui. Ele diz o que está faltando no backend:

```sh
npm run backend:check
```

### Etapas 1 e 2 (computador e backend)

| Sintoma | O que fazer |
| --- | --- |
| `command not found: npm` ou `node` | Instale o Node.js (etapa 1) e abra um terminal novo. |
| `command not found: zig` / `Missing Zig compiler` | Instale o Zig (etapa 1), ou passe `ZIG=/caminho/para/zig` no `make`. |
| O InsForge pede login de novo | Rode `npx @insforge/cli login`. |
| Erro dizendo que não há projeto vinculado | Você não está na pasta `kindle-dashboard`, ou pulou o `create`. Entre na pasta com `cd` e rode de novo. |

#### Travou no deploy?

O `npm run kit:backend` às vezes termina o trabalho mas não devolve o
terminal. Se nada aparecer por mais de dois minutos:

1. aperte `Ctrl+C`;
2. rode `npm run backend:check`. Se ele responder, as funções foram
   publicadas e está tudo certo.
3. Se não responder, rode `npm run kit:backend` de novo: ele não duplica nada.

### Etapa 3 (backend:check)

| Mensagem | O que fazer |
| --- | --- |
| `Funcao nao encontrada (404)` | As funções não foram publicadas: rode `npm run kit:backend`. |
| `recusou o token (401)` | Rode `npm run kit:backend` de novo e, se já instalou no Kindle, confira o `DASHBOARD_READ_TOKEN` do `config.sh`. |
| `Missing INSFORGE_BASE_URL` ou `Missing INSFORGE_API_KEY` | Rode `npm run kit:backend` de novo. Se o aviso continuar, configure as duas à mão (veja [CONFIGURACAO.md](CONFIGURACAO.md#obrigatórios)). |
| `Clima indisponivel` | Configure `WEATHER_LAT` e `WEATHER_LON` (etapa 3). Confira se os números têm ponto, não vírgula. |
| `Agenda indisponivel` com a agenda configurada | Confira os quatro segredos `CALDAV_*` e a senha de app. O servidor precisa ser acessível pela internet. |

### Etapa 4 (Telegram)

| Sintoma | O que fazer |
| --- | --- |
| `Nenhuma mensagem ainda` | Mande uma mensagem para o seu bot no Telegram e rode o comando de novo. |
| `Token do bot invalido` | Copie o token do BotFather de novo, inteiro, com a parte antes dos `:`. |
| `webhook ativo` no `telegram:chat-id` | O bot já foi ligado ao backend. Se ele responde ao `/start`, está tudo certo. |
| O bot não responde | Rode o `telegram:configure` de novo e confira o número do chat: o bot fica em silêncio para qualquer outro chat. |
| O bot diz que a cota acabou | O limite diário da IA gratuita acabou. Os botões continuam funcionando, e a cota renova no dia seguinte. |

### Etapas 5 e 6 (Kindle)

| Sintoma | O que fazer |
| --- | --- |
| `nao parece ser um Kindle conectado` | O caminho está errado. Confira onde o Kindle aparece no computador (etapa 5). |
| `Pacote nao encontrado` | Rode o `make -C kindle/native extension-zig` antes. |
| O KUAL não mostra "Painel Kindle" | A pasta deve ser `extensions/kindle-dashboard/`, com o `config.xml` direto dentro dela. Reinstale com o script. |
| A tela não muda depois de "Atualizar uma vez" | Abra `documents/kindle-dashboard-native.log` no Kindle conectado. `missing DASHBOARD_DATA_URL` significa que falta o `config.sh`; `missing native app` significa que o pacote não foi copiado inteiro. |
| `OFFLINE` embaixo do clima | O Kindle está sem internet. Confira o Wi-Fi dele. O painel continua mostrando os últimos dados. |
| Horários dos eventos errados por algumas horas | Configure `DASHBOARD_TIMEZONE` no backend (etapa 3). Se o relógio do próprio Kindle estiver errado, defina também no `config.sh`. |
| As mudanças do Telegram demoram | É o normal: até `INTERVAL` segundos (3 minutos por padrão). Veja [Personalizando](#personalizando). |
| Os números sumiram da lista | Acontece logo depois de você tocar num item: eles voltam na próxima atualização. |
| Tocar nos itens não faz nada | A tela pode estar bloqueada (cadeado fechado): aperte o botão liga/desliga. Se não, confira `DASHBOARD_TOGGLE_URL` e `DASHBOARD_TOGGLE_TOKEN` no `config.sh`. |
| Quero voltar ao Kindle normal | Toque em `SAIR` na tela, ou em **Parar painel** no KUAL. |

Os logs do Kindle (`documents/kindle-dashboard-*.log`) ficam em inglês. Com
acesso SSH ao Kindle, o `extensions/kindle-dashboard/bin/diagnose.sh` grava um
relatório completo em `documents/kindle-dashboard-diagnose.log`.

## Privacidade

- Nunca compartilhe o token do bot, a `LLM_API_KEY`, a senha do CalDAV nem a
  pasta `.insforge/` (ela guarda a chave do seu backend).
- O `config.sh` do Kindle tem dois tokens: o de leitura dá acesso às suas
  listas, e o de toggle pode marcar itens. Não publique esse arquivo.
- O bot responde a um único chat e ignora todos os outros, então ter um
  usuário público no Telegram não expõe nada. Veja
  [Quem pode usar](BOT.md#quem-pode-usar).
- Com a IA ligada, as mensagens que o bot não entende sozinho são enviadas ao
  provedor da IA (o Google, no padrão). Sem IA, nada sai do seu projeto
  InsForge; o menu de botões cobre as três listas.
- Este kit foi feito para um único dono. Um serviço para várias pessoas
  precisaria separar os dados de cada uma.
