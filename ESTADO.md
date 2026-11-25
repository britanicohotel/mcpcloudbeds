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

**Fase A concluída em 24/11/2026.** Esperando o ok para a Fase 1.

Atenção para as próximas fases: o dono gravou a **CLOUDBEDS_API_KEY no Worker**
em 24/11, pelo painel. O `.dev.vars` continua sem nenhum valor. Daí decorre:

- toda ferramenta chamada no Worker publicado fala com a Cloudbeds de verdade.
  Nenhuma foi chamada assim até agora;
- o erro "chave da Cloudbeds ainda não configurada" não aparece mais em
  produção; segue coberto só pelos testes;
- a Fase 5 pede a chave também no `.dev.vars`, e ela ainda não está lá.

## Fases

| Fase | Conteúdo | Estado |
|---|---|---|
| A | Infraestrutura no ar | **concluída 24/11/2026** |
| 1 | Dados pessoais completos (cartão nunca sai) | pendente |
| 2 | Catálogo de endpoints e leitura genérica | pendente |
| 3 | Espelho no D1 + cron de sincronização | pendente |
| 4 | Webhooks (código e testes, sem assinar) | pendente |
| 5 | Verificação com a chave real | pendente, só com aviso do dono |
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

## Pendências fora da Fase A

- README, seção "Implantação": ainda manda `wrangler secret put` da chave e
  descreve a minimização antiga de dados pessoais. Revisar nas Fases 1 e 7.
- O KV do OAuth guarda os clientes registrados pelo Inspector nos testes.
  Não dão acesso sem login e allowlist; não foi conferido se expiram.

## Suposições a verificar com a chave

Nada que dependa delas está verificado.

| Suposição | Depende dela |
|---|---|
| `getRooms`: `data[]` por propriedade, cada uma com `rooms[]`; o `pageSize` (padrão 20) vale para propriedades ou quartos? Pedimos 100 | `src/cloudbeds/endpoints.ts:125-132`; fixture `test/fake-cloudbeds.ts` |
| `getReservationsWithRateDetails`: filtra por `reservationCheckOutFrom/To` e `excludeStatuses`, pagina por `pageNumber/pageSize`, e `total` é o total do recorte | `src/tools/analytics.ts:41-55`; fixture `test/fake-cloudbeds.ts` |
| `detailedRoomRates`: `{ data: valor }`, com valor numérico ou string? Convertemos os dois | `src/analytics/metrics.ts:38`, `src/cloudbeds/endpoints.ts:39`; fixture `test/fake-cloudbeds.ts` |
| `dateCancelled` vem preenchido em toda reserva cancelada? Sem ele, a reserva sai do pace | `src/analytics/metrics.ts:52`; fixture `PACE` em `test/conector.test.ts` |
| `getHotelDetails`: formato de `propertyCurrency` (objeto com `currencyCode` ou string) e nome exato do escopo | `src/tools/register.ts:95`, `src/cloudbeds/endpoints.ts:56`; fixture `test/fake-cloudbeds.ts` |
| `getRatePlans` e `getAvailableRoomTypes`: `endDate` é a data de check-out | `src/tools/register.ts:216`, `src/tools/register.ts:336` |
| Insights API: o hotel tem acesso? Sem acesso, `health` responde 401? | `src/tools/register.ts:363`, `src/cloudbeds/endpoints.ts:176-188`; fixture `test/fake-cloudbeds.ts` |
