/**
 * Conector MCP remoto da Cloudbeds — Hotel Britânico.
 *
 * Camadas, de fora para dentro:
 *   1. OAuthProvider (workers-oauth-provider): o Worker é o servidor OAuth 2.1
 *      que o Claude enxerga (descoberta, /register, /token, PKCE).
 *   2. Login delegado ao GitHub (src/auth/github-handler.ts); só contas em
 *      ALLOWED_GITHUB_LOGINS recebem token.
 *   3. apiHandler confere a allowlist de novo a cada chamada — tirar alguém da
 *      lista corta o acesso na hora, sem esperar o token expirar.
 *   4. Ferramentas só de leitura, com dados pessoais minimizados.
 */
import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { withAllowlist } from "./auth/gate";
import { GitHubHandler } from "./auth/github-handler";
import { CloudbedsClient } from "./cloudbeds/client";
import { registerTools } from "./tools/register";

const SERVER_INSTRUCTIONS = `Conector de leitura da Cloudbeds do Hotel Britânico (Gramado/RS, fuso America/Sao_Paulo, moeda BRL).
- Comece por cloudbeds_visao_geral_hotel para saber a capacidade.
- Para ocupação, ADR, RevPAR e comparação com o ano anterior use cloudbeds_desempenho_periodo; para carteira futura, cloudbeds_pace.
- Cada chamada aceita no máximo ${env.MAX_PERIOD_DAYS || 62} noites; para um ano, chame mês a mês e some.
- A receita é a de diárias registradas na Cloudbeds, sem consumos e sem a taxa de serviço de 10%.
- Dados pessoais vêm minimizados por desenho; não tente reconstruí-los.`;

function createServer() {
	// Uma instância por requisição: o SDK v2 não aceita instância global reaproveitada.
	const server = new McpServer(
		{ name: "cloudbeds-britanico", version: "0.1.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);
	registerTools(server, {
		env,
		makeClient: () =>
			new CloudbedsClient({ apiKey: env.CLOUDBEDS_API_KEY, propertyId: env.CLOUDBEDS_PROPERTY_ID }),
	});
	return server;
}

const mcpHandler = createMcpHandler(createServer);

const apiHandler = {
	fetch: withAllowlist((request, bindings, ctx) => mcpHandler(request, bindings, ctx)),
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	// Todo token fica amarrado a esta URL (RFC 8707). Precisa ser a URL exata do deploy.
	resourceMetadata: { resource: env.MCP_RESOURCE },
	// Tokens de acesso curtos; o Claude renova sozinho com o refresh token.
	accessTokenTTL: 3600,
	// Client ID Metadata Document: o Claude se identifica por uma URL publicada
	// pela Anthropic, sem criar um cliente novo no KV a cada conexão (DCR segue
	// disponível como alternativa).
	clientIdMetadataDocumentEnabled: true,
});
