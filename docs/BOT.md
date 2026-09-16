# O Bot Do Telegram

Referência completa do `functions/telegram-webhook.ts`: quem pode usar o bot,
tudo o que ele entende, tudo o que ele pode responder e como operá-lo.

Para a primeira instalação, veja o [INSTALACAO.md](INSTALACAO.md). Este
documento parte do princípio de que o bot já está conectado.

---

## Quem Pode Usar

**Só você.** O nome de usuário de um bot do Telegram é público e qualquer
pessoa pode abrir uma conversa com ele, mas este responde a exatamente um
chat e ignora todos os outros.

São duas barreiras independentes, ambas nas primeiras 25 linhas do handler:

| Barreira | Verifica | Se falhar |
| --- | --- | --- |
| Segredo do webhook | `x-telegram-bot-api-secret-token` é igual a `TELEGRAM_WEBHOOK_SECRET` | `401 Unauthorized` |
| Chat autorizado | `message.chat.id` (ou `callback_query.message.chat.id`) é igual a `TELEGRAM_ALLOWED_CHAT_ID` | `200 {ok:true, ignored:true, reason:"chat_not_allowed"}` |

As duas barreiras protegem contra coisas diferentes:

- **O segredo** impede que alguém que descobriu a URL da sua função injete
  mensagens falsas. Só o Telegram conhece o segredo, porque você o registrou
  com `setWebhook`.
- **A lista de chats** impede que alguém que descobriu o `@nome` do bot o use.

O que um estranho vê: ele manda uma mensagem, o Telegram a entrega ao webhook,
o webhook a descarta e responde ao *Telegram* (não a ele) que ignorou. **Ele
não recebe resposta nenhuma**: nem erro, nem "não autorizado", só silêncio. O
texto dele nunca é interpretado, nunca vai para a IA e nunca é gravado no
banco.

Toques em botões são verificados separadamente, pelo ID do próprio chat,
porque um `callback_query` é outro tipo de atualização e não traz
`update.message`. Encaminhar uma confirmação sua para outra pessoa não dá a
ela um botão funcionando: o toque dela chega do chat dela e é descartado.

### Compartilhando com a família

A verificação usa o ID do **chat**, não o de quem mandou. Então só existe um
jeito de deixar uma segunda pessoa usar o bot:

- **Um grupo.** Coloque o bot num grupo, descubra o ID do grupo (um número
  negativo) e aponte `TELEGRAM_ALLOWED_CHAT_ID` para ele. Todos no grupo
  podem usar o bot, e todas as confirmações aparecem ali. Normalmente é isso
  que um casal ou uma família quer.
- **Não existe outro jeito.** Não há uma segunda lista de chats autorizados:
  a comparação é uma única igualdade de texto contra um único valor.

Duas coisas a saber antes de usar um grupo:

1. Por padrão, bots em grupos rodam em **modo de privacidade**: só recebem
   mensagens que começam com `/` ou que mencionam o bot, então um texto como
   "comprar leite" nunca chegaria ao webhook. Desative no BotFather:
   `/setprivacy` → escolha o bot → `Disable`.
2. Todos no grupo podem ler e mudar todas as listas, e desfazer o que
   qualquer outra pessoa fez. Não existe separação por pessoa em nenhuma
   parte do banco.

Para mover o bot para outro chat, rode o script de configuração de novo com o
novo ID; ele atualiza o segredo salvo:

```sh
npm run telegram:configure -- \
  --bot-token 123456789:token-do-bot \
  --chat-id -1001234567890 \
  --webhook-url https://seu-projeto.insforge.app/functions/telegram-webhook
```

### Se você acha que o bot foi comprometido

Trocar o token do bot no BotFather (`/revoke`) invalida o token antigo na
hora, mas o registro do webhook vai junto. Rode `npm run telegram:configure`
de novo com o token novo para salvá-lo e registrar o webhook outra vez.

O segredo do webhook é trocado de forma independente: mude
`TELEGRAM_WEBHOOK_SECRET` no InsForge e rode o mesmo script, para que o
Telegram receba o novo valor. Os dois lados são comparados a cada mensagem,
então, enquanto estiverem diferentes, o bot fica em silêncio e toda
atualização é recusada com `401`.

---

## Comandos

| Comando | Também | O que faz |
| --- | --- | --- |
| `/start` | `/menu` | Mostra a mensagem de boas-vindas e fixa o teclado de botões |
| `/ajuda` | `/help` | Mostra a colinha completa de frases em texto livre |
| `/listas` | `/lista`, `/ver`, o botão `👀 Ver listas` | Mostra a agenda e depois as três listas (tarefas, notas, compras) |
| `/exportar [escopo] [formato]` | `/export` | Manda um arquivo `.json` (padrão) ou `.yaml` com os mesmos dados: um escopo (`compras`, `tarefas`, `notas`, `agenda`) ou `tudo` (padrão) |
| `/resumo [fechar]` | | Mostra o resumo do dia em Markdown (veja abaixo). Só prévia, a menos que você escreva `fechar` |
| `/resumo_hora [0-23]` | `/resumohora` | Mostra ou define a hora local em que o resumo automático fecha o dia (padrão: 22) |

Os comandos são reconhecidos pela primeira palavra, sem diferenciar
maiúsculas de minúsculas, então `/Listas@meubot` funciona. Os dois argumentos
do `/exportar` podem vir em qualquer ordem (`/exportar yaml agenda` e
`/exportar agenda yaml` são o mesmo pedido).

O teclado é persistente: fica na conversa até você escondê-lo, e `/menu` o
traz de volta:

```text
📋 Tarefa      📝 Nota
🛒 Compras     📅 Agenda
       👀 Ver listas
```

Tocar numa categoria manda uma pergunta com resposta obrigatória, e a sua
resposta vai para aquela categoria. O bot recupera a categoria pelo próprio
texto da pergunta, então não guarda estado de sessão: uma resposta funciona
mesmo dias depois, ou depois de um novo deploy.

`/listas`, `/exportar`, `/resumo`, `/resumo_hora` e as três categorias de
lista nunca chamam a IA. Só o `📅 Agenda` chama, porque transformar "amanhã às
14h" num horário exato precisa dela.

---

## Resumo Diário

Uma vez por dia, na hora local configurada (`/resumo_hora`, padrão 22h, fuso
de `DASHBOARD_TIMEZONE`), o bot manda uma mensagem em Markdown feita para ser
colada direto num app de notas (Obsidian etc.):

```markdown
# 📆 Resumo do dia — 12/09

Janela: 11/09 22:00 → 12/09 22:00

## ✅ Concluído (2)
- [x] 🛒 Leite
- [x] 📋 Ligar pro dentista

## ➕ Adicionado (3)
- 🛒 Leite
- 🛒 Pão
- 📋 Ligar pro dentista
```

As duas seções respondem a perguntas independentes, não dividem uma lista em
duas: um item adicionado e concluído na mesma janela aparece nas duas (como o
`Leite` acima). Depois que a mensagem é enviada, todos os itens que
apareceram em **Concluído** são apagados das listas. A mensagem vira o
registro permanente, e a tabela só guarda o que ainda está aberto.

Como a execução automática funciona:

- **Disparo:** um cron de hora em hora (`scripts/schedule-daily-digest.mjs`)
  chama o `telegram-webhook` com um cabeçalho `DAILY_DIGEST_TOKEN` próprio.
- **Fuso:** os agendamentos do InsForge não têm fuso horário. Em vez de manter
  uma expressão cron sincronizada com a hora local, o disparo acontece toda
  hora, e a própria função decide se a hora atual (convertida para
  `DASHBOARD_TIMEZONE`) é a configurada.
- **Sem envio duplicado:** saber se o dia já foi fechado é uma reserva
  atômica em `bot_settings` (um `INSERT` contra uma chave primária, não uma
  flag lida e depois gravada). Assim, um disparo que chegue duas vezes na
  mesma hora nunca envia em dobro.
- **Janela:** começa no último fechamento bem-sucedido, e não num "24 horas
  atrás" fixo. Se um disparo falhar (um soluço da plataforma), a janela do
  próximo simplesmente se estende para cobrir o buraco, em vez de perdê-lo em
  silêncio.

O `/resumo` gera o mesmo relatório na hora, cobrindo as últimas 24 horas a
partir de *agora*. Ele serve a qualquer momento e nunca apaga nada nem marca o
dia como fechado, então não rouba nem duplica o fechamento automático.

Escreva `fechar` (`/resumo fechar`) para forçar o fechamento na hora, sem
esperar a hora configurada (por exemplo, quando for dormir mais cedo). Ele usa
a mesma janela "desde o último fechamento" da execução automática e marca o
dia como fechado, para o agendamento não fechar de novo depois.

Toda gravação que muda o `done` de um item também grava o `completed_at`:
pelo Telegram, pelo toque no próprio Kindle (`kindle-dashboard-toggle.ts`) e
pelo desfazer. Esse horário é o único jeito de o resumo saber se um item foi
concluído dentro da janela ou só editado durante ela. O `updated_at` não
serve para isso, porque também muda quando um item troca de lista.

Configuração, uma vez por backend:

1. `npm run kit:backend` aplica a migration e gera o `DAILY_DIGEST_TOKEN`.
2. `npm run digest:schedule -- --base-url <INSFORGE_BASE_URL>` cria o
   agendamento de hora em hora.

---

## O Que Ele Entende

Texto livre, voz ou botão: os três terminam no mesmo despachante de ações. As
listas são reconhecidas por apelidos, com ou sem acento, em português e
inglês:

| Lista | Apelidos |
| --- | --- |
| 🛒 Compras | `compras`, `comprar`, `mercado`, `supermercado`, `feira`, `grocery`, `groceries`, `shopping`, `market` |
| 📋 Tarefas | `tarefa(s)`, `afazeres`, `pendências`, `todo`, `to-do`, `task(s)`, `errand(s)` |
| 📝 Notas | `nota(s)`, `anotação`, `recado`, `note(s)` |

| Intenção | Exemplos |
| --- | --- |
| adicionar | `comprar leite e pão` · `adicionar limpar a mesa nas tarefas` · `anota o código do portão 4417` |
| concluir | `já comprei o leite` · `feito: limpar a mesa` |
| reabrir | `desmarca o leite` |
| apagar | `tira os ovos das compras` · `apaga limpar a mesa das tarefas` |
| limpar | `limpa as tarefas` · `esvazia as compras` |
| editar | `mude o texto do item 3 da lista de compras para leite integral` |
| importante / não importante | `marca a tarefa 6 como importante` · `tira a importância do item 2` |
| agendar | `reunião amanhã às 14h com o time` · `consulta dia 20/09 às 10h` |
| cancelar | `cancela a reunião do time` · `cancela o evento 1` |

Uma mensagem pode ter várias intenções diferentes. Cada uma é aplicada na sua
lista, e um único `↩️ Desfazer` desfaz a mensagem inteira. Vários itens da
mesma intenção são uma ação só: "comprar leite e pão" é uma adição com dois
itens, não duas adições.

Se um pedido de concluir, reabrir ou apagar não citar a lista, o bot procura
nas três e diz em qual encontrou.

### Itens numerados e importância

O `/listas` numera cada item de cada lista (`3. comprar leite`) e cada evento
futuro da agenda (`1. 14:00 — Reunião`). O número é uma posição calculada na
hora, nunca guardada, e recalculada a cada exibição e a cada referência. A
ordem é:

1. itens abertos, com os importantes antes dos demais;
2. itens concluídos por último.

(A regra está em `orderForNumbering`, no `telegram-webhook.ts`.)

**O Kindle mostra os mesmos números e a mesma ordem** (`[ ] !1. PAGAR LUZ`),
então dá para ler o número direto na tela e mandar "exclua o item 2 das
compras". Itens concluídos há mais de 24 h somem do Kindle, mas os números dos
outros não mudam por isso.

Use o número em vez de digitar o texto de novo: `conclua a tarefa 3`,
`exclua o item 2 da lista de compras`, `cancela o evento 1`. Um número sempre
aponta para exatamente um item, então, ao contrário de um trecho de texto,
nunca dispara a pergunta de desambiguação descrita abaixo.

Marcar um item como `importante` (`marca a tarefa 6 como importante`) tem
três efeitos:

- ele passa à frente dos demais do seu grupo (abertos ou concluídos);
- o número dele ganha um `!` no `/listas` (`!6. cortar cabelo`);
- o `/exportar` leva o campo `important` em cada item.

"Não importante" remove a marcação. As duas ações aceitam número ou texto,
como concluir e apagar, e as duas podem ser desfeitas. Não dá para marcar a
importância no mesmo gesto de adicionar: marque depois, na mesma mensagem ou
numa seguinte.

**Mensagens de voz:**

- **Como usar:** segure para gravar e fale.
- **Custo:** a transcrição e a interpretação acontecem numa única chamada à
  IA, então um áudio custa a mesma requisição que um texto.
- **Limites:** 5 minutos e 5 MB.
- **Requisito:** uma `LLM_API_KEY` do Gemini. Com outro provedor, o bot avisa
  que o áudio está indisponível, e todo o resto continua funcionando.

---

## O Que Ele Responde

Toda resposta diz qual lista foi mexida e repete o texto do item **como está
salvo**, não como você digitou. Assim, se a busca acertou o item errado, você
vê na hora.

| Resposta | Significa |
| --- | --- |
| `✅ Anotei em 🛒 Compras: leite.` | Adicionado |
| `✅ Concluí em 🛒 Compras: Café.` | Marcado como feito (repare nas maiúsculas como estão salvas) |
| `↩️ Reabri em 📋 Tarefas: regar as plantas.` | Reaberto |
| `🗑 Removi de 🛒 Compras: ovos.` | Apagado |
| `✏️ Editei em 🛒 Compras: leite → leite integral.` | Texto trocado |
| `⭐ Marquei como importante em 📋 Tarefas: cortar cabelo.` | Importância marcada (ou removida) |
| `🤔 Não achei "banana" em 🛒 Compras.` | Nada combinou: **nada foi alterado** |
| `🤔 Não achei "item 5" em 📋 Tarefas.` | Esse número não existe nessa lista agora |
| `📅 Agendado: Reunião com o time` / `amanhã às 14:00 · sala 2` | Evento criado no calendário |
| `🎤 "comprar leite, pão e ovos"` | O que o bot ouviu, antes do que ele fez |
| `🤔 Não entendi.` | A mensagem não virou nenhuma ação; use os botões |
| `🤔 Não peguei a data/hora.` | Entendeu que era agenda, mas não conseguiu resolver o horário |
| `⏳ Meu interpretador de texto livre bateu o limite do dia.` | Cota da IA (HTTP 429); os botões continuam funcionando |
| `⏳ A IA não respondeu agora.` | A IA demorou demais ou deu erro 5xx depois de uma nova tentativa |
| `🎤 Esse áudio é longo demais.` | Mais de 5 min ou 5 MB |
| `⚠️ Não consegui salvar agora.` | Falha ao gravar no banco |
| `⚠️ Não consegui falar com o servidor da agenda.` | CalDAV inacessível ou demorou demais |
| `⚠️ A agenda ainda não está configurada no servidor.` | Faltam os segredos `CALDAV_*` |

A resposta "não achei" é a mais importante. Concluir, reabrir e apagar
encontram o item por um trecho do texto, então o webhook busca as linhas que
combinam *antes* de gravar e informa o que realmente mudou. Um
`UPDATE ... ILIKE` às cegas confirmaria mudanças que nunca aconteceram.

### Desfazer

Toda confirmação que realmente mudou algo vem com um botão `↩️ Desfazer`,
válido por **24 horas** e utilizável **uma vez**. Ele reverte exatamente
aquela mensagem:

- itens apagados voltam com o estado original de feito/não feito;
- o que foi marcado é desmarcado;
- o que foi criado é apagado;
- um evento cancelado é restaurado a partir do ICS original.

Tocar num botão já usado avisa isso, em vez de aplicar duas vezes. O token é
consumido antes de a operação ser refeita, então um toque duplo ou uma nova
tentativa do Telegram não aplicam em dobro.

### Desambiguação

Se uma palavra combina com mais de um item (por exemplo, "já comprei o pão"
com `pão` e `pão de forma` na lista), **nada é alterado**. O bot mostra as
opções como botões e aplica só a que você tocar. Há também:

- `⚡ Todos`, para quando você queria mesmo pegar todos;
- `✖️ Cancelar`, para desistir.

Uma escolha inválida ou expirada não descarta a pergunta.

O mesmo acontece em dois outros casos:

- **Cancelamento:** quando ele combina com vários eventos.
- **Adição sem lista:** quando o bot precisou adivinhar a lista porque a
  mensagem não citou nenhuma. Aí o item é salvo na hora e o bot oferece
  movê-lo, então nada fica esperando um toque seu.

---

## Como Uma Mensagem Vira Uma Ação

Quatro etapas; a primeira que acertar vence:

1. **Heurística rápida.** Só age quando a mensagem cita *ao mesmo tempo* um
   verbo de ação e uma lista, *e* tem exatamente uma família de verbos. É
   rígida de propósito:
   - adivinhar a lista errada grava no lugar errado;
   - uma mensagem com duas famílias de verbos ("anota o código, adiciona regar
     as plantas e marca os ovos") são vários pedidos, que uma regex juntaria
     num só.

   Não custa nada.
2. **Cache de interpretação.** Um hash FNV-1a do texto normalizado, buscado
   em `bot_parse_cache`, com validade de 30 dias. Resultados de agenda nunca
   entram no cache, porque dependem de "agora" e amanhã devolveriam a data de
   ontem.
3. **IA.** Uma chamada com um JSON schema rígido (`response_format:
   json_schema`, `strict: true`) que devolve uma lista de ações. Tempo
   limite de 12 segundos e uma nova tentativa só em caso de HTTP 503.
4. **Heurística de reserva.** Usada se a IA deu erro ou não devolveu nada
   aproveitável. Num erro de cota, a falha da IA é guardada para a resposta
   explicar o limite, em vez de fingir que a mensagem não fazia sentido.

Sem `LLM_API_KEY`, o bot pula direto da etapa 1 para a 4 e funciona bem com
frases explícitas; só as datas em linguagem natural ("segunda que vem") se
perdem.

A resposta da IA é validada, nunca aceita de olhos fechados. O
`validateTelegramActions` aceita três formatos:

- a lista de ações;
- um objeto solto;
- o formato aninhado que o Gemini às vezes devolve.

Qualquer coisa que não vire uma ação conhecida é descartada.

---

## Limites

| O quê | Valor | Onde |
| --- | --- | --- |
| Validade do botão desfazer | 24 h, uso único | `UNDO_TTL_MS` |
| Validade de uma entrada no cache | 30 dias | `PARSE_CACHE_TTL_MS` |
| Mensagem de voz | 5 min / 5 MB | `MAX_VOICE_SECONDS`, `MAX_VOICE_BYTES` |
| Tempo limite da IA | 12 s | `callLlm` |
| Tempo limite do CalDAV | 8 s | `applyCalendarAction` |
| Eventos da agenda no `/listas` | 5 | `OVERVIEW_MAX_EVENTS` |
| Horizonte da agenda | 365 dias | `AGENDA_LOOKAHEAD_DAYS` |
| `callback_data` do Telegram | 64 bytes (limite do protocolo) | os tokens têm 16 caracteres hex |

O plano gratuito do Gemini conta **requisições por dia, não tokens**. Os
modelos flash completos permitem cerca de 20 por dia; os flash-lite permitem
bem mais, e é por isso que o `LLM_MODEL` padrão é `gemini-3.5-flash-lite`.
Confira os seus números em <https://ai.dev/rate-limit>.

O `LLM_REASONING_EFFORT=low` é o que mantém as respostas perto de 1 s: por
padrão, o Gemini 3.x "pensa" antes de responder, o que custa 9–13 s numa
tarefa tão pequena.

---

## Operação

Duas tabelas são só do bot; o Kindle não lê nenhuma delas:

- **`bot_actions`**: dados pendentes de desfazer e de desambiguação,
  identificados pelo token que vai no `callback_data`. Toda gravação de
  desfazer também apaga as linhas com mais de 24 h (dos dois tipos), então a
  tabela se mantém pequena sozinha, sem tarefa agendada.
- **`bot_parse_cache`**: `message_hash` → ação, com um contador `hits` e
  `last_used_at`. Pode ser esvaziada a qualquer momento; o bot preenche de
  novo.

```sh
# o que está no cache, mais usados primeiro
npx @insforge/cli db query -- \
  "SELECT hits, action, last_used_at FROM bot_parse_cache ORDER BY hits DESC LIMIT 20;"

# esquecer uma interpretação ruim (ou TRUNCATE para todas)
npx @insforge/cli db query -- \
  "DELETE FROM bot_parse_cache WHERE action::text ILIKE '%item errado%';"

# tokens de desfazer/escolha pendentes agora
npx @insforge/cli db query -- \
  "SELECT id, kind, created_at FROM bot_actions ORDER BY created_at DESC;"
```

As duas tabelas têm RLS ativado e só são acessadas pela chave de serviço da
função.

Os logs da função começam com `telegram-webhook` e dizem o tipo de falha,
nunca o conteúdo da mensagem: `llm_http_429`, `llm_network_error`,
`voice_http_400`, `calendar_put_507`, `parse_cache_read_failed`,
`undo_consume_failed`, `prune_failed`. Requisições bem-sucedidas registram uma
linha de tempo com `total_ms`.

### Solução de problemas

| Sintoma | Causa provável |
| --- | --- |
| O bot não responde a nada, nem ao `/start` | Segredo do webhook diferente (toda atualização recebe 401), ou `TELEGRAM_ALLOWED_CHAT_ID` aponta para outro chat. Veja o `last_error_message` em `getWebhookInfo`. |
| Os botões funcionam, mas o texto livre responde `🤔 Não entendi` | `LLM_API_KEY` ausente ou errada; só sobrou a heurística |
| `⏳ bateu o limite do dia` | Cota diária de requisições. Troque o `LLM_MODEL` por um flash-lite ou espere renovar |
| Respostas levam 9–13 s | `LLM_REASONING_EFFORT` não está como `low` |
| O áudio diz que precisa de IA configurada | `LLM_BASE_URL` não aponta para o Gemini e `LLM_AUDIO_BASE_URL` não está definida |
| Os eventos são salvos mas nunca aparecem | `CALDAV_CALENDAR_PATH` aponta para uma coleção diferente da que o painel lê |
| A agenda mostra menos eventos do que existem | `AGENDA_LOOKAHEAD_DAYS` foi reduzido; ele limita a busca, então o que passar dele fica invisível |
| Os horários dos eventos estão errados por um número fixo de horas | Você não está no horário de Brasília: configure `DASHBOARD_TIMEZONE` no backend |
| Um botão fica carregando para sempre | A função deu erro antes do `answerCallbackQuery`; procure essa requisição nos logs |

---

## Notas De Design

- **Um único dono, de propósito.** Um chat, um conjunto de listas, sem
  separação por usuário em nenhuma tabela. Uma versão hospedada para vários
  usuários precisaria de dono por linha e pareamento de aparelhos em todo
  lugar.
- **Os botões nunca precisam da IA.** Toda operação de adicionar ou remover
  funciona sem chamar um modelo, e é isso que faz o fim da cota ser um
  incômodo e não uma pane.
- **Nada é gravado antes de ser resolvido.** As linhas que combinam são
  selecionadas primeiro, gravadas pelo ID depois, e os acertos e erros são
  informados separadamente.
- **As respostas são em português do Brasil**, incluindo todas as mensagens
  de erro. Os textos ficam num bloco `MSG` no topo da função, ao lado de
  `LIST_LABELS`, então mudar os textos do bot significa editar um lugar só.
