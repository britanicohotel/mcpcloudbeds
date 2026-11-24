/**
 * Minimização de dados pessoais antes de qualquer resposta sair do Worker.
 *
 * Regra: lista de campos PERMITIDOS, nunca lista de proibidos. Campo novo que a
 * Cloudbeds passar a devolver não vaza por padrão — só aparece se entrar aqui.
 *
 * Nunca saem: documento, nascimento, endereço, CPF/taxID, cartões
 * (cardsOnFile, channelProvidedCreditCard), campos personalizados.
 * Saem mascarados: e-mail e telefone (preservam a cauda, para conferência).
 * Saem inteiros: nome, país, datas, valores, quarto, origem.
 */

export function maskEmail(email: unknown): string | null {
	if (typeof email !== "string" || !email.includes("@")) return null;
	const [user, domain] = email.split("@") as [string, string];
	return `${user.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: unknown): string | null {
	if (typeof phone !== "string") return null;
	const digits = phone.replace(/\D/g, "");
	if (digits.length < 4) return null;
	return `***${digits.slice(-4)}`;
}

function pick<T extends Record<string, unknown>>(obj: T | undefined | null, keys: string[]) {
	const out: Record<string, unknown> = {};
	if (!obj) return out;
	for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") out[k] = obj[k];
	return out;
}

const ROOM_KEYS = [
	"roomTypeName",
	"roomName",
	"roomID",
	"roomCheckIn",
	"roomCheckOut",
	"roomStatus",
	"rateName",
	"adults",
	"children",
	"startDate",
	"endDate",
	"roomTotal",
	"subReservationID",
];

const RESERVATION_KEYS = [
	"reservationID",
	"status",
	"guestName",
	"startDate",
	"endDate",
	"reservationCheckIn",
	"reservationCheckOut",
	"adults",
	"children",
	"sourceName",
	"origin",
	"thirdPartyIdentifier",
	"dateCreated",
	"dateModified",
	"dateCancelled",
	"estimatedArrivalTime",
	"total",
	"balance",
	"propertyCurrency",
	"guestCountry",
	"mealPlans",
	"allotmentBlockCode",
	"groupCode",
];

const GUEST_KEYS = ["guestFirstName", "guestLastName", "guestCountry", "isMainGuest", "roomName", "roomTypeName"];

function sanitizeRooms(rooms: unknown): unknown[] | undefined {
	if (!Array.isArray(rooms)) return undefined;
	return rooms.map((r) => pick(r as Record<string, unknown>, ROOM_KEYS));
}

function sanitizeGuests(guestList: unknown): unknown[] | undefined {
	if (!guestList || typeof guestList !== "object") return undefined;
	const values = Array.isArray(guestList) ? guestList : Object.values(guestList);
	return values.map((g) => {
		const guest = g as Record<string, unknown>;
		return {
			...pick(guest, GUEST_KEYS),
			email: maskEmail(guest.guestEmail),
			telefone: maskPhone(guest.guestCellPhone ?? guest.guestPhone),
		};
	});
}

export function sanitizeReservation(raw: Record<string, unknown>): Record<string, unknown> {
	const out = pick(raw, RESERVATION_KEYS);
	const source = raw.source as Record<string, unknown> | undefined;
	if (!out.sourceName && source?.name) out.sourceName = source.name;
	const bd = raw.balanceDetailed as Record<string, unknown> | undefined;
	if (bd) out.balanceDetailed = pick(bd, ["subTotal", "additionalItems", "taxesFees", "grandTotal", "paid"]);
	if (raw.guestEmail) out.guestEmail = maskEmail(raw.guestEmail);
	const rooms = sanitizeRooms(raw.rooms);
	if (rooms) out.rooms = rooms;
	// getReservation separa quartos atribuídos e não atribuídos.
	const assigned = sanitizeRooms(raw.assigned);
	if (assigned) out.assigned = assigned;
	const unassigned = sanitizeRooms(raw.unassigned);
	if (unassigned) out.unassigned = unassigned;
	const guests = sanitizeGuests(raw.guestList);
	if (guests) out.hospedes = guests;
	return out;
}
