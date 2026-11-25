/**
 * Segredos que podem legitimamente faltar no Worker, declarados à mão.
 *
 * Eles ficam fora de `secrets.required` no wrangler.jsonc, porque essa lista
 * controla ao mesmo tempo a trava do deploy, a leitura do `.dev.vars` e os
 * tipos gerados. Por isso o `npm run cf-typegen` não os põe no `Env`, e eles
 * entram aqui como opcionais: o código é obrigado a tratar a ausência.
 *
 * O cf-typegen só escreve `worker-configuration.d.ts`; este arquivo não é
 * gerado e não pode ser sobrescrito por ele.
 */
interface CloudbedsOptionalSecrets {
	/** Chave da Cloudbeds só deste conector (prefixo cbat_). Ausente até a Fase 5. */
	CLOUDBEDS_API_KEY?: string;
}

// `Env` global (usado por ExportedHandler<Env>) e `Cloudflare.Env` (o tipo de
// `env` importado de "cloudflare:workers") são interfaces distintas.
interface Env extends CloudbedsOptionalSecrets {}
declare namespace Cloudflare {
	interface Env extends CloudbedsOptionalSecrets {}
}
