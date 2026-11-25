/**
 * Funções de leitura sobre a Cloudbeds. Os nomes de campo vêm das páginas de
 * referência da v1.3 (developers.cloudbeds.com/reference/*). Onde a documentação
 * é ambígua, o comentário diz o que precisa ser conferido contra resposta real.
 *
 * Escopos que a chave do conector precisa ter (conferidos contra a chave real
 * em 24/11/2026; ver ESTADO.md):
 *   read:reservation  getReservations, getReservation, getReservationsWithRateDetails, getSources
 *   read:room         getRooms, getRoomTypes, getAvailableRoomTypes
 *   read:rate         getRatePlans
 *   read:hotel        getHotelDetails, getHotels
 *   Insights          os endpoints não declaram escopo. Consulta livre e relatórios
 *                     salvos exigem, além disso, permissão do USUÁRIO dono da chave
 *                     para ver relatórios no Insights (sem ela: 403 "User does not
 *                     have permission to VIEW report"). Stock reports funcionam sem ela.
 */
import type { CloudbedsClient } from "./client";

export const PAGE_SIZE_MAX = 100;

export interface ClassicList<T> {
	success: boolean;
	data: T[];
	count?: number;
	total?: number;
}

export interface RoomStay {
	roomTypeID?: string;
	roomTypeName?: string;
	roomTypeIsVirtual?: boolean;
	rateID?: string;
	rateName?: string;
	roomID?: string | null;
	roomName?: string;
	roomCheckIn?: string;
	roomCheckOut?: string;
	roomStatus?: string;
	adults?: string;
	children?: string;
	/** data (YYYY-MM-DD) -> valor da diária. Tipo do valor não documentado. */
	detailedRoomRates?: Record<string, number | string>;
	subReservationID?: string;
}

export interface ReservationWithRates {
	reservationID: string;
	status: string;
	dateCreated?: string;
	dateCreatedUTC?: string;
	dateCancelled?: string | null;
	reservationCheckIn?: string;
	reservationCheckOut?: string;
	sourceName?: string;
	sourceCategory?: string;
	source?: { name?: string; sourceID?: string; category?: string; paymentCollect?: string };
	total?: number;
	balance?: number;
	propertyCurrency?: string;
	guestCountry?: string;
	rooms?: RoomStay[];
	detailedRates?: Record<string, number | string>;
	isDeleted?: boolean;
}

export interface ReservationSummary {
	reservationID: string;
	status: string;
	guestName?: string;
	startDate?: string;
	endDate?: string;
	adults?: string;
	children?: string;
	balance?: number;
	sourceName?: string;
	dateCreated?: string;
	rooms?: RoomStay[];
}

/**
 * Percorre páginas de 100 até `total` ou até a página vir incompleta.
 * Cada página consome uma subrequisição do orçamento do cliente.
 */
export async function paginate<T>(
	client: CloudbedsClient,
	method: string,
	query: Record<string, string | number | boolean | undefined>,
	maxPages = 30,
): Promise<{ items: T[]; total: number | null; pages: number }> {
	const items: T[] = [];
	let total: number | null = null;
	let page = 1;
	for (; page <= maxPages; page++) {
		const res = await client.classic<ClassicList<T>>(method, {
			...query,
			pageNumber: page,
			pageSize: PAGE_SIZE_MAX,
		});
		const data = Array.isArray(res.data) ? res.data : [];
		items.push(...data);
		if (typeof res.total === "number") total = res.total;
		if (data.length < PAGE_SIZE_MAX) break;
		if (total !== null && items.length >= total) break;
	}
	return { items, total, pages: Math.min(page, maxPages) };
}

export function getHotelDetails(client: CloudbedsClient) {
	return client.classic<{ success: boolean; data: Record<string, unknown> }>("getHotelDetails");
}

export interface HotelSummary {
	propertyID?: string;
	propertyName?: string;
	/** Só getHotels traz o fuso; getHotelDetails não tem campo de fuso (verificado em 24/11/2026). */
	propertyTimezone?: string;
	/** Documentado como array; a resposta real é um objeto. Aceita os dois. */
	propertyCurrency?: { currencyCode?: string } | { currencyCode?: string }[];
}

export function getHotels(client: CloudbedsClient) {
	return client.classic<ClassicList<HotelSummary>>("getHotels", { propertyIDs: client.propertyId });
}

/** Código da moeda, venha propertyCurrency como objeto (real) ou array (documentação). */
export function currencyCode(c: HotelSummary["propertyCurrency"]): string | undefined {
	if (Array.isArray(c)) return c[0]?.currencyCode;
	return c?.currencyCode;
}

export function getRoomTypes(client: CloudbedsClient) {
	return client.classic<ClassicList<Record<string, unknown>>>("getRoomTypes");
}

export interface RoomRecord {
	roomID: string;
	roomName: string;
	roomTypeID?: string;
	roomTypeName?: string;
	maxGuests?: number;
	isVirtual?: boolean;
	roomBlocked?: boolean;
	archivedAt?: string | null;
}

/**
 * getRooms devolve data[] por propriedade, cada uma com rooms[].
 * A documentação não diz se a paginação (padrão 20) se aplica a propriedades
 * ou a quartos — pedimos 100 e achatamos; conferir com o hotel real (21 quartos).
 */
export async function getRooms(client: CloudbedsClient): Promise<RoomRecord[]> {
	const res = await client.classic<ClassicList<{ propertyID: string; rooms?: RoomRecord[] }>>(
		"getRooms",
		{ pageSize: PAGE_SIZE_MAX },
	);
	const out: RoomRecord[] = [];
	for (const p of res.data ?? []) out.push(...(p.rooms ?? []));
	return out;
}

/** Quartos físicos que contam para ocupação: não virtuais e não arquivados. */
export function physicalRooms(rooms: RoomRecord[]): RoomRecord[] {
	return rooms.filter((r) => !r.isVirtual && !r.archivedAt);
}

export function getRatePlans(
	client: CloudbedsClient,
	q: { startDate: string; endDate: string; roomTypeID?: string; adults?: number },
) {
	return client.classic<ClassicList<Record<string, unknown>>>("getRatePlans", {
		...q,
		detailedRates: true,
	});
}

export function getAvailableRoomTypes(
	client: CloudbedsClient,
	q: { startDate: string; endDate: string; adults?: number; children?: number },
) {
	return client.classic<ClassicList<Record<string, unknown>>>("getAvailableRoomTypes", q);
}

export function getSources(client: CloudbedsClient) {
	return client.classic<ClassicList<Record<string, unknown> | Record<string, unknown>[]>>("getSources");
}

/**
 * A resposta real de getSources traz `data` como um array que contém OUTRO
 * array com as origens (`data[][]`, verificado em 24/11/2026); a documentação
 * diz `data[]`. Achata um nível e aceita os dois formatos.
 */
export function flattenSources(data: unknown): Record<string, unknown>[] {
	if (!Array.isArray(data)) return [];
	return data.flatMap((x) => (Array.isArray(x) ? x : [x])).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

export function getReservation(client: CloudbedsClient, reservationID: string) {
	return client.classic<{ success: boolean; data: Record<string, unknown> }>("getReservation", {
		reservationID,
	});
}

// ---- Insights (Data Insights v1.1) ----------------------------------------
// Disponível só para propriedades com Cloudbeds Insights. A ferramenta de status
// descobre se o hotel tem acesso antes de qualquer consulta.

export function insightsHealth(client: CloudbedsClient) {
	return client.rest("GET", "/datainsights/v1.1/health");
}

export function insightsDatasets(client: CloudbedsClient) {
	return client.rest("GET", "/datainsights/v1.1/datasets");
}

export function insightsStockReports(client: CloudbedsClient) {
	return client.rest("GET", "/datainsights/v1.1/stock_reports");
}

export function insightsQuery(client: CloudbedsClient, body: unknown, mode: "Preview" | "Run") {
	return client.rest("POST", "/datainsights/v1.1/reports/query/data", { mode, format: "raw" }, body);
}
