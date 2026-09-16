# Painel Kindle

**Seu Kindle pode fazer muito mais do que ser um leitor de livros.**

Transforme um Kindle desbloqueado (jailbreak) num painel de casa sempre
ligado, com tela e-ink: clima, sua agenda, lista de tarefas, lista de compras
e notas, tudo numa tela só. Você atualiza mandando mensagem para um bot do
Telegram ("comprar leite", "reunião amanhã às 14h" ou até um áudio), e o
Kindle mostra a mudança em poucos minutos. Toque num item no Kindle para marcar como feito.

<p align="center">
  <img src="docs/images/preview-light.png" alt="Painel no tema claro" width="260">
  <img src="docs/images/preview-dark.png" alt="Painel no tema escuro" width="260">
  <img src="docs/images/preview-chores.png" alt="Uma lista aberta em tela cheia" width="260">
</p>

<sub>Imagens geradas a partir de `kindle/native/fixtures/dashboard-data.json`.
A caixa vazia no canto superior esquerdo é a caixa de foto: coloque ali a
imagem que quiser.</sub>

## O que ele faz

- **Clima** da sua cidade (Open-Meteo: gratuito, sem chave de API).
- **Agenda** com seus próximos compromissos de qualquer calendário CalDAV
  (Google, iCloud, Nextcloud, Radicale, Home Assistant...), incluindo eventos
  recorrentes.
- **Três listas**: tarefas, compras e notas. Toque numa caixa para abrir a
  lista em tela cheia e toque num item para marcar como feito.
- **Um bot do Telegram** que edita tudo isso:
  - menu de botões que sempre funciona;
  - texto livre e áudio, se você adicionar uma chave de IA (opcional, com
    plano gratuito);
  - botão de desfazer, resumo diário e exportação.
- **Atualização no seu ritmo**: por padrão, o Kindle busca novidades a cada
  3 minutos. Você escolhe o intervalo, sabendo que quanto mais curto, mais
  bateria gasta. Há também um modo instantâneo (mudanças em segundos), ideal
  para quem deixa o Kindle na tomada.
- **Funciona offline**: os últimos dados ficam salvos e são redesenhados se o
  Wi-Fi cair.
- **Personalização**:
  - temas claro e escuro;
  - bloqueio de tela para levar o Kindle para lá e para cá;
  - título personalizado no cabeçalho;
  - uma caixa para a foto que você quiser.
- **Privado por padrão**: o backend é seu. O bot responde só ao seu chat e
  ignora todo mundo.

## Do que você precisa

| | Obrigatório? | Custo |
| --- | --- | --- |
| Um Kindle que aceite jailbreak, com o [KUAL](https://kindlemodding.org/) instalado | Sim | — |
| Um computador com Node.js 20+ e npm (macOS ou Linux) | Sim | Grátis |
| Uma conta no [InsForge](https://insforge.dev) (banco de dados + funções na nuvem) | Sim | Plano gratuito |
| Um bot do Telegram, criado com o [@BotFather](https://t.me/BotFather) | Sim | Grátis |
| Uma chave de IA, ex.: [Gemini](https://aistudio.google.com/apikey) | Opcional: ativa texto livre e áudio | Plano gratuito |
| Um calendário CalDAV | Opcional: ativa a agenda | Geralmente grátis |
| [Zig](https://ziglang.org/) ou um compilador cruzado ARM | Só para compilar o programa do Kindle | Grátis |

O jailbreak depende do modelo e da versão de firmware do seu Kindle, e é a
única etapa que este projeto não faz por você. Comece por
[kindlemodding.org](https://kindlemodding.org/) e pelo
[fórum MobileRead](https://www.mobileread.com/forums/forumdisplay.php?f=150)
(ambos em inglês) e volte quando o KUAL abrir no seu aparelho.

## Como começar

1. **[Guia de instalação](docs/INSTALACAO.md)**: backend, bot do Telegram,
   compilação do pacote e instalação no Kindle, passo a passo.
2. **[Instalação com um assistente de código](docs/INSTALACAO_COM_ASSISTENTE.md)**:
   os mesmos passos, em forma de prompts para Claude Code, Codex, Cursor e
   ferramentas parecidas.
3. **[Referência de configuração](docs/CONFIGURACAO.md)**: todas as opções,
   no backend e no Kindle.

A versão curta, depois que o seu Kindle já tem KUAL:

```sh
git clone https://github.com/metrognme/kdashboard-pt.git kindle-dashboard && cd kindle-dashboard
npm install
npx @insforge/cli login
npx @insforge/cli create --name kindle-dashboard --region us-east --template empty
npm run kit:backend                              # banco + segredos + funções
npm run telegram:chat-id -- --bot-token <token>  # depois de mandar uma mensagem ao bot
npm run telegram:configure -- --bot-token <token> --chat-id <id> \
  --webhook-url https://<seu-projeto>.insforge.app/functions/telegram-webhook
make -C kindle/native extension-zig              # gera o pacote do KUAL
```

Depois é só copiar o pacote para o Kindle, preencher o `config.sh` e iniciar
pelo KUAL. O [guia de instalação](docs/INSTALACAO.md) explica cada etapa em
detalhe.

## Usando

- **[Referência do bot do Telegram](docs/BOT.md)**: todos os comandos, as
  frases que ele entende e as respostas que ele pode dar.
- **[Referência do lado do Kindle](kindle/README.md)**: menu do KUAL, modo
  escuro, iniciar junto com o Kindle, logs.

## Como funciona

```text
Telegram ──▶ telegram-webhook ──▶ Postgres ──▶ kindle-dashboard-data ──▶ Kindle
                  │                   │                    ▲
                  └──▶ CalDAV         └──▶ kindle-dashboard-events (opcional: SSE "busque de novo")
```

Um pequeno programa em C++ roda no Kindle:

- a cada 3 minutos (configurável), baixa um único JSON do seu backend;
- desenha o painel direto no framebuffer da tela e-ink;
- escuta os toques na tela.

Do outro lado, quatro funções serverless no InsForge:

- entregam esse JSON;
- avisam o Kindle na hora quando algo muda (se o modo instantâneo estiver
  ligado);
- recebem os toques;
- rodam o bot do Telegram.

A **[Arquitetura](docs/ARQUITETURA.md)** explica as peças e as decisões menos
óbvias por trás delas.

## Estrutura do projeto

```text
functions/     Edge functions do InsForge (Deno): dados do painel, eventos ao vivo, toques, bot do Telegram
migrations/    Schema do Postgres
kindle/native/ Programa C++ que desenha a tela + Makefile que gera o pacote do KUAL
kindle/kual/   Extensão do KUAL: menu, scripts de inicialização, config.sh.example
scripts/       Ajudantes de instalação (backend, Telegram, instalação no Kindle)
docs/          Guias e referências
```

## Créditos

Este projeto é baseado no
[thecodedose/kdashboard](https://github.com/thecodedose/kdashboard), que criou
o kit original de painel para Kindle com backend próprio: o programa nativo,
o backend no InsForge e o empacotamento para o KUAL. Esta versão adiciona,
entre outras coisas:

- o layout com clima, agenda e notas;
- o bot do Telegram em português, com interpretação por IA;
- mensagens de voz, desfazer e resumo diário;
- modo escuro, bloqueio de tela e título personalizável;
- toda a interface e a documentação em português.
