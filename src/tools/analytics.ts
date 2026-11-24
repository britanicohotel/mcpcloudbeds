import type { CloudbedsClient } from "../cloudbeds/client";
import {
	getRooms,
	paginate,
	physicalRooms,
	type ReservationWithRates,
} from "../cloudbeds/endpoints";
import { addDays, assertIsoDate, diffDays, shiftLastYear, type ComparisonMode } from "../analytics/dates";
import { DEFINITIONS, extractNights, groupBy, kpis, variation } from "../analytics/metrics";

/** Estadias mais longas que isto, que começam no período e terminam depois, ficam de fora. */
export const MAX_LOS = 14;

export type GroupKey = "source" | "roomType" | "date" | "month" | "weekday";

export function validatePeriod(start: string, end: string, maxDays: number): number {
	assertIsoDate(start, "início");
	assertIsoDate(end, "fim");
	const nights = diffDays(start, end) + 1;
	if (nights < 1) throw new Error("o fim do período precisa ser igual ou posterior ao início");
	if (nights > maxDays) {
		throw new Error(
			`período de ${nights} noites passa do teto de ${maxDays}. ` +
				"Divida em períodos menores (por exemplo, mês a mês) e some os resultados.",
		);
	}
	return nights;
}

/**
 * Reservas com noites dentro de [start, end]. A API com diárias detalhadas só
 * filtra por check-out, então pedimos check-outs de start+1 até end+1+MAX_LOS
 * e recortamos as noites depois.
 */
export async function fetchStays(
	client: CloudbedsClient,
	start: string,
	end: string,
	includeCanceled: boolean,
): Promise<{ reservations: ReservationWithRates[]; pages: number; total: number | null }> {
	const { items, pages, total } = await paginate<ReservationWithRates>(
		client,
		"getReservationsWithRateDetails",
		{
			reservationCheckOutFrom: addDays(start, 1),
			reservationCheckOutTo: addDays(end, 1 + MAX_LOS),
			excludeStatuses: includeCanceled ? undefined : "canceled",
		},
		Math.max(1, client.callsRemaining),
	);
	if (total !== null && items.length < total) {
		throw new Error(
			`a Cloudbeds tem ${total} reservas nesse recorte e só ${items.length} couberam no limite de chamadas. Use um período menor.`,
		);
	}
	return { reservations: items, pages, total };
}

export async function roomCount(client: CloudbedsClient, override?: number): Promise<number> {
	if (override && override > 0) return override;
	const rooms = physicalRooms(await getRooms(client));
	if (rooms.length === 0) throw new Error("getRooms não devolveu quartos físicos; informe `quartos` manualmente");
	return rooms.length;
}

export async function performance(
	client: CloudbedsClient,
	args: {
		start: string;
		end: string;
		compare: boolean;
		mode: ComparisonMode;
		groupBy: GroupKey[];
		rooms?: number;
		maxDays: number;
	},
) {
	const nightsInPeriod = validatePeriod(args.start, args.end, args.maxDays);
	const rooms = await roomCount(client, args.rooms);

	const cur = await fetchStays(client, args.start, args.end, false);
	const curNights = extractNights(cur.reservations, { start: args.start, end: args.end });
	const atual = {
		periodo: { inicio: args.start, fim: args.end, noites: nightsInPeriod },
		indicadores: kpis(curNights.nights, rooms, nightsInPeriod),
		quebras: Object.fromEntries(
			args.groupBy.map((g) => [g, groupBy(curNights.nights, g, rooms, nightsInPeriod)]),
		),
		diagnostico: curNights.diagnostics,
	};

	let anoAnterior: unknown = null;
	let variacao: unknown = null;
	if (args.compare) {
		const lyStart = shiftLastYear(args.start, args.mode);
		const lyEnd = shiftLastYear(args.end, args.mode);
		const lyNightsInPeriod = diffDays(lyStart, lyEnd) + 1;
		const ly = await fetchStays(client, lyStart, lyEnd, false);
		const lyNights = extractNights(ly.reservations, { start: lyStart, end: lyEnd });
		const lyKpis = kpis(lyNights.nights, rooms, lyNightsInPeriod);
		anoAnterior = {
			periodo: { inicio: lyStart, fim: lyEnd, noites: lyNightsInPeriod, modo: args.mode },
			indicadores: lyKpis,
			quebras: Object.fromEntries(
				args.groupBy.map((g) => [g, groupBy(lyNights.nights, g, rooms, lyNightsInPeriod)]),
			),
			diagnostico: lyNights.diagnostics,
		};
		variacao = variation(atual.indicadores, lyKpis);
	}

	return {
		quartos_fisicos: rooms,
		atual,
		ano_anterior: anoAnterior,
		variacao,
		definicoes: DEFINITIONS,
		observacoes: [
			"Quartos físicos contados pelo cadastro atual; quarto bloqueado ou desativado no passado não é descontado da capacidade.",
			`Estadias com mais de ${MAX_LOS} noites além do fim do período podem ficar de fora.`,
			"Reservas canceladas e no-show não entram.",
		],
		chamadas_cloudbeds: client.callsUsed,
	};
}

export async function pace(
	client: CloudbedsClient,
	args: { start: string; end: string; asOf: number; mode: ComparisonMode; rooms?: number; maxDays: number; groupBy: GroupKey[] },
) {
	const nightsInPeriod = validatePeriod(args.start, args.end, args.maxDays);
	const rooms = await roomCount(client, args.rooms);

	const cur = await fetchStays(client, args.start, args.end, true);
	const curNights = extractNights(cur.reservations, { start: args.start, end: args.end, asOf: args.asOf });

	const lyStart = shiftLastYear(args.start, args.mode);
	const lyEnd = shiftLastYear(args.end, args.mode);
	const lyNightsInPeriod = diffDays(lyStart, lyEnd) + 1;
	const lyAsOf = args.mode === "dia_da_semana" ? args.asOf - 364 * 86_400_000 : (() => {
		const d = new Date(args.asOf);
		d.setUTCFullYear(d.getUTCFullYear() - 1);
		return d.getTime();
	})();

	const ly = await fetchStays(client, lyStart, lyEnd, true);
	const lyAtDate = extractNights(ly.reservations, { start: lyStart, end: lyEnd, asOf: lyAsOf });
	const lyFinal = extractNights(ly.reservations, { start: lyStart, end: lyEnd });

	const curK = kpis(curNights.nights, rooms, nightsInPeriod);
	const lyK = kpis(lyAtDate.nights, rooms, lyNightsInPeriod);
	const lyFinalK = kpis(lyFinal.nights, rooms, lyNightsInPeriod);

	return {
		quartos_fisicos: rooms,
		periodo: { inicio: args.start, fim: args.end, noites: nightsInPeriod },
		data_base: new Date(args.asOf).toISOString(),
		carteira_atual: {
			indicadores: curK,
			quebras: Object.fromEntries(args.groupBy.map((g) => [g, groupBy(curNights.nights, g, rooms, nightsInPeriod)])),
		},
		ano_anterior_na_mesma_antecedencia: {
			periodo: { inicio: lyStart, fim: lyEnd, modo: args.mode },
			data_base: new Date(lyAsOf).toISOString(),
			indicadores: lyK,
			quebras: Object.fromEntries(args.groupBy.map((g) => [g, groupBy(lyAtDate.nights, g, rooms, lyNightsInPeriod)])),
		},
		ano_anterior_resultado_final: lyFinalK,
		variacao_vs_mesma_antecedencia: variation(curK, lyK),
		pickup_que_o_ano_anterior_ainda_teve: {
			room_nights: lyFinalK.room_nights - lyK.room_nights,
			receita: Math.round((lyFinalK.receita - lyK.receita) * 100) / 100,
		},
		diagnostico: { atual: curNights.diagnostics, ano_anterior: lyAtDate.diagnostics },
		definicoes: DEFINITIONS,
		observacoes: [
			"A carteira do ano anterior é reconstruída pela data de criação e de cancelamento de cada reserva.",
			"Os valores das diárias são os de hoje: alteração de tarifa, datas ou quartos feita depois da data base não é desfeita.",
			"Para o pace oficial, compare com o relatório 'Pace - Variação ano a ano' da Cloudbeds.",
		],
		chamadas_cloudbeds: client.callsUsed,
	};
}
