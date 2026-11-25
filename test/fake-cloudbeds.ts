/**
 * Cloudbeds simulada: responde aos endpoints usados pelo conector com dados
 * construídos à mão, aplicando os filtros que a API documenta. Registra cada
 * chamada para que os testes confiram cabeçalhos e quantidade de requisições.
 */
import { CloudbedsClient } from "../src/cloudbeds/client";
import type { ReservationWithRates } from "../src/cloudbeds/endpoints";

export const PLANTED_PII = {
	document: "98765432100",
	email: "joana.silva@example.com",
	phone: "+55 54 99876-5432",
	birth: "1987-03-14",
	address: "Rua Secreta 123",
	card: "4111111111111111",
};

export interface Call {
	url: URL;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

function nightsRates(checkIn: string, nights: number, rate: number): Record<string, number> {
	const out: Record<string, number> = {};
	const d = new Date(`${checkIn}T00:00:00Z`);
	for (let i = 0; i < nights; i++) {
		out[d.toISOString().slice(0, 10)] = rate;
		d.setUTCDate(d.getUTCDate() + 1);
	}
	return out;
}

function plus(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export function res(
	id: string,
	checkIn: string,
	nights: number,
	rate: number,
	opts: Partial<ReservationWithRates> & { roomType?: string } = {},
): ReservationWithRates {
	return {
		reservationID: id,
		status: "checked_out",
		dateCreated: "2025-01-01 10:00:00",
		reservationCheckIn: checkIn,
		reservationCheckOut: plus(checkIn, nights),
		sourceName: "Booking.com",
		total: rate * nights,
		rooms: [
			{
				roomTypeName: opts.roomType ?? "Deluxe",
				roomCheckIn: checkIn,
				roomCheckOut: plus(checkIn, nights),
				roomStatus: "checked_out",
				// CONFIRMADO em 24/11/2026 (ESTADO.md): detailedRoomRates como { "AAAA-MM-DD": número }.
				detailedRoomRates: nightsRates(checkIn, nights, rate),
			},
		],
		...opts,
	};
}

export function makeRooms() {
	const rooms = Array.from({ length: 21 }, (_, i) => ({
		roomID: String(i + 1),
		roomName: `${String(i + 1).padStart(2, "0")} - QUARTO`,
		roomTypeName: i < 5 ? "Deluxe" : "Standard",
		isVirtual: false,
		archivedAt: null,
	}));
	rooms.push({ roomID: "99", roomName: "Virtual", roomTypeName: "Pacote", isVirtual: true, archivedAt: null });
	return rooms;
}

export function fakeCloudbeds(reservations: ReservationWithRates[]) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
		calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body as string | undefined });
		const q = url.searchParams;
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "x-request-id": "req-test" } });

		switch (url.pathname) {
			case "/api/v1.3/getRooms": {
				// CONFIRMADO em 24/11/2026 (ESTADO.md): data[] por propriedade, cada uma com rooms[];
				// count e total contam quartos, não propriedades.
				const rooms = makeRooms();
				return json({ success: true, data: [{ propertyID: "7830", rooms }], count: rooms.length, total: rooms.length });
			}
			case "/api/v1.3/getHotelDetails":
				// CONFIRMADO em 24/11/2026 (ESTADO.md): propertyCurrency é objeto; NÃO há campo de fuso.
				return json({ success: true, data: { propertyID: "7830", propertyName: "Hotel Britânico", propertyCurrency: { currencyCode: "BRL" } } });
			case "/api/v1.3/getHotels":
				// CONFIRMADO em 24/11/2026 (ESTADO.md): o fuso está aqui; propertyCurrency é objeto
				// (a documentação diz array).
				return json({
					success: true,
					data: [{ propertyID: "7830", propertyName: "Hotel Britânico", propertyTimezone: "America/Sao_Paulo", propertyCurrency: { currencyCode: "BRL", currencySymbol: "R$" } }],
					count: 1,
					total: 1,
				});
			case "/api/v1.3/getSources":
				// CONFIRMADO em 24/11/2026 (ESTADO.md): data é um array que contém OUTRO array com as
				// origens; commission vem como texto numérico.
				return json({
					success: true,
					data: [[
						{ propertyID: "7830", sourceID: "s-1-1", sourceName: "Direto", isThirdParty: false, status: true, commission: "0.00", taxes: [], fees: [] },
						{ propertyID: "7830", sourceID: "ss-2-1", sourceName: "Booking.com", isThirdParty: true, status: true, commission: "15.00", taxes: [], fees: [] },
					]],
					count: 1,
				});
			case "/api/v1.3/getRatePlans": {
				// CONFIRMADO em 24/11/2026 (ESTADO.md): a tarifa do dia vem em roomRateDetailed[].rate
				// (a documentação diz rateBase); parentRatePlanNamePrivate vem nulo e o plano-pai
				// se identifica por parentRateID; endDate é o check-out (não entra).
				const start = q.get("startDate")!;
				const end = q.get("endDate")!;
				const dias: Record<string, unknown>[] = [];
				for (let d = start; d < end; d = plus(d, 1)) {
					dias.push({ date: d, rate: 500, totalRate: 500, roomsAvailable: 3, closedToArrival: false, closedToDeparture: false, blocked: false, minLos: 1, maxLos: 0, cutOff: 0, lastMinuteBooking: 0 });
				}
				const base = { roomTypeID: "1", roomTypeName: "Deluxe", roomRate: 500, totalRate: 500 * dias.length, roomsAvailable: 3, roomRateDetailed: dias };
				return json({
					success: true,
					data: [
						{ ...base, rateID: "100", isDerived: false, parentRateID: null, ratePlanNamePrivate: "Tarifa Base", ratePlanNamePublic: "Base", parentRatePlanNamePrivate: null },
						{ ...base, rateID: "200", isDerived: true, parentRateID: "100", ratePlanNamePrivate: "Não Reembolsável", ratePlanNamePublic: "NR", parentRatePlanNamePrivate: null, derivedType: "percentage", derivedValue: -10 },
					],
				});
			}
			case "/api/v1.3/getReservationsWithRateDetails": {
				// CONFIRMADO em parte em 24/11/2026 (ESTADO.md): filtro por reservationCheckOutFrom/To
				// e "total" com o total do recorte. SUPOSIÇÃO: ver ESTADO.md — paginação acima de 100
				// e excludeStatuses.
				const from = q.get("reservationCheckOutFrom") ?? "0000-00-00";
				const to = q.get("reservationCheckOutTo") ?? "9999-99-99";
				const excl = new Set((q.get("excludeStatuses") ?? "").split(",").filter(Boolean));
				const filtered = reservations.filter(
					(r) => r.reservationCheckOut! >= from && r.reservationCheckOut! <= to && !excl.has(r.status),
				);
				const page = Number(q.get("pageNumber") ?? 1);
				const size = Number(q.get("pageSize") ?? 100);
				const data = filtered.slice((page - 1) * size, page * size);
				return json({ success: true, data, count: data.length, total: filtered.length });
			}
			case "/api/v1.3/getReservations": {
				// REFUTADO em 24/11/2026 (ESTADO.md): a chamada padrão real NÃO traz guestList, e-mail,
				// cartão nem customFields. Este formato só existe para o teste de privacidade, que a
				// Fase 1 refaz.
				const data = [
					{
						reservationID: "R1",
						status: "confirmed",
						guestName: "Joana Silva",
						startDate: "2026-07-10",
						endDate: "2026-07-12",
						guestEmail: PLANTED_PII.email,
						cardsOnFile: [{ cardNumber: PLANTED_PII.card }],
						customFields: [{ customFieldName: "Document", customFieldValue: PLANTED_PII.document }],
						guestList: {
							"1": {
								guestFirstName: "Joana",
								guestLastName: "Silva",
								guestEmail: PLANTED_PII.email,
								guestCellPhone: PLANTED_PII.phone,
								guestBirthdate: PLANTED_PII.birth,
								guestAddress: PLANTED_PII.address,
								guestDocumentNumber: PLANTED_PII.document,
								taxID: PLANTED_PII.document,
								isMainGuest: true,
							},
						},
						campoNovoQueACloudbedsInventou: "não deveria aparecer",
					},
				];
				return json({ success: true, data, count: 1, total: 1 });
			}
			case "/api/v1.3/getReservation":
				return json({ success: false, message: "Reservation not found" });
			case "/datainsights/v1.1/health":
				// SUPOSIÇÃO: ver ESTADO.md — hotel sem Insights responde 401. (O hotel real tem
				// Insights e responde 200; o caso "sem Insights" não foi observado.)
				return json({ code: 401, message: "Unauthorized" }, 401);
			case "/datainsights/v1.1/reports/query/data":
				// CONFIRMADO em 24/11/2026 (ESTADO.md): corpo real do 403 por falta de permissão do usuário.
				return json(
					{
						error: {
							code: 403,
							status: "Forbidden",
							description: "You don't have the permission to access the requested resource. It is either read-protected or not readable by the server.",
							message: "User does not have permission to VIEW report",
						},
					},
					403,
				);
			default:
				return json({ success: false, message: `endpoint não simulado: ${url.pathname}` }, 404);
		}
	}) as typeof fetch;

	const makeClient = () =>
		new CloudbedsClient({ apiKey: "cbat_TESTE", propertyId: "7830", fetchImpl, sleep: async () => {} });
	return { calls, fetchImpl, makeClient };
}
