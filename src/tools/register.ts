import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BudgetExceededError, CloudbedsClient, CloudbedsError } from "../cloudbeds/client";
import {
	getAvailableRoomTypes,
	getHotelDetails,
	getRatePlans,
	getReservation,
	getRooms,
	getSources,
	insightsDatasets,
	insightsHealth,
	insightsQuery,
	insightsStockReports,
	physicalRooms,
} from "../cloudbeds/endpoints";
import { addDays, assertIsoDate, diffDays, todayIn } from "../analytics/dates";
import { sanitizeReservation } from "../privacy";
import { pace, performance } from "./analytics";

const MAX_OUTPUT_CHARS = 90_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export interface ToolContext {
	env: Env;
	/** Fábrica injetável: nos testes, devolve um cliente com fetch simulado. */
	makeClient: () => CloudbedsClient;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolResult {
	let text = JSON.stringify(payload, null, 1);
	if (text.length > MAX_OUTPUT_CHARS) {
		text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [resposta truncada em ${MAX_OUTPUT_CHARS} caracteres — refine o filtro ou use paginação]`;
	}
	return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
	let text: string;
	if (err instanceof CloudbedsError) {
		text = `${err.message}${err.requestId ? ` (X-Request-ID ${err.requestId})` : ""}`;
		if (err.status === 401 || err.status === 403) {
			text += " — confira se a chave da Cloudbeds tem o escopo deste endpoint.";
		}
	} else if (err instanceof BudgetExceededError) {
		text = err.message;
	} else {
		text = `Erro: ${(err as Error).message ?? String(err)}`;
	}
	return { content: [{ type: "text", text }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return ok(await fn());
	} catch (err) {
		return fail(err);
	}
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD");
const STATUSES = ["not_confirmed", "confirmed", "canceled", "checked_in", "checked_out", "no_show"] as const;
const groupKeys = z.enum(["source", "roomType", "month", "weekday", "date"]);
const comparison = z
	.enum(["dia_da_semana", "data"])
	.default("dia_da_semana")
	.describe("dia_da_semana: recua 364 dias (seg com seg). data: mesma data do calendário.");

export function registerTools(server: McpServer, ctx: ToolContext): void {
	const tz = ctx.env.HOTEL_TIMEZONE || "America/Sao_Paulo";
	const maxDays = Number(ctx.env.MAX_PERIOD_DAYS) || 62;

	server.registerTool(
		"cloudbeds_visao_geral_hotel",
		{
			title: "Visão geral do hotel",
			description:
				"Dados da propriedade na Cloudbeds (nome, moeda, fuso) e os quartos físicos por tipo. Use primeiro, para saber a capacidade que entra nos cálculos de ocupação.",
			annotations: READ_ONLY,
		},
		() =>
			run(async () => {
				const client = ctx.makeClient();
				const [hotel, rooms] = [await getHotelDetails(client), await getRooms(client)];
				const physical = physicalRooms(rooms);
				const byType: Record<string, string[]> = {};
				for (const r of physical) (byType[r.roomTypeName ?? "Sem tipo"] ??= []).push(r.roomName);
				const h = hotel.data ?? {};
				return {
					propriedade: {
						propertyID: h.propertyID,
						nome: h.propertyName,
						moeda: (h.propertyCurrency as Record<string, unknown> | undefined)?.currencyCode ?? h.propertyCurrency,
						fuso: h.propertyTimezone,
					},
					quartos_fisicos: physical.length,
					quartos_por_tipo: byType,
					quartos_virtuais_ou_arquivados: rooms.length - physical.length,
					hoje_no_hotel: todayIn(tz),
				};
			}),
	);

	server.registerTool(
		"cloudbeds_listar_reservas",
		{
			title: "Listar reservas",
			description:
				"Lista reservas com filtros de check-in, check-out, data de criação e status. Dados pessoais minimizados (e-mail e telefone mascarados; sem documento, endereço ou cartão). Máximo de 100 por página.",
			inputSchema: z.object({
				checkin_de: isoDate.optional(),
				checkin_ate: isoDate.optional(),
				checkout_de: isoDate.optional(),
				checkout_ate: isoDate.optional(),
				criada_de: isoDate.optional().describe("data de criação da reserva, início"),
				criada_ate: isoDate.optional(),
				status: z.enum(STATUSES).optional(),
				pagina: z.number().int().min(1).default(1),
				por_pagina: z.number().int().min(1).max(100).default(50),
			}),
			annotations: READ_ONLY,
		},
		(a) =>
			run(async () => {
				const client = ctx.makeClient();
				const res = await client.classic<{ data: Record<string, unknown>[]; count?: number; total?: number }>(
					"getReservations",
					{
						checkInFrom: a.checkin_de,
						checkInTo: a.checkin_ate,
						checkOutFrom: a.checkout_de,
						checkOutTo: a.checkout_ate,
						resultsFrom: a.criada_de ? `${a.criada_de} 00:00:00` : undefined,
						resultsTo: a.criada_ate ? `${a.criada_ate} 23:59:59` : undefined,
						status: a.status,
						includeAllRooms: true,
						pageNumber: a.pagina,
						pageSize: a.por_pagina,
					},
				);
				return {
					total: res.total ?? null,
					pagina: a.pagina,
					nesta_pagina: res.data?.length ?? 0,
					reservas: (res.data ?? []).map(sanitizeReservation),
				};
			}),
	);

	server.registerTool(
		"cloudbeds_detalhe_reserva",
		{
			title: "Detalhe de uma reserva",
			description:
				"Uma reserva pelo ID: status, datas, quartos, valores, saldo, origem e hóspedes (dados pessoais minimizados).",
			inputSchema: z.object({ reservation_id: z.string().min(1) }),
			annotations: READ_ONLY,
		},
		(a) =>
			run(async () => {
				const res = await getReservation(ctx.makeClient(), a.reservation_id);
				return sanitizeReservation(res.data ?? {});
			}),
	);

	server.registerTool(
		"cloudbeds_movimento_do_dia",
		{
			title: "Chegadas, saídas e hospedados",
			description: "Chegadas e saídas de uma data (padrão: hoje no fuso do hotel) e reservas hospedadas agora.",
			inputSchema: z.object({ data: isoDate.optional() }),
			annotations: READ_ONLY,
		},
		(a) =>
			run(async () => {
				const client = ctx.makeClient();
				const day = a.data ?? todayIn(tz);
				const q = { includeAllRooms: true, pageSize: 100 };
				type L = { data: Record<string, unknown>[]; total?: number };
				const arrivals = await client.classic<L>("getReservations", { ...q, checkInFrom: day, checkInTo: day });
				const departures = await client.classic<L>("getReservations", { ...q, checkOutFrom: day, checkOutTo: day });
				const inHouse = await client.classic<L>("getReservations", { ...q, status: "checked_in" });
				const clean = (l: L) =>
					(l.data ?? []).filter((r) => r.status !== "canceled").map(sanitizeReservation);
				return { data: day, chegadas: clean(arrivals), saidas: clean(departures), hospedados_agora: clean(inHouse) };
			}),
	);

	server.registerTool(
		"cloudbeds_tarifas_disponibilidade",
		{
			title: "Tarifas e disponibilidade",
			description:
				"Tarifa diária, quartos disponíveis e restrições (min/max LOS, CTA/CTD, bloqueio) por plano tarifário e tipo de quarto. Período de até 31 noites.",
			inputSchema: z.object({
				inicio: isoDate.describe("primeira noite"),
				fim: isoDate.describe("última noite"),
				filtro_plano: z
					.string()
					.optional()
					.describe("trecho do nome do plano (ex.: 'Base'); vazio traz todos"),
				adultos: z.number().int().min(1).max(6).optional(),
			}),
			annotations: READ_ONLY,
		},
		(a) =>
			run(async () => {
				assertIsoDate(a.inicio, "início");
				assertIsoDate(a.fim, "fim");
				const nights = diffDays(a.inicio, a.fim) + 1;
				if (nights < 1 || nights > 31) throw new Error("use um período de 1 a 31 noites");
				const res = await getRatePlans(ctx.makeClient(), {
					startDate: a.inicio,
					endDate: addDays(a.fim, 1), // a API trata endDate como check-out
					adults: a.adultos,
				});
				const f = a.filtro_plano?.toLowerCase();
				const plans = (res.data ?? []).filter((p) => {
					if (!f) return true;
					const names = `${p.ratePlanNamePrivate ?? ""} ${p.ratePlanNamePublic ?? ""}`.toLowerCase();
					return names.includes(f);
				});
				return {
					periodo: { inicio: a.inicio, fim: a.fim, noites: nights },
					planos: plans.map((p) => ({
						tipo_quarto: p.roomTypeName,
						plano: p.ratePlanNamePrivate ?? p.ratePlanNamePublic ?? "(tarifa base)",
						derivado: p.isDerived ? { de: p.parentRatePlanNamePrivate, tipo: p.derivedType, valor: p.derivedValue } : false,
						total_periodo: p.totalRate,
						dias: Array.isArray(p.roomRateDetailed)
							? (p.roomRateDetailed as Record<string, unknown>[]).map((d) => ({
									data: d.date,
									tarifa: d.rateBase,
									disponiveis: d.roomsAvailable,
									min_noites: d.minLos,
									max_noites: d.maxLos,
									cta: d.closedToArrival,
									ctd: d.closedToDeparture,
									bloqueado: d.blocked,
								}))
							: undefined,
					})),
				};
			}),
	);

	server.registerTool(
		"cloudbeds_desempenho_periodo",
		{
			title: "Desempenho do período (com ano anterior)",
			description:
				`Ocupação, ADR, RevPAR, receita de diárias e room nights de um período (até ${maxDays} noites), com comparação opcional ao mesmo período do ano anterior e quebras por origem, tipo de quarto, mês, dia da semana ou data. Para períodos longos, chame mês a mês. Os números de 'quebras.date' servem para gráficos diários.`,
			inputSchema: z.object({
				inicio: isoDate.describe("primeira noite"),
				fim: isoDate.describe("última noite"),
				comparar_ano_anterior: z.boolean().default(true),
				modo_comparacao: comparison,
				agrupar_por: z.array(groupKeys).default(["source"]),
				quartos: z.number().int().min(1).optional().describe("sobrescreve a capacidade (padrão: quartos físicos do cadastro)"),
			}),
			annotations: READ_ONLY,
		},
		(a) =>
			run(() =>
				performance(ctx.makeClient(), {
					start: a.inicio,
					end: a.fim,
					compare: a.comparar_ano_anterior,
					mode: a.modo_comparacao,
					groupBy: a.agrupar_por,
					rooms: a.quartos,
					maxDays,
				}),
			),
	);

	server.registerTool(
		"cloudbeds_pace",
		{
			title: "Pace / carteira futura vs ano anterior",
			description:
				`Carteira (on the books) de um período futuro hoje, comparada à carteira do mesmo período do ano anterior na mesma antecedência, mais o resultado final do ano anterior e o pickup que ele ainda teve. Até ${maxDays} noites por chamada.`,
			inputSchema: z.object({
				inicio: isoDate,
				fim: isoDate,
				modo_comparacao: comparison,
				agrupar_por: z.array(groupKeys).default(["month"]),
				quartos: z.number().int().min(1).optional(),
			}),
			annotations: READ_ONLY,
		},
		(a) =>
			run(() =>
				pace(ctx.makeClient(), {
					start: a.inicio,
					end: a.fim,
					asOf: Date.now(),
					mode: a.modo_comparacao,
					groupBy: a.agrupar_por,
					rooms: a.quartos,
					maxDays,
				}),
			),
	);

	server.registerTool(
		"cloudbeds_origens",
		{
			title: "Origens / canais",
			description: "Origens de reserva cadastradas na Cloudbeds (canais, OTAs, direto).",
			annotations: READ_ONLY,
		},
		() => run(async () => (await getSources(ctx.makeClient())).data),
	);

	server.registerTool(
		"cloudbeds_disponibilidade_venda",
		{
			title: "Disponibilidade para venda",
			description: "Tipos de quarto disponíveis para uma estadia, com preço, como o motor de reservas veria.",
			inputSchema: z.object({
				checkin: isoDate,
				checkout: isoDate,
				adultos: z.number().int().min(1).max(6).default(2),
				criancas: z.number().int().min(0).max(6).default(0),
			}),
			annotations: READ_ONLY,
		},
		(a) =>
			run(async () =>
				(
					await getAvailableRoomTypes(ctx.makeClient(), {
						startDate: a.checkin,
						endDate: a.checkout,
						adults: a.adultos,
						children: a.criancas,
					})
				).data,
			),
	);

	server.registerTool(
		"cloudbeds_insights_status",
		{
			title: "Cloudbeds Insights: status",
			description:
				"Verifica se o hotel tem acesso à Insights API (relatórios oficiais da Cloudbeds) e lista datasets e relatórios-padrão. Se estiver disponível, prefira-a para relatórios oficiais.",
			annotations: READ_ONLY,
		},
		() =>
			run(async () => {
				const client = ctx.makeClient();
				const attempt = async (fn: () => Promise<unknown>) => {
					try {
						return { disponivel: true, resposta: await fn() };
					} catch (e) {
						return { disponivel: false, erro: (e as Error).message };
					}
				};
				return {
					health: await attempt(() => insightsHealth(client)),
					datasets: await attempt(() => insightsDatasets(client)),
					relatorios_padrao: await attempt(() => insightsStockReports(client)),
				};
			}),
	);

	server.registerTool(
		"cloudbeds_insights_consulta",
		{
			title: "Cloudbeds Insights: consulta",
			description:
				"Envia um ReportQuery à Insights API (POST /datainsights/v1.1/reports/query/data). Campos obrigatórios: dataset_id, columns (cada uma com cdf.column e metrics). property_ids é preenchido automaticamente. Use 'Preview' (100 linhas) para explorar e 'Run' (até 12.000) para o resultado.",
			inputSchema: z.object({
				consulta: z
					.record(z.string(), z.unknown())
					.describe("corpo ReportQuery: dataset_id, columns, group_rows, filters, periods, comparisons, settings"),
				modo: z.enum(["Preview", "Run"]).default("Preview"),
			}),
			annotations: READ_ONLY,
		},
		(a) =>
			run(async () => {
				const client = ctx.makeClient();
				const body = {
					settings: { details: false, totals: true },
					...a.consulta,
					property_ids: [Number(client.propertyId)],
				};
				return insightsQuery(client, body, a.modo);
			}),
	);
}
