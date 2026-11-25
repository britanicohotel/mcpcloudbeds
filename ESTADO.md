# ESTADO — cloudbeds-mcp

Atualizado no mesmo commit de cada fase.

## Regras de trabalho

- Uma fase por vez. Ao fim de cada uma: `npm run check` verde, commit, push e
  parada para relatório (o que foi feito, o que foi verificado de verdade, o que
  ficou como suposição). A fase seguinte só começa com o ok do dono.
- Documentação da Cloudbeds é a fonte; a resposta real é o juiz. Toda suposição
  sobre formato, campo, paginação ou escopo entra na tabela do fim deste
  arquivo, com arquivo e linha. Fixture de teste que encarna suposição leva
  `// SUPOSIÇÃO: ver ESTADO.md`. Divergência na Fase 5: parar e reportar.
- Teste por sabotagem: guardar o estado bom com uma cópia dentro do repositório
  ou com `git stash`, e restaurar dela. Nunca `git checkout` sobre trabalho não
  commitado.

## Onde parou

**Fase 5 antecipada, antes da Fase 1: verificação e correções feitas em
24/11/2026.** O resultado está em "Verificação com a chave real" e em
"Correções de 24/11/2026". Esperando o ok do dono para a Fase 1.

Da Fase 5 ainda falta o que depende de outras fases: o backfill e os números de
out/2026 pelo D1 (Fase 3) e a execução do script de webhooks (Fase 4).

- A CLOUDBEDS_API_KEY está no Worker (painel, tipo Secret) e no `.dev.vars`
  (comprimento 37, prefixo `cbat_`). O dono recriou a chave com todos os
  escopos de leitura. **Não confirmado:** se o segredo do Worker já é a chave
  nova. Se a antiga foi apagada na Cloudbeds, o Worker passa a receber 401.
- Toda ferramenta chamada no Worker publicado fala com a Cloudbeds de verdade.
  O dono já usou o conector pelo chat, e os achados estão abaixo.
- O erro "chave da Cloudbeds ainda não configurada" não aparece mais em
  produção; segue coberto só pelos testes.

## Fases

| Fase | Conteúdo | Estado |
|---|---|---|
| A | Infraestrutura no ar | **concluída 24/11/2026** |
| 1 | Dados pessoais completos (cartão nunca sai) | pendente |
| 2 | Catálogo de endpoints e leitura genérica | pendente |
| 3 | Espelho no D1 + cron de sincronização | pendente |
| 4 | Webhooks (código e testes, sem assinar) | pendente |
| 5 | Verificação com a chave real | verificação e correções feitas 24/11/2026; backfill e D1 dependem da Fase 3 |
| 6 | Escrita operacional com prévia e confirmação | pendente, só com ok explícito |
| 7 | Deploy automático (Workers Builds) | pendente |

## Recursos

Uma única conta Cloudflare visível no login do wrangler.

| Recurso | Identificação |
|---|---|
| Worker | `cloudbeds-mcp` → `https://cloudbeds-mcp.reservas-1f7.workers.dev` |
| URL para conectar no Claude (MCP_RESOURCE) | `https://cloudbeds-mcp.reservas-1f7.workers.dev/mcp` |
| KV `OAUTH_KV` | `a7b50a977b3b4aecb538d6483b0e59ce` |
| D1 `cloudbeds_mcp` (binding `DB`) | `b287bf5e-3206-4ab0-8694-f7073143729e`, região ENAM, vazio |
| OAuth App do GitHub | "Cloudbeds MCP — Hotel Britânico", callback `https://cloudbeds-mcp.reservas-1f7.workers.dev/callback`, escopo `read:user` |
| Segredos no Worker (tipo Secret) | GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY, CLOUDBEDS_API_KEY |

O D1 não oferece região na América do Sul. Foi criado sem dica de local, e a
Cloudflare o pôs no leste da América do Norte (ENAM).

## Verificado de verdade (24/11/2026)

No Worker publicado, com o MCP Inspector 2.16 e o `wrangler tail`:

- descoberta OAuth: `/.well-known/oauth-protected-resource/mcp` devolve
  `resource` igual ao MCP_RESOURCE; `POST /mcp` sem token dá 401 com
  `WWW-Authenticate` apontando para ele; o metadata do servidor anuncia
  `/authorize`, `/token` e `/register`;
- login completo com a conta `britanicohotel`: tela de aprovação do conector,
  GitHub, `/callback → 302`, `/token → 200`, `POST /mcp → 200`;
- `tools/list` devolve as 11 ferramentas, todas marcadas somente leitura;
- uma chamada de ponta a ponta (`cloudbeds_desempenho_periodo` com 365 noites)
  volta com "passa do teto de 62", recusada antes de qualquer chamada à
  Cloudbeds;
- recusa de conta fora da allowlist. Não havia segunda conta do GitHub. O teste
  foi feito publicando a allowlist **vazia** por alguns minutos (`--var`, sem
  mexer no `wrangler.jsonc`), o que deixou `britanicohotel` fora da lista:
  - barreira por chamada: o token já emitido passou a receber `POST /mcp → 403`;
  - barreira do login: um OAuth novo terminou em `/callback → 403`, "Esta conta
    do GitHub não está autorizada a usar este conector.", sem token;
  - restaurado com deploy normal; login e `tools/list` voltaram a dar 200.

Não verificado:

- recusa com uma segunda conta real do GitHub. O caminho de código é o mesmo,
  mas o teste usou a própria conta fora da lista;
- `GET /mcp` devolve 405: o handler sem estado não abre o canal de notificações
  em fluxo. O Inspector funciona sem ele, e o Claude não foi testado.

## Decisões e o porquê

### Tomadas pelo dono (antes da Fase A)

1. Acesso total a dados pessoais de hóspede (nome, contato, documento,
   nascimento, endereço, nacionalidade). Dados de cartão (`cardsOnFile`,
   `channelProvidedCreditCard`, número, validade, CVV) nunca saem do Worker,
   inclusive pela ferramenta genérica de leitura. *(Implementação: Fase 1. Até
   lá o código ainda minimiza como antes.)*
2. O D1 guarda reservas, estadias, diárias, valores, origens e status. Dado
   pessoal de hóspede não vai para o D1: é buscado ao vivo.
3. Três faixas: leitura livre; escrita operacional com prévia e confirmação
   (notas, governança, tarifas e restrições, atribuição de quarto); bloqueado
   sempre e fora do catálogo (pagamentos, estornos, void, ajustes financeiros,
   exclusões, cartões, anonimização, usuários, credenciais, fechaduras).
4. Economia de chamadas: análise roda sobre o D1. Tarifas e disponibilidade
   futuras continuam ao vivo.
5. Login pelo GitHub, allowlist `britanicohotel`.

### Fase A

- **`secrets.required` = GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
  COOKIE_ENCRYPTION_KEY, e só** (decisão do dono). No wrangler 4.168 a lista
  tem três efeitos ao mesmo tempo:
  1. barra o deploy quando falta qualquer segredo dela; num Worker que ainda
     não existe, falha antes de enviar (`wrangler-dist/cli.js`,
     `addRequiredSecretsInheritBindings`);
  2. no `wrangler dev`, só os nomes da lista (e os de `vars`) são lidos do
     `.dev.vars` (`getVarsForDev`);
  3. o `wrangler types` tipa no `Env` só os segredos da lista
     (`generateEnvTypes`).

  A CLOUDBEDS_API_KEY pode faltar de verdade, e o Worker precisa subir sem ela.
  Por isso ela fica fora da lista, e o CLOUDBEDS_WEBHOOK_SECRET da Fase 4
  também. Os dois são tipados como opcionais em `src/env.d.ts`, que estende o
  `Env` gerado. Assim o `tsc` obriga o código a tratar a ausência
  (`CloudbedsConfig.apiKey` é `string | undefined`). Nos dois primeiros deploys
  a lista ficou vazia, porque o Worker ainda não existia.

  Verificado:
  - o `cf-typegen` escreve só `worker-configuration.d.ts`: o `src/env.d.ts`
    manteve sha256 e mtime;
  - o `Env` gerado não tem a chave, e o `npm run check` passa;
  - com uma chave fictícia no `.dev.vars`, o `Env` gerado é o mesmo;
  - o `wrangler dev` **não** carrega a CLOUDBEDS_API_KEY do `.dev.vars`: a
    tabela de bindings mostra os três segredos da lista e o
    ALLOWED_GITHUB_LOGINS, sem a chave. O `.dev.vars` foi restaurado da cópia,
    sem nenhum valor.
- **Como rodar local com a chave real (decidir na Fase 5; nada mudado).** O
  roteiro da Fase 5 não depende do `wrangler dev`: o
  `scripts/verificar-cloudbeds.mjs` lê o `.dev.vars` direto. Se for preciso
  testar local com a chave:
  - (a) configuração só de desenvolvimento (`wrangler dev -c
    wrangler.local.jsonc`), igual à principal mas com a chave em
    `secrets.required`. Duplica a configuração. **Recomendada**;
  - (b) declarar CLOUDBEDS_API_KEY em `vars` com `""` faz o `wrangler dev` lê-la
    do `.dev.vars`. No deploy, porém, isso cria uma variável com o nome do
    segredo. **Não testado**; o conflito é provável;
  - descartadas: `--var` põe o valor na linha de comando (proibido), e
    `--env-file` passa pelo mesmo filtro.
- **Chave da Cloudbeds ausente não derruba o Worker.** O construtor do
  `CloudbedsClient` lança `MissingApiKeyError` para chave `undefined`, vazia ou
  só espaços. Toda ferramenta cria o cliente dentro do `run()`, e o Claude
  recebe "chave da Cloudbeds ainda não configurada" sem chamada de rede. O teste
  percorre toda ferramenta listada, e ferramenta nova sem argumentos de exemplo
  faz o teste falhar. Provado por sabotagem: sem a checagem, os 3 testes falham.
- **Bug corrigido: a allowlist por chamada barrava todo mundo.** O
  `apiHandler` lia o login de `getMcpAuthContext()`, que só é preenchido
  *dentro* do handler MCP (`agents/dist/handler-stateless-*.js`,
  `runWithAuthContext`). Antes disso ele devolve undefined, e todo login recebia
  403, mesmo depois de passar pela allowlist no `/callback`. Apareceu no
  primeiro login real. Agora a barreira é `withAllowlist` (`src/auth/gate.ts`),
  que lê `ctx.props`, onde o `workers-oauth-provider` grava as props decifradas
  do token (`oauth-provider.js:4661`). Há 3 testes novos. Provado por
  sabotagem: com o código antigo de volta, "login da allowlist chega ao servidor
  MCP" falha com `expected 403 to be 200`.
- **Intervalo sem segredos (primeiros deploys)** foi seguro. Sem
  COOKIE_ENCRYPTION_KEY, `importKey` lança erro e o `POST /authorize` cai em 500
  antes do GitHub. Sem os segredos do GitHub, o `/callback` não troca código por
  token.

### Incidentes (24/11/2026)

- **Client secret do GitHub numa URL.** Na primeira gravação, o valor do client
  secret foi para o segredo GITHUB_CLIENT_ID (40 hexadecimais, onde o Client ID
  tem 20). O GitHub respondeu 404 em `/login/oauth/authorize`, e o valor ficou
  na URL enviada ao GitHub e no histórico do navegador embutido. Foi
  recomendado gerar um secret novo e apagar o antigo; o dono regravou os dois
  segredos. Não foi conferido se o secret antigo foi apagado no GitHub.
- **Dois logins do wrangler.** O wrangler do painel Terminal do app não
  enxergava o login feito pelas ferramentas do Claude e abriu um segundo login
  OAuth na Cloudflare, aprovado no navegador. Existem duas credenciais do
  wrangler para a mesma conta. Para revogar a do painel: `npx wrangler logout`
  num terminal do app.
- **Edição perdida e recuperada.** Num teste por sabotagem, `git checkout`
  devolveu `src/cloudbeds/client.ts` ao último commit; a edição foi recuperada
  de uma cópia. Daí a regra de sabotagem no topo.

### Máquina de desenvolvimento (Windows)

- Node 26.13.1 LTS e Visual C++ Redistributable x64 14.52 instalados por winget
  em 24/11/2026. Sem o VC++ x64, o `workerd.exe` (usado pelo `cf-typegen`, pelo
  `wrangler dev` e pelos testes de D1 local) saía com 0xC0000135 (DLL ausente).
- O npm 11.20 não roda os scripts de instalação de `esbuild`, `workerd` e
  `core-js-pure` (allowScripts). Testes, `cf-typegen`, `wrangler dev` e deploy
  funcionam sem eles. Se algo de binário falhar, `npm install-scripts ls` é o
  primeiro lugar a olhar.
- No `wrangler dev`, o `.dev.vars` sobrepõe `vars`: ALLOWED_GITHUB_LOGINS vazio
  lá significa que ninguém entra localmente.

## Verificação com a chave real (24/11/2026)

`node scripts/verificar-cloudbeds.mjs` (opções
`--apenas=pms|fuso|insights|receita|bloqueios`). O script lê a chave do
`.dev.vars` e chama cada endpoint uma vez; receita e bloqueios paginam. Ele imprime só
status, X-Request-ID, esqueleto (campo, tipo, contagem) e verificações em
contagens. Textos viram classe de formato, nunca conteúdo. Testado antes contra
uma Cloudbeds falsa com 11 dados pessoais plantados: nenhum apareceu na saída.

### Chamadas

| Endpoint | HTTP | X-Request-ID |
|---|---|---|
| getHotelDetails | 200 | `4a63f774-4ea5-4360-991b-9624ac548632-26112501` |
| getHotels | 200 | (rodada `--apenas=fuso`) |
| getRooms (pageSize=100) | 200 | `92820506-40db-47c4-8ec1-e6ddf29f4766-26112501` |
| getRoomTypes | 200 | `f694eb30-41fa-4f12-a213-f6ed64bf0676-26112501` |
| getSources | 200 | `0af42eec-ea7c-4127-b09b-c158e7804f6e-26112501` |
| getReservations (modifiedFrom ontem) | 200 | `d5134a4e-c5ab-419d-9aad-b230572a6324-26112501` |
| getReservationsWithRateDetails (check-out 12–18/10/2026) | 200 | `48d9e7b8-f610-4a63-8a0b-84d713099236-26112501` |
| getRatePlans (3 noites, detailedRates) | 200 | `e5f8e7d5-051b-4a40-a6b1-6705f919cdd7-26112501` |
| getAvailableRoomTypes | 200 | `6a86f4a1-b5df-488d-983d-23c26a7eb015-26112501` |
| getWebhooks | 200 | `8490dfeb-c061-45cf-82e1-386a334f3834-26112501` |
| Insights `health`, `me/policies`, `datasets/7` | 200 | (o Insights não devolve X-Request-ID) |
| Insights `POST reports/query/data` (Preview) | **403** | — |
| Insights `GET reports` | **403** | — |
| Insights `GET stock_reports/310/data` | 200 | — |
| Insights `GET stock_reports/310` + `POST stock_reports/310/query/data` (Preview) | 200 | — |
| getReservationsWithRateDetails out/2026 (3 páginas, 216 reservas) | 200 | `bfe11327-…-26112502`, `a1926ef4-…-26112502`, `50c13436-…-26112502` |
| Accounting `GET internal-transaction-codes` | 200 | (a Accounting não devolve X-Request-ID) |
| Accounting `POST transactions` (service_date out/2026; 1/11 a 24/11) | 200 | — |
| getRoomBlocks out/2026 | 200 | `d4d6155b-6841-4612-b2a9-4b7bca67cd6f-26112502` |

### Escopos

Não há endpoint que liste os escopos da chave. A tabela vem do que respondeu.

| A chave tem (respondeu 200) | Endpoints |
|---|---|
| `read:hotel` | getHotelDetails, getHotels |
| `read:room` | getRooms, getRoomTypes, getAvailableRoomTypes |
| `read:reservation` | getReservations, getReservationsWithRateDetails, getSources |
| `read:rate` | getRatePlans |
| `read:roomblock` | getRoomBlocks |
| `read:payment` (Accounting API, autenticação Bearer) | internal-transaction-codes, transactions |
| (sem escopo na documentação) | getWebhooks |
| acesso ao Insights | health, datasets, me/policies, stock_reports (lista, dados e consulta) |

| Falta | Onde | Natureza |
|---|---|---|
| ver relatórios próprios no Insights (recurso `report`, ação VIEW) | `POST reports/query/data` e `GET reports` → 403 "User does not have permission to VIEW report" | **permissão do usuário**, não escopo da chave |

Por que é permissão do usuário:

- o 403 se repete fora do Worker, direto com a chave, então não é o Worker nem
  o corpo da consulta. A listagem simples `GET reports` também dá 403;
- o dono recriou a chave com todos os escopos de leitura, e o 403 continuou;
- `GET me/policies` devolve só `explore_reports` (CREATE, VIEW, UPDATE,
  DELETE) e `acls` (35 relatórios-padrão, entre eles occupancy, pace, adr,
  revpar, rooms_sold e pickup). Não aparece **nenhum recurso `report`**, que é
  exatamente o que a mensagem cobra;
- relatórios-padrão (`stock_reports`) funcionam.

Para liberar: dar ao usuário dono da chave, na Cloudbeds, a permissão de ver
relatórios do Insights (relatórios salvos e consulta livre). O nome exato da
opção na tela não foi conferido.

### Suposições: resultado

| Suposição | Resultado | Evidência |
|---|---|---|
| `getRooms`: `data[]` por propriedade com `rooms[]`; `pageSize` vale para quartos | **confirmada** | 1 propriedade, 21 quartos, `count=21 total=21`. O padrão de 20 perderia 1 quarto, então o `pageSize=100` é necessário. `archivedAt` não vem (nem como null); `!archivedAt` funciona. 1 quarto com `roomBlocked=true` entra na capacidade |
| Quartos físicos = 21 | **confirmada** | script (21, nenhum virtual ou arquivado) e conector no chat (21) |
| `getReservationsWithRateDetails`: filtro por `reservationCheckOutFrom/To`, `excludeStatuses`, paginação, `total` | **confirmada em parte** | 41 de 41 com check-out no intervalo; `count=total=41`. Só 1 página: paginação acima de 100 e `excludeStatuses` continuam **abertos** |
| `detailedRoomRates`: valor numérico ou texto | **confirmada: número** | 99 valores, todos `number`, chaves `AAAA-MM-DD`. Datas = noites da estadia em 42 de 42 quartos, nenhuma fora da estadia. `detailedRates` da reserva também é número |
| `dateCancelled` preenchido em toda cancelada | **confirmada na amostra** | 6 de 6, formato data-hora; vem também `dateCancelledUTC`. Em reserva não cancelada a chave não existe |
| `getHotelDetails.propertyCurrency` objeto com `currencyCode`; escopo `read:hotel` | **confirmada** | objeto com 5 chaves; `read:hotel` respondeu |
| `getRatePlans` e `getAvailableRoomTypes`: `endDate` é o check-out | **confirmada** | 24 planos e 3 tipos, todos com 3 datas para 3 noites; a data de chegada entra, o `endDate` não |
| Insights: o hotel tem acesso? | **confirmada em parte** | health, datasets, policies e stock reports respondem; relatórios próprios e consulta livre dão 403 (permissão, acima) |
| Fixture de privacidade: `getReservations` traz `guestList`, e-mail, cartão, campos personalizados | **refutada para a chamada padrão** | sem `includeGuestsDetails`, `getReservations` não traz `guestList` (0 de 33), nem e-mail, cartão ou `customFields`; o nome vem em `guestName` e em `rooms[].guestName`. Relevante para a Fase 1 |
| Capacidade histórica = quartos atuais (21) | **aberta** (achado do chat) | o ano anterior tem os tipos "SUÍTE DUPLA ECONÔMICA" e "SUÍTE TRIPLA", que não existem mais; dividir o histórico por 21 pode estar errado |
| Receita de diárias = `detailedRoomRates`, sem impostos, refletindo ajustes | **confirmada em parte** | das 149 reservas não no-show de out/2026, 144 batem com a contabilidade ao centavo, ajustes posteriores inclusive; **refutada** em "sem impostos" nas outras 5 (imposto 8000 embutido, 180,40) |
| `getRoomBlocks.endDate` inclusiva ou exclusiva | **aberta**, com indício de inclusiva | 14 ou 28 quartos-noite em outubro; o filtro da API inclui o dia do `endDate` (ver "Capacidade") |

### Divergências que afetam o código

O que foi feito com cada uma está em "Correções de 24/11/2026".

1. **Tarifa diária em `getRatePlans`.** O real vem em `roomRateDetailed[].rate`;
   a documentação diz `rateBase`, e o conector lê `d.rateBase`
   (`src/tools/register.ts:235`). Na ferramenta `cloudbeds_tarifas_disponibilidade`,
   o campo "tarifa" sai vazio.
2. **Status de quarto cancelado.** O real é `rooms[].roomStatus = "canceled"`
   (6 quartos); a documentação diz `cancelled`, e o código compara com
   `"cancelled"` (`src/analytics/metrics.ts:89`). A checagem nunca casa.
   - Efeito: quarto cancelado dentro de reserva ativa (multi-quarto) entra no
     desempenho, e no pace entra mesmo depois do cancelamento.
   - Na amostra, os 6 quartos cancelados eram das 6 reservas canceladas, então
     o efeito não apareceu.
3. **Fuso.** `getHotelDetails` não tem campo de fuso nenhum, e o conector lê
   `data.propertyTimezone` dele (`src/tools/register.ts:96`). Por isso o fuso
   veio ausente no chat. O campo real é `getHotels.data[].propertyTimezone`,
   conferido igual a `America/Sao_Paulo`.
4. **`getSources`.** O real é `data` = um array contendo **outro** array com as
   29 origens (`data[][]`); a documentação diz `data[]` de objetos.
   - `commission` e `taxes[].amount` vêm como texto numérico; a documentação
     diz número.
   - `cloudbeds_origens` devolve o aninhado como veio. A Fase 2/3 precisa
     achatar.
5. **`getReservations` sem `guestList`.** Ver suposições.
   `src/privacy.ts` monta `hospedes` a partir de `guestList`, que não vem na
   chamada padrão. Decidir na Fase 1 se pede `includeGuestsDetails=true`.
6. **`getReservationsWithRateDetails` traz `guestList` por padrão** (41 de 41),
   embora a documentação ponha `includeGuestsDetails` padrão false. A
   sincronização da Fase 3 vai receber dado pessoal e precisa descartá-lo antes
   do D1 (decisão 2).
7. **Comentário de escopo errado** em `src/cloudbeds/endpoints.ts:10`: diz
   `read:hotel` para `getSources`; a documentação e a chave mostram
   `read:reservation`.
8. **Insights:** `cloudbeds_insights_consulta` (`reports/query/data`) só
   funciona com a permissão acima.
9. **Receita com imposto embutido.** Para 5 reservas de outubro,
   `detailedRoomRates` inclui o imposto que a contabilidade lança como 8000
   (180,40 no mês), e a definição do conector diz "sem impostos". Detalhe em
   "Receita".
10. **Capacidade sem bloqueios.** A ocupação divide por 21 quartos fixos;
    `getRoomBlocks` mostra 14 ou 28 quartos-noite bloqueados em outubro.

### Correções de 24/11/2026

Cada correção tem teste contra a Cloudbeds simulada no formato real e foi
provada por sabotagem: com o comportamento antigo de volta, só o teste dela
falha. A restauração foi feita por cópia dentro do repositório, e o hash dos
arquivos ficou igual.

| # | Divergência | Situação |
|---|---|---|
| 1 | tarifa em `rate`, não `rateBase` | **corrigida** (`src/tools/register.ts:255`). O plano-pai do derivado agora sai pelo nome, resolvido por `parentRateID`, porque `parentRatePlanNamePrivate` vem sempre nulo |
| 2 | quarto `"canceled"` | **corrigida**: `isCanceledRoom` aceita as duas grafias (`src/analytics/metrics.ts:47`) |
| 3 | fuso | **corrigida**: a visão geral usa `getHotels` (fuso e moeda), ainda com 2 chamadas; `currencyCode` aceita objeto ou array |
| 4 | `getSources` aninhado | **corrigida**: `flattenSources`; `cloudbeds_origens` devolve lista plana |
| 5 | `getReservations` sem `guestList` | **Fase 1** (privacidade); a fixture ficou marcada como REFUTADO |
| 6 | `guestList` em `getReservationsWithRateDetails` | **Fase 3**: descartar antes do D1. Hoje nenhuma ferramenta repassa esse campo |
| 7 | comentário de escopo | **corrigido** (`src/cloudbeds/endpoints.ts`) |
| 8 | 403 do Insights | **mensagem corrigida**: o erro agora explica que é permissão do usuário e que os stock reports funcionam. A liberação é na Cloudbeds |
| 9 | imposto embutido na receita | **definição corrigida** em `DEFINITIONS` e no README. O valor não muda; guardar transações é decisão da Fase 3 |
| 10 | capacidade sem bloqueios | **não é erro**: a ocupação atual é a "Occupancy" oficial da Cloudbeds (ver "Capacidade"). A ocupação líquida de bloqueios fica para a Fase 3, depois de resolver o `endDate` |

Fixtures: os comentários `// SUPOSIÇÃO` das respostas confirmadas viraram
`CONFIRMADO em 24/11/2026`. `getHotels`, `getSources`, `getRatePlans` e o 403
do Insights foram simulados no formato real. São 30 testes, 5 deles novos.

### Divergências só de documentação

- `reservationCheckIn/Out` documentados como data-hora; vêm como data
  (`AAAA-MM-DD`), que é o que o código usa.
- `getAvailableRoomTypes.propertyCurrency` e `getHotels.propertyCurrency`
  documentados como array; vêm como objeto.
- `getAvailableRoomTypes`: `maxGuests` e `adultsIncluded` vêm como texto
  numérico (documentados como inteiro); `childrenIncluded` mistura número e
  texto.
- `getRatePlans.roomTypeName` documentado como inteiro; vem texto.
- `detailedRoomRateNames` vem `[]` quando vazio e objeto quando preenchido. O
  mesmo pode acontecer com `detailedRoomRates` vazio; não foi visto, e o código
  aguenta (`Object.keys([])` é vazio).
- O Insights não devolve X-Request-ID; as especificações técnicas dizem que
  toda resposta traz.
- Insights: existem datasets 10 e 18 (o chat viu 1, 2, 3, 5, 6, 7, 10, 18), mas
  a documentação limita `dataset_id` a 1–9. Os tipos de CDF reais incluem
  `DynamicCurrency`, `Currency`, `Identifier`, `PickList`, `Date`,
  `DynamicPercentage` e `Boolean`; a documentação lista String, Number e
  Dynamic. O dataset 7 volta com o nome "Ocupació".
- `getWebhooks` diz listar as assinaturas "do cliente da API": vieram 0 com
  esta chave. As do hub, com outra chave, provavelmente não aparecem aqui
  (**aberto**). Isso importa para o script da Fase 4, que precisa não tocar
  nelas.

### Insights: CDFs do dataset 7 (Occupancy)

Os cinco procurados existem: `capacity_count`, `rooms_sold`,
`blocked_room_count`, `out_of_service_count` e `room_revenue`. São 56 CDFs em 6
categorias:

- **Occupancy:** `mfd_occupancy`, `allotment_blocked_room_count`,
  `blocked_room_count`, `capacity_count`, `occupancy`, `out_of_service_count`,
  `rooms_available`, `rooms_sold`.
- **Financial:** `room_revenue`, `total_revenue`, `additional_room_revenue`,
  `room_rate`, `non_room_revenue`, `other_revenue_adjustments`, `misc_income`,
  `total_other_revenue`, `total_room_revenue_adjustments`, `room_fees`,
  `room_taxes`, `conversion_rate`, `original_currency`.
- **Booking:** `adr`, `revpar`, `stay_date`, `booking_id`,
  `reservation_number`, `adults_count`, `children_count`, `room_guest_count`,
  `assumed_assignment_flag`.
- **Property:** `room_id`, `room_number`, `room_type`, `room_type_id`,
  `room_type_category`, `accommodation_kind`, `property_id`, `property_name`,
  `organization_id`.
- **Reservation:** `market_segment_*`.
- **Converted Currency:** as versões `*_converted_rate`.

### Insights: stock reports respondem

Teste com o relatório 310 (Channel Production Comparison - YOY by Month):

- `GET stock_reports/310/data?property_ids=7830` → **200**, o relatório pronto:
  98 linhas, 3 níveis de agrupamento (mês, grupo de canal, canal), 2 períodos
  (este ano e ano anterior), métricas `rooms_sold`, `room_revenue`, `adr` e as
  variações calculadas.
- `POST stock_reports/310/query/data?mode=Preview` → **200** quando o corpo
  repete os `periods` da definição do relatório (`GET stock_reports/310`). Só
  com `property_ids` dá **400**: "Calculated columns must use existing
  comparisons or periods". A consulta substitui a configuração do relatório.

**Decisão do dono:** a execução de stock reports entra no catálogo da Fase 2
como caminho principal de análise oficial.

### Receita: diária registrada contra a contabilidade (out/2026)

Pergunta do dono: a receita de `detailedRoomRates` deixa de fora descontos e
ajustes lançados depois, como um 1000A após o check-out? Comparação feita com
a Accounting API (`POST /accounting/v1.0/transactions`, transações postadas).
`amount` vem em reais; o `currencyScale` (2) só informa as casas decimais.

| Out/2026 | Valor |
|---|---|
| Conector: `detailedRoomRates`, sem cancelada e no-show (436 noites) | 173.638,73 |
| Contábil, `service_date` em outubro: 1000 Rate (438) | 176.968,79 |
| Contábil: 1000A Rate - Adjustment (95) | −3.510,46 |
| **Diária líquida contábil** | **173.458,33** |
| **Diferença contábil − conector** | **−180,40 (−0,10%)** |

- A diferença é **exatamente** o código 8000 Tax do mês (9 transações,
  180,40). Para 5 reservas, a diária registrada embute um imposto que a
  contabilidade lança à parte; deve ser a origem com imposto em `getSources`.
  Isso contraria a definição publicada pelo conector, "sem impostos"
  (`src/analytics/metrics.ts:202`). **Divergência que afeta o código.**
- **Conciliação por reserva** (152 reservas com noite em outubro), comparando
  diária registrada e diária contábil, ambas de 1/10 a 24/11:
  - 144 batem ao centavo;
  - 5 batem somando o imposto 8000;
  - 3 diferem, e as 3 são no-show (−10.971,24): têm diária registrada, mas
    nenhuma diária postada. O conector já exclui no-show.
- **Ajustes posteriores:** de 1/11 a 24/11 foram lançados 7 ajustes 1000A
  (−340,57) em 5 reservas com noites em outubro, e as 5 batem. O
  `detailedRoomRates` já incorpora esses ajustes.
- Todas as 533 transações de diária casam com a reserva por `sourceIdentifier`,
  que é o `reservationID`. Também aparecem no mês, fora da diária: 2000 Item &
  Service, 8100 Fee e as respectivas anulações (V), além de pagamentos 9xxx.

Conclusão, com uma ressalva: a evidência é de **um mês**. Em out/2026, a receita
por `detailedRoomRates` é fiel à contabilidade, a menos do imposto embutido
(0,10%). **A decisão de guardar transações no espelho da Fase 3 é do dono.**

### Capacidade: bloqueios (out/2026)

`getRoomBlocks` responde (escopo `read:roomblock`, até 35 dias por consulta).

- Outubro tem 14 bloqueios, todos `blocked_dates`, cada um com 1 quarto. Não
  há `out_of_service` nem `courtesy_hold`.
- Quartos-noite bloqueados no mês: **14** se `endDate` for exclusiva, **28** se
  for inclusiva. A documentação não diz qual. **Aberto.** Evidências até
  agora:
  - todos os 14 bloqueios têm `endDate` = `startDate` + 1;
  - o filtro de data do próprio `getRoomBlocks` ("bloqueios que incluem a
    data") devolve o bloqueio no dia do `endDate` (4 de 4) e não no dia
    seguinte (0 de 4). Isso aponta para inclusivo;
  - contraprova inconclusiva: com datas passadas, `getRooms` devolve o quarto
    como livre até na noite do `startDate` (6 de 6), então não enxerga
    bloqueios;
  - a consulta a stock report não aceita trocar colunas ("Columns are not the
    same"), e nenhum dos relatórios-padrão de ocupação encontrados tem
    `blocked_room_count`;
  - o jeito mais simples de fechar: abrir um bloqueio de outubro no calendário
    da Cloudbeds e ver se cobre 1 ou 2 noites.
- **Definições oficiais da Cloudbeds** (descrições dos CDFs do dataset 7):
  - `occupancy` = vendidos ÷ capacidade, "não considera bloqueados nem fora de
    serviço". É o que o conector calcula;
  - `mfd_occupancy` = vendidos ÷ (capacidade − bloqueados − fora de serviço).
  A divergência 10, portanto, não é erro: falta só oferecer a ocupação
  líquida, que fica para a Fase 3.
- Capacidade real de outubro: 651 − 14 ou 651 − 28. O conector usa hoje 21
  quartos fixos (651) e ignora os bloqueios.
- `getRooms` mostra hoje 1 quarto com `roomBlocked=true`; esse é o estado
  atual, não o histórico.
- Formato: `data.roomBlocks[]` com `rooms[]`; `roomTypeID` vem como número;
  vem `count`, mas não `total`.

### Achados do dono pelo conector no chat (24/11/2026)

- `cloudbeds_visao_geral_hotel`: 21 quartos físicos; "fuso" ausente (explicado
  na divergência 3).
- `cloudbeds_desempenho_periodo` de out/2026: funcionou com 7 chamadas e 0
  noites sem tarifa detalhada. O ano anterior traz tipos de quarto que não
  existem mais (suposição aberta acima).
- Insights: health, datasets e stock_reports (156 relatórios) respondem 200; a
  consulta deu 403 (diagnóstico acima).
- `cloudbeds_insights_status` devolve as fórmulas completas de cada relatório.

## Pendências fora da Fase A

- README, seção "Implantação": ainda manda `wrangler secret put` da chave e
  descreve a minimização antiga de dados pessoais. Revisar nas Fases 1 e 7.
- O KV do OAuth guarda os clientes registrados pelo Inspector nos testes.
  Não dão acesso sem login e allowlist; não foi conferido se expiram.
- Fase 1: `getReservations` padrão não traz `guestList`. Decidir se pede
  `includeGuestsDetails=true` e refazer a fixture de privacidade com o formato
  real.
- Fase 2: compactar `cloudbeds_insights_status` para id, título, `dataset_id` e
  descrição de cada relatório (hoje devolve as fórmulas inteiras). Stock
  reports como caminho principal de análise oficial; a consulta precisa
  repetir os `periods` da definição.
- Fase 2/3: achatar `getSources` (`data[][]`); descartar `guestList` vindo de
  `getReservationsWithRateDetails` antes do D1.
- Fase 3, decisão do dono: guardar ou não as transações (1000, 1000A, 8000…)
  no espelho. Out/2026 diferiu 0,10%, só pelo imposto embutido. Se guardar,
  `sourceIdentifier` liga a transação à reserva.
- Fase 3: guardar os bloqueios (`getRoomBlocks`) para a capacidade real por
  dia, depois de resolver se o `endDate` é inclusivo.
- Fase 4: `getWebhooks` com esta chave não vê as assinaturas do hub.
- Na Cloudbeds: permissão de ver relatórios do Insights para o usuário da
  chave, se a consulta livre for necessária.
- Confirmar que o segredo CLOUDBEDS_API_KEY do Worker é a chave recriada.

## Suposições a verificar com a chave

Lista viva. Cada linha diz a situação depois da verificação de 24/11/2026 e
onde o código depende dela. O que está **aberto** continua sendo suposição e
não pode ser reportado como verificado.

| Suposição | Situação | Depende dela |
|---|---|---|
| `getRooms`: `data[]` por propriedade com `rooms[]`; `pageSize` vale para quartos | confirmada | `src/cloudbeds/endpoints.ts:151-158`; fixture `test/fake-cloudbeds.ts` |
| `getReservationsWithRateDetails`: filtro por `reservationCheckOutFrom/To` e `total` do recorte | confirmada | `src/tools/analytics.ts:41-55` |
| `getReservationsWithRateDetails`: paginação acima de 100 e `excludeStatuses` | **aberta** | `src/cloudbeds/endpoints.ts:84-106` (`paginate`), `src/tools/analytics.ts:47` |
| `detailedRoomRates`: `{ data: número }` | confirmada | `src/analytics/metrics.ts:52`, `src/cloudbeds/endpoints.ts:42` |
| `dateCancelled` em toda reserva cancelada | confirmada na amostra (6 de 6) | `src/analytics/metrics.ts:66`; fixture `PACE` em `test/conector.test.ts` |
| `propertyCurrency` objeto com `currencyCode` | confirmada (`getHotelDetails` e `getHotels`) | `src/cloudbeds/endpoints.ts:118`, `src/tools/register.ts:104` |
| `getRatePlans` e `getAvailableRoomTypes`: `endDate` é o check-out | confirmada | `src/tools/register.ts:225`, `src/tools/register.ts:357` |
| Insights: o hotel tem acesso | confirmada em parte (stock reports sim; consulta livre e relatórios salvos exigem permissão do usuário) | `src/tools/register.ts:384`, `src/cloudbeds/endpoints.ts:207-221` |
| Hotel **sem** Insights responde 401 em `health` | **aberta** (não observável neste hotel) | fixture `test/fake-cloudbeds.ts` |
| Capacidade histórica = quartos atuais (21) | **aberta** | `src/tools/analytics.ts:59-64` (`roomCount`) |
| `getRoomBlocks.endDate` inclusiva | **aberta**, com indício de inclusiva | ainda sem código; Fase 3 |
| Receita = `detailedRoomRates` reflete ajustes | confirmada em out/2026 (um mês) | `src/analytics/metrics.ts:215` |
