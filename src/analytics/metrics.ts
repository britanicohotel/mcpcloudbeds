/**
 * Métricas de desempenho calculadas a partir das diárias detalhadas
 * (rooms[].detailedRoomRates de getReservationsWithRateDetails).
 *
 * Definições usadas — ficam também na saída das ferramentas, para que a
 * análise nunca dependa de uma definição implícita:
 *   room nights    noites de quarto vendidas com data dentro do período
 *   receita        soma de detailedRoomRates dessas noites (diária registrada
 *                  na Cloudbeds; sem extras, consumos, taxas ou taxa de serviço)
 *   ocupação       room nights / (quartos físicos × noites do período)
 *   ADR            receita / room nights
 *   RevPAR         receita / (quartos físicos × noites do período)
 */
import type { ReservationWithRates } from "../cloudbeds/endpoints";
import { eachNight, parseCloudbedsDateTime } from "./dates";

export interface NightRecord {
	date: string;
	revenue: number;
	reservationID: string;
	roomType: string;
	source: string;
	hasRate: boolean;
}

export interface PeriodFilter {
	start: string;
	end: string;
	/** Status de reserva excluídos. Padrão: canceled e no_show. */
	excludeStatuses?: string[];
	/** Se definido, reconstrói a carteira "como estava" neste instante (epoch ms). */
	asOf?: number;
}

const DEFAULT_EXCLUDED = ["canceled", "no_show"];

function num(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : 0;
}

export function sourceLabel(r: ReservationWithRates): string {
	return r.sourceName || r.source?.name || "Sem origem";
}

/** A reserva estava na carteira no instante `asOf`? */
export function onBooksAt(r: ReservationWithRates, asOf: number): boolean {
	const created =
		parseCloudbedsDateTime(r.dateCreatedUTC, true) ?? parseCloudbedsDateTime(r.dateCreated, false);
	if (created === null || created > asOf) return false;
	if (r.status === "canceled") {
		const cancelled = parseCloudbedsDateTime(r.dateCancelled, false);
		// Cancelada sem data de cancelamento: não dá para saber quando saiu — fica fora.
		if (cancelled === null) return false;
		return cancelled > asOf;
	}
	return true;
}

export function extractNights(
	reservations: ReservationWithRates[],
	filter: PeriodFilter,
): { nights: NightRecord[]; diagnostics: Record<string, number> } {
	const excluded = new Set(filter.asOf !== undefined ? [] : (filter.excludeStatuses ?? DEFAULT_EXCLUDED));
	const nights: NightRecord[] = [];
	const diagnostics = {
		reservas_lidas: reservations.length,
		reservas_excluidas_por_status: 0,
		reservas_fora_da_carteira_na_data_base: 0,
		quartos_cancelados_ignorados: 0,
		noites_sem_tarifa_detalhada: 0,
	};

	for (const r of reservations) {
		if (r.isDeleted) continue;
		if (filter.asOf !== undefined) {
			if (!onBooksAt(r, filter.asOf)) {
				diagnostics.reservas_fora_da_carteira_na_data_base++;
				continue;
			}
		} else if (excluded.has(r.status)) {
			diagnostics.reservas_excluidas_por_status++;
			continue;
		}

		for (const room of r.rooms ?? []) {
			// Na data base histórica um quarto hoje cancelado pode ter estado ativo;
			// sem data de cancelamento por quarto, a aproximação é ignorá-lo também.
			if (room.roomStatus === "cancelled") {
				diagnostics.quartos_cancelados_ignorados++;
				continue;
			}
			const roomType = room.roomTypeName || "Sem tipo";
			const rates = room.detailedRoomRates;
			if (rates && Object.keys(rates).length > 0) {
				for (const [date, value] of Object.entries(rates)) {
					if (date < filter.start || date > filter.end) continue;
					nights.push({
						date,
						revenue: num(value),
						reservationID: r.reservationID,
						roomType,
						source: sourceLabel(r),
						hasRate: true,
					});
				}
			} else if (room.roomCheckIn && room.roomCheckOut) {
				// Sem diária detalhada: conta a noite, receita desconhecida (0) e sinaliza.
				for (const date of eachNight(room.roomCheckIn, room.roomCheckOut)) {
					if (date === room.roomCheckOut) break;
					if (date < filter.start || date > filter.end) continue;
					diagnostics.noites_sem_tarifa_detalhada++;
					nights.push({
						date,
						revenue: 0,
						reservationID: r.reservationID,
						roomType,
						source: sourceLabel(r),
						hasRate: false,
					});
				}
			}
		}
	}
	return { nights, diagnostics };
}

export interface Kpis {
	room_nights: number;
	receita: number;
	ocupacao_pct: number;
	adr: number;
	revpar: number;
	reservas: number;
}

function round(n: number, d = 2): number {
	const f = 10 ** d;
	return Math.round(n * f) / f;
}

export function kpis(nights: NightRecord[], physicalRooms: number, nightsInPeriod: number): Kpis {
	const capacity = physicalRooms * nightsInPeriod;
	const roomNights = nights.length;
	const revenue = nights.reduce((s, n) => s + n.revenue, 0);
	return {
		room_nights: roomNights,
		receita: round(revenue),
		ocupacao_pct: capacity ? round((roomNights / capacity) * 100, 1) : 0,
		adr: roomNights ? round(revenue / roomNights) : 0,
		revpar: capacity ? round(revenue / capacity) : 0,
		reservas: new Set(nights.map((n) => n.reservationID)).size,
	};
}

export function groupBy(
	nights: NightRecord[],
	key: "source" | "roomType" | "date" | "month" | "weekday",
	physicalRooms: number,
	nightsInPeriod: number,
): Record<string, Kpis & { participacao_receita_pct: number }> {
	const total = nights.reduce((s, n) => s + n.revenue, 0);
	const buckets = new Map<string, NightRecord[]>();
	const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
	for (const n of nights) {
		let k: string;
		if (key === "month") k = n.date.slice(0, 7);
		else if (key === "weekday") k = WEEKDAYS[new Date(`${n.date}T00:00:00Z`).getUTCDay()]!;
		else k = n[key];
		const arr = buckets.get(k);
		if (arr) arr.push(n);
		else buckets.set(k, [n]);
	}
	const out: Record<string, Kpis & { participacao_receita_pct: number }> = {};
	for (const [k, arr] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		// Para "date", a capacidade é de uma noite; para os demais, do período inteiro.
		const span = key === "date" ? 1 : nightsInPeriod;
		const base = kpis(arr, physicalRooms, span);
		const rev = arr.reduce((s, n) => s + n.revenue, 0);
		out[k] = { ...base, participacao_receita_pct: total ? round((rev / total) * 100, 1) : 0 };
	}
	return out;
}

export function variation(current: Kpis, previous: Kpis): Record<keyof Kpis, number | null> {
	const out = {} as Record<keyof Kpis, number | null>;
	for (const k of Object.keys(current) as (keyof Kpis)[]) {
		const p = previous[k];
		const c = current[k];
		if (k === "ocupacao_pct") {
			out[k] = round(c - p, 1); // pontos percentuais
		} else {
			out[k] = p ? round(((c - p) / p) * 100, 1) : null;
		}
	}
	return out;
}

export const DEFINITIONS = {
	room_nights: "noites de quarto vendidas com data dentro do período",
	receita:
		"soma das diárias (detailedRoomRates) registradas na Cloudbeds; sem extras, consumos, impostos ou taxa de serviço",
	ocupacao_pct: "room nights ÷ (quartos físicos × noites do período)",
	adr: "receita ÷ room nights",
	revpar: "receita ÷ (quartos físicos × noites do período)",
	variacao: "ocupação em pontos percentuais; demais métricas em % sobre o ano anterior",
} as const;
