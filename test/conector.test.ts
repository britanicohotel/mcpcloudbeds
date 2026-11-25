import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { addDays, diffDays, eachNight, parseCloudbedsDateTime, shiftLastYear, todayIn } from "../src/analytics/dates";
import { extractNights, kpis, onBooksAt } from "../src/analytics/metrics";
import { BudgetExceededError, CloudbedsClient, CloudbedsError, MISSING_KEY_MESSAGE } from "../src/cloudbeds/client";
import { withAllowlist } from "../src/auth/gate";
import { isAllowed } from "../src/auth/utils";
import { maskEmail, maskPhone } from "../src/privacy";
import { registerTools } from "../src/tools/register";
import { fakeCloudbeds, PLANTED_PII, res } from "./fake-cloudbeds";

const ENV = {
	HOTEL_TIMEZONE: "America/Sao_Paulo",
	MAX_PERIOD_DAYS: "62",
	CLOUDBEDS_PROPERTY_ID: "7830",
} as unknown as Env;

const JULY_2026 = [
	res("A", "2026-07-10", 2, 500),
	res("B", "2026-06-30", 3, 400, { sourceName: "WhatsApp", roomType: "Standard" }),
	res("C", "2026-07-30", 4, 600),
	res("D", "2026-07-15", 2, 500, { status: "canceled", dateCancelled: "2026-07-01 10:00:00" }),
	res("E", "2026-07-20", 1, 300, { status: "no_show" }),
	// Ano anterior (dia da semana: −364 → 2025-07-02 a 2025-08-01)
	res("F", "2025-07-05", 3, 450),
];

// SUPOSIÇÃO: ver ESTADO.md — dateCancelled preenchido em toda reserva cancelada.
const PACE = [
	res("P1", "2027-01-12", 2, 700, { status: "confirmed", dateCreated: "2026-10-01 10:00:00" }),
	res("P2", "2027-01-14", 2, 700, { status: "canceled", dateCreated: "2026-10-01 10:00:00", dateCancelled: "2026-11-01 10:00:00" }),
	res("L1", "2026-01-12", 2, 650, { dateCreated: "2025-10-01 10:00:00" }),
	res("L2", "2026-01-15", 1, 600, { dateCreated: "2025-12-15 10:00:00" }),
	res("L3", "2026-01-18", 2, 500, { status: "canceled", dateCreated: "2025-09-01 10:00:00", dateCancelled: "2025-12-01 10:00:00" }),
	res("L4", "2026-01-20", 1, 300, { status: "no_show", dateCreated: "2025-10-10 10:00:00" }),
];

async function connect(reservations = JULY_2026, makeClient?: (fake: ReturnType<typeof fakeCloudbeds>) => CloudbedsClient) {
	const fake = fakeCloudbeds(reservations);
	const server = new McpServer({ name: "teste", version: "0" });
	registerTools(server, { env: ENV, makeClient: makeClient ? () => makeClient(fake) : fake.makeClient });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: "teste", version: "0" });
	await client.connect(b);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
		const text = r.content[0]!.text;
		return { text, isError: !!r.isError, json: () => JSON.parse(text) };
	};
	return { client, call, fake };
}

describe("datas", () => {
	it("compara pelo dia da semana recuando 364 dias", () => {
		expect(shiftLastYear("2026-07-01", "dia_da_semana")).toBe("2025-07-02");
		const wd = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
		expect(wd("2026-07-01")).toBe(wd("2025-07-02"));
	});
	it("compara pela data do calendário, com 29/02 virando 28/02", () => {
		expect(shiftLastYear("2028-02-29", "data")).toBe("2027-02-28");
		expect(shiftLastYear("2026-07-01", "data")).toBe("2025-07-01");
	});
	it("conta noites e dias", () => {
		expect(eachNight("2026-07-30", "2026-08-02")).toEqual(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
		expect(diffDays("2026-01-01", "2026-12-31")).toBe(364);
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
	});
	it("lê data local da Cloudbeds como UTC−3", () => {
		expect(parseCloudbedsDateTime("2026-11-24 21:00:00", false)).toBe(Date.parse("2026-11-25T00:00:00Z"));
		expect(parseCloudbedsDateTime("2026-11-24 21:00:00", true)).toBe(Date.parse("2026-11-24T21:00:00Z"));
	});
	it("hoje no fuso do hotel vira o dia às 03:00 UTC", () => {
		expect(todayIn("America/Sao_Paulo", new Date("2026-11-25T02:59:00Z"))).toBe("2026-11-24");
		expect(todayIn("America/Sao_Paulo", new Date("2026-11-25T03:00:00Z"))).toBe("2026-11-25");
	});
});

describe("métricas", () => {
	it("recorta as noites no período e exclui cancelada e no-show", () => {
		const { nights, diagnostics } = extractNights(JULY_2026, { start: "2026-07-01", end: "2026-07-31" });
		expect(nights.map((n) => `${n.reservationID}:${n.date}`).sort()).toEqual([
			"A:2026-07-10", "A:2026-07-11", "B:2026-07-01", "B:2026-07-02", "C:2026-07-30", "C:2026-07-31",
		]);
		expect(diagnostics.reservas_excluidas_por_status).toBe(2);
		expect(kpis(nights, 21, 31)).toEqual({
			room_nights: 6, receita: 3000, ocupacao_pct: 0.9, adr: 500, revpar: 4.61, reservas: 3,
		});
	});
	it("reconstrói a carteira numa data base", () => {
		const asOf = Date.parse("2025-11-25T12:00:00Z");
		const on = PACE.filter((r) => onBooksAt(r, asOf)).map((r) => r.reservationID);
		// L2 criada depois; L3 cancelada depois (estava na carteira); P* criadas depois.
		expect(on.sort()).toEqual(["L1", "L3", "L4"]);
	});
});

describe("cliente Cloudbeds", () => {
	it("manda a chave e a propriedade em toda chamada", async () => {
		const fake = fakeCloudbeds([]);
		await fake.makeClient().classic("getRooms");
		const c = fake.calls[0]!;
		expect(c.headers["x-api-key"]).toBe("cbat_TESTE");
		expect(c.headers["X-PROPERTY-ID"]).toBe("7830");
		expect(c.url.searchParams.get("propertyID")).toBe("7830");
		expect(c.url.origin + c.url.pathname).toBe("https://api.cloudbeds.com/api/v1.3/getRooms");
	});
	it("transforma success:false em erro, sem a chave na mensagem", async () => {
		const fake = fakeCloudbeds([]);
		const err = (await fake.makeClient().classic("getReservation", { reservationID: "X" }).catch((e: unknown) => e)) as CloudbedsError;
		expect(err).toBeInstanceOf(CloudbedsError);
		expect(String(err.message)).toContain("Reservation not found");
		expect(String(err.message)).not.toContain("cbat_");
	});
	it("para no orçamento de chamadas antes do teto do plano gratuito", async () => {
		const fake = fakeCloudbeds([]);
		const client = new CloudbedsClient({ apiKey: "k", propertyId: "1", fetchImpl: fake.fetchImpl, budget: 2, sleep: async () => {} });
		await client.classic("getRooms");
		await client.classic("getRooms");
		await expect(client.classic("getRooms")).rejects.toBeInstanceOf(BudgetExceededError);
		expect(fake.calls).toHaveLength(2);
	});
});

describe("acesso", () => {
	it("só aceita logins da allowlist, sem diferenciar maiúsculas", () => {
		expect(isAllowed("NinoBritanico", "ninobritanico, outra")).toBe(true);
		expect(isAllowed("intruso", "ninobritanico")).toBe(false);
		expect(isAllowed("qualquer", "")).toBe(false);
		expect(isAllowed(undefined, "ninobritanico")).toBe(false);
	});

	describe("barreira por chamada em /mcp (props do token em ctx.props)", () => {
		const env = { ALLOWED_GITHUB_LOGINS: "britanicohotel" } as unknown as Env;
		const req = new Request("https://exemplo.test/mcp", { method: "POST" });
		// O workers-oauth-provider grava as props decifradas em ctx.props antes do apiHandler.
		const ctxCom = (props: unknown) => ({ props }) as unknown as ExecutionContext;
		const gate = () => {
			let chamadas = 0;
			const handler = withAllowlist(() => {
				chamadas += 1;
				return new Response("ok");
			});
			return { handler, chamadas: () => chamadas };
		};

		it("login da allowlist chega ao servidor MCP", async () => {
			const g = gate();
			const r = await g.handler(req, env, ctxCom({ login: "BritanicoHotel", name: null }));
			expect(r.status).toBe(200);
			expect(g.chamadas()).toBe(1);
		});
		it("login fora da allowlist recebe 403 sem chegar ao servidor MCP", async () => {
			const g = gate();
			const r = await g.handler(req, env, ctxCom({ login: "intruso", name: null }));
			expect(r.status).toBe(403);
			expect(g.chamadas()).toBe(0);
		});
		it("token sem props recebe 403", async () => {
			const g = gate();
			expect((await g.handler(req, env, ctxCom(undefined))).status).toBe(403);
			expect((await g.handler(req, env, ctxCom({}))).status).toBe(403);
			expect(g.chamadas()).toBe(0);
		});
	});
});

describe("privacidade", () => {
	it("mascara preservando a cauda", () => {
		expect(maskEmail("joana.silva@example.com")).toBe("j***@example.com");
		expect(maskPhone("+55 54 99876-5432")).toBe("***5432");
	});
	it("nenhum dado pessoal plantado sai pela ferramenta de reservas", async () => {
		const { call } = await connect();
		const out = await call("cloudbeds_listar_reservas", { checkin_de: "2026-07-01" });
		expect(out.isError).toBe(false);
		for (const [campo, valor] of Object.entries(PLANTED_PII)) {
			expect(out.text, `vazou ${campo}`).not.toContain(valor);
		}
		expect(out.text).not.toContain("campoNovoQueACloudbedsInventou");
		const r = out.json().reservas[0];
		expect(r.guestName).toBe("Joana Silva");
		expect(r.hospedes[0]).toMatchObject({ guestFirstName: "Joana", email: "j***@example.com", telefone: "***5432" });
	});
});

describe("servidor MCP", () => {
	it("expõe as ferramentas, todas marcadas como somente leitura", async () => {
		const { client } = await connect();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"cloudbeds_desempenho_periodo",
			"cloudbeds_detalhe_reserva",
			"cloudbeds_disponibilidade_venda",
			"cloudbeds_insights_consulta",
			"cloudbeds_insights_status",
			"cloudbeds_listar_reservas",
			"cloudbeds_movimento_do_dia",
			"cloudbeds_origens",
			"cloudbeds_pace",
			"cloudbeds_tarifas_disponibilidade",
			"cloudbeds_visao_geral_hotel",
		]);
		for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
	});

	it("desempenho de julho com o ano anterior", async () => {
		const { call, fake } = await connect();
		const out = await call("cloudbeds_desempenho_periodo", {
			inicio: "2026-07-01", fim: "2026-07-31", agrupar_por: ["source", "roomType"],
		});
		expect(out.isError, out.text).toBe(false);
		const j = out.json();
		expect(j.quartos_fisicos).toBe(21);
		expect(j.atual.indicadores).toMatchObject({ room_nights: 6, receita: 3000, adr: 500 });
		expect(j.atual.quebras.source["WhatsApp"]).toMatchObject({ room_nights: 2, receita: 800 });
		expect(j.ano_anterior.periodo).toMatchObject({ inicio: "2025-07-02", fim: "2025-08-01" });
		expect(j.ano_anterior.indicadores).toMatchObject({ room_nights: 3, receita: 1350, adr: 450 });
		expect(j.variacao.receita).toBe(122.2);
		expect(j.variacao.ocupacao_pct).toBe(0.4); // pontos percentuais: 0.9 − 0.4 (arredondados)
		// getRooms + 1 página atual + 1 página do ano anterior
		expect(fake.calls).toHaveLength(3);
		const wr = fake.calls[1]!.url.searchParams;
		expect(wr.get("reservationCheckOutFrom")).toBe("2026-07-02");
		expect(wr.get("reservationCheckOutTo")).toBe("2026-08-15");
		expect(wr.get("excludeStatuses")).toBe("canceled");
	});

	it("pace contra a mesma antecedência do ano anterior", async () => {
		const { call } = await connect(PACE);
		const out = await call("cloudbeds_pace", { inicio: "2027-01-10", fim: "2027-01-20" });
		expect(out.isError, out.text).toBe(false);
		const j = out.json();
		// A data base é "agora"; P1 já existe e P2 já foi cancelada.
		expect(j.carteira_atual.indicadores).toMatchObject({ room_nights: 2, receita: 1400 });
		expect(j.ano_anterior_resultado_final).toMatchObject({ room_nights: 3, receita: 1900 });
	});

	it("recusa período maior que o teto, com instrução de como dividir", async () => {
		const { call, fake } = await connect();
		const out = await call("cloudbeds_desempenho_periodo", { inicio: "2026-01-01", fim: "2026-12-31" });
		expect(out.isError).toBe(true);
		expect(out.text).toContain("teto de 62");
		expect(fake.calls).toHaveLength(0);
	});

	it("insights indisponível vira status, não erro", async () => {
		const { call } = await connect();
		const out = await call("cloudbeds_insights_status");
		expect(out.isError).toBe(false);
		expect(out.json().health.disponivel).toBe(false);
	});

	it("erro da Cloudbeds chega ao Claude como erro de ferramenta legível", async () => {
		const { call } = await connect();
		const out = await call("cloudbeds_detalhe_reserva", { reservation_id: "X" });
		expect(out.isError).toBe(true);
		expect(out.text).toContain("Reservation not found");
	});
});

describe("sem a chave da Cloudbeds", () => {
	// Argumentos válidos para cada ferramenta: o erro tem de vir da chave, não da validação.
	// Ferramenta nova sem entrada aqui faz o teste falhar.
	const VALID_ARGS: Record<string, Record<string, unknown>> = {
		cloudbeds_desempenho_periodo: { inicio: "2026-07-01", fim: "2026-07-31" },
		cloudbeds_detalhe_reserva: { reservation_id: "X" },
		cloudbeds_disponibilidade_venda: { checkin: "2026-12-01", checkout: "2026-12-03" },
		cloudbeds_insights_consulta: { consulta: { dataset_id: 1, columns: [] } },
		cloudbeds_insights_status: {},
		cloudbeds_listar_reservas: {},
		cloudbeds_movimento_do_dia: {},
		cloudbeds_origens: {},
		cloudbeds_pace: { inicio: "2027-01-10", fim: "2027-01-20" },
		cloudbeds_tarifas_disponibilidade: { inicio: "2026-12-01", fim: "2026-12-03" },
		cloudbeds_visao_geral_hotel: {},
	};

	// undefined é como o segredo ausente chega no Worker; vazio e espaços também contam.
	for (const [rotulo, chave] of [["ausente", undefined], ["vazia", ""], ["só espaços", "   "]] as const) {
		it(`chave ${rotulo}: toda ferramenta responde '${MISSING_KEY_MESSAGE}' sem chamar a Cloudbeds`, async () => {
			const { client, call, fake } = await connect(JULY_2026, (f) =>
				new CloudbedsClient({ apiKey: chave, propertyId: "7830", fetchImpl: f.fetchImpl, sleep: async () => {} }),
			);
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(VALID_ARGS).sort());
			for (const t of tools) {
				const out = await call(t.name, VALID_ARGS[t.name]);
				expect(out.isError, t.name).toBe(true);
				expect(out.text, t.name).toContain(MISSING_KEY_MESSAGE);
			}
			expect(fake.calls).toHaveLength(0);
		});
	}
});
