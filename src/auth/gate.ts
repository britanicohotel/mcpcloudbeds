import { isAllowed, type Props } from "./utils";

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

/**
 * Segunda barreira da allowlist, conferida a cada chamada a /mcp: tirar um
 * login de ALLOWED_GITHUB_LOGINS corta o acesso na hora, sem esperar o token
 * expirar.
 *
 * As props do token chegam em `ctx.props`: o workers-oauth-provider as decifra
 * e grava ali antes de chamar o apiHandler. Não use `getMcpAuthContext()`
 * aqui. Ele só é preenchido dentro do handler MCP e, neste ponto, devolve
 * undefined; foi assim que a versão anterior barrava todo mundo com 403
 * (descoberto no primeiro login real, em 24/11/2026).
 */
export function withAllowlist(inner: Handler): Handler {
	return (request, env, ctx) => {
		const props = (ctx as ExecutionContext<Partial<Props> | undefined>).props;
		if (!isAllowed(props?.login, env.ALLOWED_GITHUB_LOGINS)) {
			return new Response("forbidden", { status: 403 });
		}
		return inner(request, env, ctx);
	};
}
