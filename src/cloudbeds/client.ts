/**
 * Cliente HTTP da Cloudbeds.
 *
 * Fatos da documentação oficial em que este arquivo se apoia
 * (https://developers.cloudbeds.com/reference/tech-specs):
 *   - base https://api.cloudbeds.com; a API clássica fica em /api/v1.3/<método>
 *   - chave no cabeçalho `x-api-key` (ou Bearer)
 *   - `X-PROPERTY-ID` recomendado em toda chamada (obrigatório na Insights)
 *   - GET/DELETE com query string; POST/PUT clássicos em x-www-form-urlencoded
 *   - limite de 10 requisições/s; toda resposta traz `X-Request-ID`
 *
 * Duas proteções que não vêm da Cloudbeds, vêm do plano gratuito do Workers:
 *   - orçamento de subrequisições por invocação (o teto do plano é 50)
 *   - espaçamento mínimo entre chamadas, para não estourar 10 req/s
 *
 * Este cliente só faz leitura. Não há método POST/PUT para a API clássica aqui
 * de propósito: a escrita, quando vier, entra por uma allowlist própria.
 */

export const API_BASE = "https://api.cloudbeds.com";
const CLASSIC_PREFIX = "/api/v1.3/";

/** Folga abaixo do teto de 50 subrequisições do plano Free. */
export const DEFAULT_SUBREQUEST_BUDGET = 40;
/** 10 req/s documentado; 120 ms dá margem para o relógio do Worker. */
const MIN_INTERVAL_MS = 120;
const TIMEOUT_MS = 20_000;

export class CloudbedsError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly requestId: string | null,
		public readonly endpoint: string,
	) {
		super(message);
		this.name = "CloudbedsError";
	}
}

export class BudgetExceededError extends Error {
	constructor(public readonly budget: number) {
		super(
			`Esta consulta precisaria de mais de ${budget} chamadas à Cloudbeds numa única requisição. ` +
				"Divida o período em partes menores.",
		);
		this.name = "BudgetExceededError";
	}
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface CloudbedsConfig {
	apiKey: string;
	propertyId: string;
	fetchImpl?: typeof fetch;
	budget?: number;
	/** Injetável nos testes para não esperar de verdade. */
	sleep?: (ms: number) => Promise<void>;
}

export class CloudbedsClient {
	private readonly fetchImpl: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly budget: number;
	private used = 0;
	private lastCallAt = 0;

	constructor(private readonly cfg: CloudbedsConfig) {
		if (!cfg.apiKey) throw new Error("CLOUDBEDS_API_KEY não configurada");
		this.fetchImpl = cfg.fetchImpl ?? fetch.bind(globalThis);
		this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.budget = cfg.budget ?? DEFAULT_SUBREQUEST_BUDGET;
	}

	get propertyId(): string {
		return this.cfg.propertyId;
	}

	get callsUsed(): number {
		return this.used;
	}

	get callsRemaining(): number {
		return this.budget - this.used;
	}

	/** GET na API clássica v1.3, ex.: classic("getReservations", {...}). */
	async classic<T = unknown>(method: string, query: Query = {}): Promise<T> {
		const body = await this.request("GET", `${CLASSIC_PREFIX}${method}`, {
			propertyID: this.cfg.propertyId,
			...query,
		});
		// A API clássica responde 200 com { success: false, message } em vários erros.
		if (body && typeof body === "object" && (body as { success?: unknown }).success === false) {
			const msg = (body as { message?: string }).message ?? "erro sem mensagem";
			throw new CloudbedsError(`Cloudbeds recusou ${method}: ${msg}`, 200, null, method);
		}
		return body as T;
	}

	/** Chamada às APIs REST novas (Insights etc.), corpo JSON. */
	async rest<T = unknown>(
		method: "GET" | "POST",
		path: string,
		query: Query = {},
		json?: unknown,
	): Promise<T> {
		return (await this.request(method, path, query, json)) as T;
	}

	private async request(
		method: "GET" | "POST",
		path: string,
		query: Query,
		json?: unknown,
	): Promise<unknown> {
		if (this.used >= this.budget) throw new BudgetExceededError(this.budget);
		this.used += 1;

		const wait = this.lastCallAt + MIN_INTERVAL_MS - Date.now();
		if (this.lastCallAt && wait > 0) await this.sleep(wait);
		this.lastCallAt = Date.now();

		const url = new URL(path, API_BASE);
		for (const [k, v] of Object.entries(query)) {
			if (v === undefined || v === null || v === "") continue;
			url.searchParams.set(k, String(v));
		}

		const headers: Record<string, string> = {
			"x-api-key": this.cfg.apiKey,
			"X-PROPERTY-ID": this.cfg.propertyId,
			accept: "application/json",
		};
		if (json !== undefined) headers["content-type"] = "application/json";

		let res: Response;
		try {
			res = await this.fetchImpl(url.toString(), {
				method,
				headers,
				body: json === undefined ? undefined : JSON.stringify(json),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (err) {
			// Nunca inclui a URL completa: a query pode carregar nome de hóspede.
			throw new CloudbedsError(
				`Falha de rede ao chamar ${path}: ${(err as Error).message}`,
				0,
				null,
				path,
			);
		}

		const requestId = res.headers.get("x-request-id");
		const text = await res.text();
		if (!res.ok) {
			throw new CloudbedsError(
				`Cloudbeds respondeu HTTP ${res.status} em ${path}: ${text.slice(0, 300)}`,
				res.status,
				requestId,
				path,
			);
		}
		try {
			return text ? JSON.parse(text) : null;
		} catch {
			throw new CloudbedsError(
				`Resposta não-JSON em ${path}: ${text.slice(0, 200)}`,
				res.status,
				requestId,
				path,
			);
		}
	}
}
