# cloudbeds-mcp — conector MCP da Cloudbeds do Hotel Britânico

Servidor MCP remoto, hospedado no Cloudflare Workers (plano gratuito), que dá ao
Claude acesso **somente leitura** à Cloudbeds do hotel: reservas, movimento do
dia, tarifas e disponibilidade, desempenho do período comparado ao ano anterior,
pace da carteira futura e, se o hotel tiver o produto, a Insights API.

```
Claude ──OAuth 2.1──▶ Worker (este repositório) ──x-api-key──▶ api.cloudbeds.com
                       │  login delegado ao GitHub, só logins da allowlist
                       └─ KV: estado do OAuth
```

## Ferramentas

| Ferramenta | O que faz | Chamadas à Cloudbeds |
|---|---|---|
| `cloudbeds_visao_geral_hotel` | propriedade e quartos físicos por tipo | 2 |
| `cloudbeds_listar_reservas` | reservas por check-in/out, criação, status | 1 |
| `cloudbeds_detalhe_reserva` | uma reserva pelo ID | 1 |
| `cloudbeds_movimento_do_dia` | chegadas, saídas e hospedados | 3 |
| `cloudbeds_tarifas_disponibilidade` | tarifa diária, disponíveis e restrições (≤31 noites) | 1 |
| `cloudbeds_disponibilidade_venda` | tipos disponíveis para uma estadia | 1 |
| `cloudbeds_origens` | origens/canais cadastrados | 1 |
| `cloudbeds_desempenho_periodo` | ocupação, ADR, RevPAR, receita, room nights + ano anterior + quebras | 1 + páginas |
| `cloudbeds_pace` | carteira futura vs mesma antecedência do ano anterior + pickup | 1 + páginas |
| `cloudbeds_insights_status` | o hotel tem Insights API? datasets e relatórios-padrão | 3 |
| `cloudbeds_insights_consulta` | ReportQuery direto na Insights API | 1 |

Definições das métricas (também vão na resposta de cada ferramenta): receita é a
soma das diárias `detailedRoomRates` registradas na Cloudbeds — sem consumos,
impostos ou taxa de serviço; ocupação usa os quartos físicos do cadastro atual;
canceladas e no-show ficam fora do desempenho. A comparação padrão com o ano
anterior recua 364 dias (segunda com segunda).

## Limites que moldaram o desenho

- **Plano Free do Workers**: 100 mil requisições/dia, **10 ms de CPU** e **50
  subrequisições** por requisição. O cliente para em 40 chamadas e as análises
  aceitam no máximo `MAX_PERIOD_DAYS` (62) noites por chamada — para um ano, o
  Claude chama mês a mês. Se aparecer erro 1102 (CPU), o caminho é o plano Paid
  (US$ 5/mês, 30 s de CPU), sem mudar código.
- **Cloudbeds**: 10 requisições/s; páginas de 100. O cliente espaça as chamadas
  em 120 ms. A chave deste conector deve ser **separada** da do hub, para que um
  não consuma o limite do outro e para poder ser revogada sozinha.
- **Dados pessoais**: a saída passa por lista de campos permitidos
  (`src/privacy.ts`). Documento, nascimento, endereço, CPF, cartões e campos
  personalizados nunca saem; e-mail e telefone saem mascarados.

## Implantação, passo a passo

Pré-requisitos: Node 22+, conta Cloudflare, conta GitHub, chave da Cloudbeds.

1. **Chave da Cloudbeds** — Account → Apps & Marketplace → aba API Credentials →
   **+ New Credentials** (nome "Claude MCP", redirect `https://localhost`,
   "Enable for Entire Organization" desligado) → na tabela, **Create** na coluna
   API Key → escopos só de leitura: reservas, quartos, tarifas, hotel e, se
   aparecerem, os de Data Insights. Nenhum de escrita ou exclusão. Conecte só a
   propriedade 7830 e copie a chave (`cbat_...`) — ela não é exibida de novo.
   Para mudar escopos depois é preciso apagar a chave e criar outra. A chave
   expira se ficar 30 dias sem uso.
2. **Instalar e testar**: `npm install && npm run check`.
3. **Login na Cloudflare**: `npx wrangler login`.
4. **KV do OAuth**: `npx wrangler kv namespace create OAUTH_KV` e coloque o `id`
   devolvido em `wrangler.jsonc`.
5. **Primeiro deploy** (para descobrir a URL): `npx wrangler deploy`. A URL será
   `https://cloudbeds-mcp.<subdominio>.workers.dev`. Ajuste em `wrangler.jsonc`:
   `MCP_RESOURCE` = `https://cloudbeds-mcp.<subdominio>.workers.dev/mcp` e
   `ALLOWED_GITHUB_LOGINS` = seu login do GitHub.
6. **OAuth App no GitHub** — github.com/settings/developers → New OAuth App:
   Homepage `https://cloudbeds-mcp.<subdominio>.workers.dev`, callback
   `https://cloudbeds-mcp.<subdominio>.workers.dev/callback`. Gere o secret.
7. **Segredos** (cada comando pede o valor; nunca passe na linha de comando):
   ```
   npx wrangler secret put CLOUDBEDS_API_KEY
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # valor: openssl rand -hex 32
   ```
8. **Deploy final**: `npm run deploy` (roda tipos e testes antes).
9. **Conectar no Claude** — Personalizar → Conectores → Adicionar conector
   personalizado → URL `https://cloudbeds-mcp.<subdominio>.workers.dev/mcp`, sem
   preencher OAuth Client ID/Secret. O Claude descobre o servidor OAuth sozinho,
   abre o login do GitHub e volta conectado. No Claude Code:
   `claude mcp add --transport http cloudbeds https://cloudbeds-mcp.<subdominio>.workers.dev/mcp`.
10. **Conferência** com o MCP Inspector (`npx @modelcontextprotocol/inspector@latest`)
    e, no Claude, peça a visão geral do hotel: tem de dar 21 quartos físicos.

Para revogar o acesso de alguém: tire o login de `ALLOWED_GITHUB_LOGINS` e faça
deploy — a próxima chamada já volta 403. Para cortar tudo: revogue a chave na
Cloudbeds.

## Desenvolvimento local

`cp .dev.vars.example .dev.vars`, preencha (OAuth App de desenvolvimento com
callback `http://localhost:8788/callback`) e `npm run dev`. Endpoint local:
`http://localhost:8788/mcp`.

## O que ainda precisa ser conferido contra a Cloudbeds real

A documentação deixa estes pontos em aberto; o código assume o que está escrito
ao lado, e cada um deve ser confirmado com uma chamada real antes de confiar nos
números:

- `getRooms`: paginação padrão de 20 vale para propriedades ou quartos? (pedimos 100)
- `detailedRoomRates`: valor numérico ou string? (convertemos os dois)
- `dateCancelled` vem preenchido em toda reserva cancelada? (sem ele, a reserva
  sai do pace)
- `getHotelDetails`: formato de `propertyCurrency` e nome exato do escopo
- `getAvailableRoomTypes` e `getRatePlans`: `endDate` é a data de check-out
- Insights API: o hotel tem acesso? (`cloudbeds_insights_status` responde)
