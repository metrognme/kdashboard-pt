# Painel Kindle: Lado Do Kindle

O painel é um programa nativo em C++ iniciado pelo KUAL ou pelo upstart. Ele
busca um JSON somente leitura em:

```text
https://seu-projeto.insforge.app/functions/kindle-dashboard-data
```

As URLs publicadas exigem o `DASHBOARD_READ_TOKEN`. O inicializador o envia
no cabeçalho `X-Dashboard-Read-Token`, lendo do `config.sh` local.

## Prévia Sem Kindle

Desenhe os dados de exemplo numa imagem:

```sh
make -C kindle/native local
kindle/native/build/kindle-dashboard-local --render kindle/native/fixtures/dashboard-data.json --save-pgm /tmp/painel.pgm
magick /tmp/painel.pgm /tmp/painel.png
```

Acrescente `--dark`, `--view chores` (ou `grocery`) ou `--title "Qualquer texto"`
para ver as outras variações.

## Compilação

Rode a verificação local no seu computador:

```sh
npm run native:check
```

Compile o programa para o Kindle depois de instalar um compilador ARM
compatível:

```sh
make -C kindle/native kindle
```

O Makefile espera `arm-linux-gnueabi-g++`. Se o seu compilador tiver outro
nome, passe explicitamente:

```sh
make -C kindle/native kindle KINDLE_CXX=/caminho/para/arm-linux-gnueabi-g++
```

Se você não tem esse compilador GNU, o caminho mais fácil é a compilação ARM
soft-float com Zig (`ZIG=` só é necessário quando o `zig` não está no seu
`PATH`):

```sh
make -C kindle/native extension-zig ZIG=/caminho/para/zig
```

Use o `extension-zig` para uma compilação ARM EABI amplamente compatível. Só
use `ZIG_TARGET=arm-linux-gnueabihf ZIG_MCPU=generic+v7a` se o seu aparelho
precisar especificamente de hard-float.

## Instalação No KUAL

Gere o pacote da extensão do KUAL:

```sh
make -C kindle/native extension
```

Ou, pelo caminho com Zig:

```sh
make -C kindle/native extension-zig
```

Extraia `kindle/native/build/kindle-dashboard-kual.tar.gz` na pasta
`extensions/` do Kindle (conectado por USB):

```sh
tar -C /caminho/para/Kindle/extensions -xzf kindle/native/build/kindle-dashboard-kual.tar.gz
```

Ou instale direto com o script, de dentro da pasta vinculada ao InsForge. O
caminho padrão é `/Volumes/Kindle` (macOS), então passe o caminho
explicitamente no Linux:

```sh
npm run native:install -- /caminho/para/Kindle [--title "Meu Kindle"] [--base-url <url>] [--force]
```

Na primeira instalação, o script cria o `config.sh` com as URLs derivadas da
URL do backend e com os tokens lidos dos segredos do InsForge. Variáveis de
ambiente (`DASHBOARD_DATA_URL`, `DASHBOARD_EVENTS_URL`, `DASHBOARD_TOGGLE_URL`,
`DASHBOARD_READ_TOKEN`, `DASHBOARD_TOGGLE_TOKEN`, `DASHBOARD_TITLE`) têm
prioridade. Um `config.sh` que já existe no aparelho nunca é alterado.
`--force` só pula a checagem de que o caminho parece um Kindle.

Opções do menu do KUAL (em **Painel Kindle**):

- `Iniciar painel (claro)`: inicia o painel e-ink sempre ligado.
- `Iniciar painel (escuro)`: o mesmo, em branco sobre preto.
- `Atualizar uma vez (claro)`: acorda a tela temporariamente, liga o Wi-Fi,
  busca os dados e desenha uma atualização.
- `Atualizar uma vez (escuro)`: o mesmo, em branco sobre preto.
- `Parar painel`: encerra o programa e devolve o comportamento normal de
  descanso.

### Modo escuro

As opções "(escuro)" passam `--dark`, que inverte a tela pronta: fundo preto,
texto e molduras brancos. É o tema do próprio programa, sem relação com o
modo escuro do sistema do Kindle, e não depende dessa configuração do
aparelho.

Para usá-lo sempre, coloque `DARK_MODE="1"` no `config.sh`. As opções
"(claro)"/"(escuro)" do menu têm prioridade na execução que iniciam.
`INVERT_IMAGES` é o nome antigo da mesma opção e continua funcionando, então
um `config.sh` escrito antes dessa versão mantém o que já estava configurado.

A caixa de foto é invertida antes da inversão da tela, então continua sendo
uma foto em vez de virar um negativo. Duas coisas a saber antes de deixar o
modo escuro sempre ligado:

- A barra de status do próprio Kindle (os 66 px do topo) é desenhada pelo
  sistema e o programa não escreve nela de propósito, então ela continua
  clara. O modo escuro deixa uma faixa clara ali.
- Uma tela quase toda preta deixa mais "fantasmas" no e-ink do que uma quase
  toda branca. As atualizações completas continuam legíveis, mas restos
  fracos da tela anterior ficam mais visíveis entre elas.

O programa guarda os últimos dados recebidos com sucesso em:

```text
/mnt/us/documents/kindle-dashboard-data.json
```

Sem Wi-Fi, ele desenha os dados guardados, com `OFFLINE` na linha de status.

Os padrões "sempre ligado" podem ser alterados no `config.sh`:

```sh
INTERVAL=180
DASHBOARD_LIVE_UPDATES=0
DASHBOARD_SLEEP_WINDOW=off
DASHBOARD_KEEP_AWAKE=1
DARK_MODE=0
DASHBOARD_TITLE="Painel Kindle"
```

`INTERVAL` é de quantos em quantos segundos o Kindle busca novidades
(padrão 180 = 3 minutos): quanto menor, mais bateria gasta.
`DASHBOARD_LIVE_UPDATES=1` liga a atualização instantânea por SSE, que gasta
bem mais bateria. Veja a tabela em
[docs/CONFIGURACAO.md](../docs/CONFIGURACAO.md#bateria-e-frequência-de-atualização).

Use `DASHBOARD_SLEEP_WINDOW=HH:MM-HH:MM` para pausar as atualizações à noite,
ou `DASHBOARD_KEEP_AWAKE=0` para deixar o Kindle dormir normalmente enquanto o
painel roda.

## Inicializador Manual

Copie o inicializador do repositório para o Kindle:

```sh
cp kindle/launch-dashboard.sh /mnt/us/documents/kindle-dashboard-launch.sh
chmod +x /mnt/us/documents/kindle-dashboard-launch.sh
```

Rode manualmente por SSH para testar:

```sh
/mnt/us/documents/kindle-dashboard-launch.sh
```

Se o programa não existir, o inicializador sai e registra a falha no log do
painel.

## Opcional: Iniciar Junto Com O Kindle

Se você tem acesso SSH/root e o seu Kindle usa jobs do upstart, copie:

```text
kindle/upstart/kindle-dashboard.conf
```

para:

```text
/etc/init/kindle-dashboard.conf
```

Depois ajuste o comando para rodar:

```sh
/mnt/us/documents/kindle-dashboard-launch.sh
```

Na próxima inicialização, o job espera a interface do Kindle, liga o Wi-Fi,
espera um pouco pela rede e inicia o painel.

Se o Kindle travar ou se comportar de forma estranha, remova o arquivo do
upstart:

```sh
stop kindle-dashboard
mntroot rw
rm /etc/init/kindle-dashboard.conf
mntroot ro
```

## Observações

- O suporte ao KUAL varia conforme o modelo e o firmware do Kindle.
- O programa precisa de Wi-Fi para dados novos, mas desenha os dados
  guardados quando está offline.
- O perfil padrão mantém o Kindle acordado, busca novidades a cada 180
  segundos, deixa a atualização instantânea (SSE) desligada e não usa janela
  noturna.
- Manter o Wi-Fi e o processo de atualização ligados gasta mais bateria do
  que um painel estático no estilo protetor de tela.
- Se iniciar junto com o Kindle for agressivo demais, inicie o painel
  manualmente pelo KUAL.
- Os logs do Kindle (`documents/kindle-dashboard-*.log`) ficam em inglês.
