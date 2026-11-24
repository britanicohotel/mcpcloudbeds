/** Datas como strings YYYY-MM-DD, aritmética sempre em UTC para não sofrer com fuso. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(s: string, label = "data"): string {
	if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
		throw new Error(`${label} inválida: "${s}" (use AAAA-MM-DD)`);
	}
	return s;
}

export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Dias entre a e b (b - a). */
export function diffDays(a: string, b: string): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Lista de noites de `start` até `end`, ambas inclusivas. */
export function eachNight(start: string, end: string): string[] {
	const out: string[] = [];
	for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
	return out;
}

/**
 * Período equivalente do ano anterior.
 * - "dia_da_semana": recua 364 dias, preserva o dia da semana (padrão da hotelaria)
 * - "data": mesma data do calendário um ano antes (29/02 vira 28/02)
 */
export type ComparisonMode = "dia_da_semana" | "data";

export function shiftLastYear(date: string, mode: ComparisonMode): string {
	if (mode === "dia_da_semana") return addDays(date, -364);
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const py = y - 1;
	const lastDay = new Date(Date.UTC(py, m, 0)).getUTCDate();
	return `${py}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/**
 * Converte "YYYY-MM-DD HH:MM:SS" da Cloudbeds em epoch ms.
 * Campos *UTC vêm em UTC; os demais vêm no horário da propriedade.
 * Gramado é UTC-3 o ano inteiro (sem horário de verão desde 2019).
 */
export function parseCloudbedsDateTime(
	value: string | null | undefined,
	isUtc: boolean,
	propertyOffsetMinutes = -180,
): number | null {
	if (!value) return null;
	const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
	if (!m) {
		const t = Date.parse(value);
		return Number.isNaN(t) ? null : t;
	}
	const asUtc = Date.parse(`${m[1]}T${m[2]}Z`);
	return isUtc ? asUtc : asUtc - propertyOffsetMinutes * 60_000;
}

/** "Hoje" no fuso do hotel. */
export function todayIn(timeZone: string, now = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
