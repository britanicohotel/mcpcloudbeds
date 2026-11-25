#!/usr/bin/env node
/**
 * Verificação da Cloudbeds real (Fase 5, primeira parte), sem wrangler dev.
 *
 *   node scripts/verificar-cloudbeds.mjs
 *
 * Lê CLOUDBEDS_API_KEY do .dev.vars na raiz do repositório e chama UMA vez cada
 * endpoint abaixo, com os parâmetros que o conector usa. Imprime só:
 *   - status HTTP, X-Request-ID e, quando a chamada falha, a mensagem de erro
 *     da API (é ela que diz qual escopo falta);
 *   - o esqueleto da resposta: caminho do campo, tipo e quantas vezes apareceu.
 *     Texto vira classe de formato (data, data-hora, numérica, vazia, texto...),
 *     nunca o conteúdo;
 *   - verificações derivadas para as suposições do ESTADO.md, só em contagens.
 * Nenhum valor de hóspede é impresso, e nada é gravado em disco.
 *
 * Só leitura: tudo é GET, exceto duas consultas ao Insights em modo Preview
 * (POST .../reports/query/data, que reproduz fora do Worker o 403 visto no
 * chat, e POST .../stock_reports/310/query/data). Consultas só leem.
 *
 *   --apenas=pms       só os endpoints da API clássica (1 a 9b)
 *   --apenas=fuso      só getHotels (9b), onde fica o fuso
 *   --apenas=insights  só os do Insights (10 a 16)
 *   --apenas=receita   diárias (detailedRoomRates) vs transações postadas, out/2026 (17 a 19)
 *   --apenas=bloqueios getRoomBlocks de out/2026 (20)
 *
 * A Accounting API (17 a 19) é lida com POST de busca, que também só lê.
 */
import { readFileSync } from "node:fs";

// As duas variáveis de ambiente abaixo existem só para testar o próprio script
// contra uma Cloudbeds falsa local; no uso normal ficam vazias.
const BASE = process.env.VERIFICAR_BASE_URL || "https://api.cloudbeds.com";
const PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID || "7830";
const TZ = "America/Sao_Paulo";
const INTERVALO_MS = 150; // limite documentado: 10 req/s

// ---------------------------------------------------------------- chave
function lerChave() {
	const arquivo = process.env.VERIFICAR_DEV_VARS || new URL("../.dev.vars", import.meta.url);
	let texto;
	try {
		texto = readFileSync(arquivo, "utf8");
	} catch {
		return null;
	}
	for (const linha of texto.split(/\r?\n/)) {
		const m = linha.match(/^\s*CLOUDBEDS_API_KEY\s*=\s*(.*)$/);
		if (!m) continue;
		const v = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
		return v || null;
	}
	return null;
}

// ---------------------------------------------------------------- datas
function hojeNoHotel() {
	return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function somarDias(iso, n) {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
function noitesEntre(inicio, fim) {
	return Math.round((Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------- forma
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_DATAHORA = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const RE_HORA = /^\d{2}:\d{2}(:\d{2})?$/;
const RE_NUM = /^-?\d+(\.\d+)?$/;

/** Classe do formato de um texto. Nunca devolve o texto. */
function classeTexto(s) {
	if (s === "") return "vazia";
	if (RE_DATA.test(s)) return "data";
	if (RE_DATAHORA.test(s)) return "data-hora";
	if (RE_ISO.test(s)) return "data-hora-iso";
	if (RE_HORA.test(s)) return "hora";
	if (RE_NUM.test(s)) return "numérica";
	return "texto";
}

function tipo(v) {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "string") return `string<${classeTexto(v)}>`;
	return typeof v;
}

/** Chaves que são dados (datas, ids), não nomes de campo: viram um rótulo. */
function rotuloChaves(obj) {
	const ks = Object.keys(obj);
	if (ks.length === 0) return null;
	if (ks.every((k) => RE_DATA.test(k))) return "<data>";
	if (ks.every((k) => /^\d+$/.test(k))) return "<id>";
	return null;
}

/** Acumula, por caminho, os tipos vistos e quantas vezes. */
function esqueleto(valor, caminho = "", acc = new Map(), prof = 0) {
	const t = tipo(valor);
	const reg = acc.get(caminho) ?? new Map();
	reg.set(t, (reg.get(t) ?? 0) + (t === "array" ? 0 : 1));
	if (t === "array") reg.set(`array(itens=${valor.length})`, (reg.get(`array(itens=${valor.length})`) ?? 0) + 1);
	acc.set(caminho, reg);
	if (prof > 8) return acc;
	if (t === "array") {
		for (const item of valor) esqueleto(item, `${caminho}[]`, acc, prof + 1);
	} else if (t === "object") {
		// Nos relatórios do Insights, as chaves de records/subtotals/totals são
		// valores (mês, canal, período); só nomes em snake_case são campos.
		const ehRelatorio = /^\.(records|subtotals|totals)(\.|$)/.test(caminho);
		const soCampos = Object.keys(valor).every((k) => /^[a-z][a-z0-9_]*$/.test(k));
		const rotulo = rotuloChaves(valor) ?? (ehRelatorio && !soCampos ? "<valor>" : null);
		for (const [k, v] of Object.entries(valor)) esqueleto(v, `${caminho}.${rotulo ?? k}`, acc, prof + 1);
	}
	return acc;
}

function imprimirEsqueleto(json) {
	const acc = esqueleto(json);
	for (const [caminho, tipos] of acc) {
		const partes = [...tipos].filter(([t]) => t !== "array").map(([t, n]) => (t.startsWith("array(") ? t : `${t}×${n}`));
		// Arrays com tamanhos variados: resume em mín–máx.
		const tamanhos = [...tipos.keys()].filter((t) => t.startsWith("array(")).map((t) => Number(t.match(/\d+/)[0]));
		const semArr = partes.filter((p) => !p.startsWith("array("));
		if (tamanhos.length) semArr.unshift(`array×${[...tipos].filter(([t]) => t.startsWith("array(")).reduce((s, [, n]) => s + n, 0)} (itens ${Math.min(...tamanhos)}–${Math.max(...tamanhos)})`);
		console.log(`    ${caminho || "(raiz)"}  ${semArr.join(" | ")}`);
	}
}

// ---------------------------------------------------------------- HTTP
let ultima = 0;
async function chamar(nome, caminho, query = {}, corpoJson, opcoes = {}) {
	const espera = ultima + INTERVALO_MS - Date.now();
	if (espera > 0) await new Promise((r) => setTimeout(r, espera));
	ultima = Date.now();

	const url = new URL(caminho, BASE);
	for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
	const nomesParametros = [...url.searchParams.keys()].join(", ") || "(nenhum)";

	let res;
	try {
		const headers = { "x-api-key": CHAVE, "X-PROPERTY-ID": PROPERTY_ID, accept: "application/json" };
		if (corpoJson !== undefined) headers["content-type"] = "application/json";
		// A Accounting API documenta autenticação Bearer.
		if (opcoes.bearer) headers.authorization = `Bearer ${CHAVE}`;
		res = await fetch(url, {
			method: corpoJson === undefined ? "GET" : "POST",
			headers,
			body: corpoJson === undefined ? undefined : JSON.stringify(corpoJson),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (e) {
		console.log(`\n=== ${nome}  →  falha de rede: ${e.name}`);
		return { nome, status: 0, ok: false };
	}
	const requestId = res.headers.get("x-request-id") ?? "(sem X-Request-ID)";
	const texto = await res.text();
	let json = null;
	try {
		json = texto ? JSON.parse(texto) : null;
	} catch {
		/* não-JSON */
	}
	const sucessoApi = json && typeof json === "object" && "success" in json ? json.success : undefined;
	const ok = res.ok && sucessoApi !== false;

	console.log(`\n=== ${nome}  →  HTTP ${res.status}  X-Request-ID ${requestId}`);
	console.log(`    parâmetros enviados: ${nomesParametros}`);
	if (!ok) {
		// Mensagem de erro da API (texto da Cloudbeds, não dado de hóspede), cortada.
		const msg = json?.message ?? json?.error ?? json?.errors ?? (json ? null : `corpo não-JSON (${texto.length} bytes)`);
		console.log(`    ERRO: success=${String(sucessoApi)} mensagem=${JSON.stringify(msg).slice(0, 300)}`);
	}
	if (json !== null && !opcoes.semEsqueleto) imprimirEsqueleto(json);
	return { nome, status: res.status, ok, requestId, json };
}

// ---------------------------------------------------------------- verificações
const linhasVerificacao = [];
function verif(chave, texto) {
	linhasVerificacao.push(`  [${chave}] ${texto}`);
}

function contar(lista, f) {
	const m = new Map();
	for (const x of lista) {
		const k = f(x);
		m.set(k, (m.get(k) ?? 0) + 1);
	}
	return Object.fromEntries(m);
}

// ---------------------------------------------------------------- execução
const CHAVE = lerChave();
if (!CHAVE) {
	console.error("CLOUDBEDS_API_KEY ausente ou vazia no .dev.vars. Nada foi chamado.");
	process.exit(1);
}
console.log(`Chave lida do .dev.vars: comprimento ${CHAVE.length}, prefixo cbat_: ${CHAVE.startsWith("cbat_")}`);

const hoje = hojeNoHotel();
const ontem = somarDias(hoje, -1);
const chegada = somarDias(hoje, 14);
const partida = somarDias(chegada, 3);
const OUT_DE = "2026-10-12";
const OUT_ATE = "2026-10-18";
console.log(`Hoje no hotel: ${hoje}. Propriedade ${PROPERTY_ID}.`);

const r = {};
const APENAS = process.argv.find((a) => a.startsWith("--apenas="))?.split("=")[1];
const roda = (grupo) => !APENAS || APENAS === grupo;

// ======================================================= API clássica (1 a 9)
if (roda("pms")) {
// 1. getHotelDetails (read:hotel)
r.hotel = await chamar("getHotelDetails", "/api/v1.3/getHotelDetails", { propertyID: PROPERTY_ID });
if (r.hotel.ok) {
	const dados = r.hotel.json?.data ?? {};
	const pc = dados.propertyCurrency;
	verif("propertyCurrency", `tipo ${tipo(pc)}${pc && typeof pc === "object" ? `, chaves: ${Object.keys(pc).join(", ")}` : ""}`);
	// O conector lê data.propertyTimezone (src/tools/register.ts:96); no chat o fuso veio ausente.
	const candidatos = Object.keys(dados).filter((k) => /time|zone|tz/i.test(k));
	verif(
		"fuso",
		`data.propertyTimezone existe: ${"propertyTimezone" in dados}; campos de data com time/zone/tz no nome: ${candidatos.join(", ") || "(nenhum)"}`,
	);
}

// 2. getRooms pageSize=100 (read:room) — como src/cloudbeds/endpoints.ts:129
r.rooms = await chamar("getRooms (pageSize=100)", "/api/v1.3/getRooms", { propertyID: PROPERTY_ID, pageSize: 100 });
if (r.rooms.ok) {
	const props = Array.isArray(r.rooms.json.data) ? r.rooms.json.data : [];
	const quartos = props.flatMap((p) => p.rooms ?? []);
	const fisicos = quartos.filter((q) => !q.isVirtual && !q.archivedAt);
	verif(
		"getRooms",
		`propriedades em data[]: ${props.length}; quartos achatados: ${quartos.length}; count=${r.rooms.json.count} total=${r.rooms.json.total}; ` +
			`virtuais: ${quartos.filter((q) => q.isVirtual).length}; arquivados: ${quartos.filter((q) => q.archivedAt).length}; ` +
			`bloqueados (roomBlocked): ${quartos.filter((q) => q.roomBlocked).length}; físicos pela regra do código (não virtual e não arquivado): ${fisicos.length}`,
	);
}

// 3. getRoomTypes (read:room)
r.roomTypes = await chamar("getRoomTypes", "/api/v1.3/getRoomTypes", { propertyID: PROPERTY_ID });
if (r.roomTypes.ok) {
	const tipos = r.roomTypes.json.data ?? [];
	const unidades = tipos.reduce((s, t) => s + (Number(t.roomTypeUnits) || 0), 0);
	verif("getRoomTypes", `tipos: ${tipos.length}; count=${r.roomTypes.json.count} total=${r.roomTypes.json.total}; soma de roomTypeUnits: ${unidades}`);
}

// 4. getSources (read:reservation pela documentação)
r.sources = await chamar("getSources", "/api/v1.3/getSources", { propertyID: PROPERTY_ID });
if (r.sources.ok) verif("getSources", `origens: ${(r.sources.json.data ?? []).length}`);

// 5. getReservations modificadas desde ontem — parâmetros como cloudbeds_listar_reservas
r.reservas = await chamar("getReservations (modifiedFrom ontem)", "/api/v1.3/getReservations", {
	propertyID: PROPERTY_ID,
	modifiedFrom: `${ontem} 00:00:00`,
	includeAllRooms: true,
	pageNumber: 1,
	pageSize: 100,
});
if (r.reservas.ok) {
	const d = r.reservas.json.data ?? [];
	verif(
		"getReservations",
		`nesta página: ${d.length}; count=${r.reservas.json.count} total=${r.reservas.json.total}; ` +
			`com guestList: ${d.filter((x) => x.guestList && typeof x.guestList === "object").length}; ` +
			`com rooms[]: ${d.filter((x) => Array.isArray(x.rooms)).length}; status: ${JSON.stringify(contar(d, (x) => x.status))}`,
	);
}

// 6. getReservationsWithRateDetails — uma semana de check-outs de outubro/2026, 1 página
r.comTarifas = await chamar(
	`getReservationsWithRateDetails (check-out ${OUT_DE}..${OUT_ATE}, 1 página)`,
	"/api/v1.3/getReservationsWithRateDetails",
	{ propertyID: PROPERTY_ID, reservationCheckOutFrom: OUT_DE, reservationCheckOutTo: OUT_ATE, pageNumber: 1, pageSize: 100 },
);
if (r.comTarifas.ok) {
	const d = r.comTarifas.json.data ?? [];
	const checkOut = (x) => String(x.reservationCheckOut ?? "").slice(0, 10);
	const dentro = d.filter((x) => checkOut(x) >= OUT_DE && checkOut(x) <= OUT_ATE).length;
	const canceladas = d.filter((x) => x.status === "canceled");
	const quartos = d.flatMap((x) => x.rooms ?? []);
	let tiposValor = {};
	let comparacaoNoites = { iguais: 0, mais_datas: 0, menos_datas: 0, sem_detalhe: 0, datas_fora_da_estadia: 0 };
	for (const q of quartos) {
		const rates = q.detailedRoomRates;
		if (!rates || typeof rates !== "object" || Object.keys(rates).length === 0) {
			comparacaoNoites.sem_detalhe++;
			continue;
		}
		for (const v of Object.values(rates)) tiposValor[tipo(v)] = (tiposValor[tipo(v)] ?? 0) + 1;
		const ci = String(q.roomCheckIn ?? "").slice(0, 10);
		const co = String(q.roomCheckOut ?? "").slice(0, 10);
		const n = RE_DATA.test(ci) && RE_DATA.test(co) ? noitesEntre(ci, co) : null;
		const k = Object.keys(rates).length;
		if (n === null) continue;
		if (k === n) comparacaoNoites.iguais++;
		else if (k > n) comparacaoNoites.mais_datas++;
		else comparacaoNoites.menos_datas++;
		if (Object.keys(rates).some((dt) => dt < ci || dt >= co)) comparacaoNoites.datas_fora_da_estadia++;
	}
	verif(
		"rateDetails.filtro",
		`nesta página: ${d.length}; count=${r.comTarifas.json.count} total=${r.comTarifas.json.total}; ` +
			`check-out dentro do intervalo pedido: ${dentro} de ${d.length}; isDeleted=true: ${d.filter((x) => x.isDeleted).length}`,
	);
	verif("rateDetails.status", JSON.stringify(contar(d, (x) => x.status)));
	verif(
		"dateCancelled",
		`canceladas: ${canceladas.length}; com dateCancelled preenchido: ${canceladas.filter((x) => x.dateCancelled).length}; ` +
			`formato: ${JSON.stringify(contar(canceladas, (x) => tipo(x.dateCancelled)))}`,
	);
	verif("detailedRoomRates.valor", `tipos dos valores: ${JSON.stringify(tiposValor)}`);
	verif("detailedRoomRates.noites", `por quarto, datas em detailedRoomRates vs noites entre roomCheckIn e roomCheckOut: ${JSON.stringify(comparacaoNoites)}`);
	verif("rooms.roomStatus", JSON.stringify(contar(quartos, (q) => q.roomStatus)));
	verif(
		"formatos",
		`reservationCheckOut: ${JSON.stringify(contar(d, (x) => tipo(x.reservationCheckOut)))}; roomCheckIn: ${JSON.stringify(contar(quartos, (q) => tipo(q.roomCheckIn)))}; ` +
			`dateCreated: ${JSON.stringify(contar(d, (x) => tipo(x.dateCreated)))}; dateCreatedUTC: ${JSON.stringify(contar(d, (x) => tipo(x.dateCreatedUTC)))}`,
	);
}

// 7. getRatePlans, 3 noites, detailedRates=true (read:rate) — como cloudbeds_tarifas_disponibilidade
r.planos = await chamar(`getRatePlans (${chegada} → ${partida}, 3 noites, detailedRates)`, "/api/v1.3/getRatePlans", {
	propertyID: PROPERTY_ID,
	startDate: chegada,
	endDate: partida,
	detailedRates: true,
});
if (r.planos.ok) {
	const d = r.planos.json.data ?? [];
	const tamanhos = contar(d, (p) => (Array.isArray(p.roomRateDetailed) ? p.roomRateDetailed.length : "sem roomRateDetailed"));
	const incluiPartida = d.filter((p) => Array.isArray(p.roomRateDetailed) && p.roomRateDetailed.some((x) => x.date === partida)).length;
	const incluiChegada = d.filter((p) => Array.isArray(p.roomRateDetailed) && p.roomRateDetailed.some((x) => x.date === chegada)).length;
	verif(
		"getRatePlans.endDate",
		`planos: ${d.length}; datas por plano em roomRateDetailed: ${JSON.stringify(tamanhos)}; planos com a data de chegada: ${incluiChegada}; ` +
			`planos com a data de partida (endDate): ${incluiPartida}`,
	);
}

// 8. getAvailableRoomTypes, mesma estadia, detailedRates=true para contar as noites (read:room)
r.disponiveis = await chamar(`getAvailableRoomTypes (${chegada} → ${partida}, 2 adultos)`, "/api/v1.3/getAvailableRoomTypes", {
	propertyID: PROPERTY_ID,
	startDate: chegada,
	endDate: partida,
	rooms: 1,
	adults: 2,
	children: 0,
	detailedRates: true,
});
if (r.disponiveis.ok) {
	const tiposQ = (r.disponiveis.json.data ?? []).flatMap((p) => p.propertyRooms ?? []);
	const tamanhos = contar(tiposQ, (t) => (Array.isArray(t.roomRateDetailed) ? t.roomRateDetailed.length : "sem roomRateDetailed"));
	const incluiPartida = tiposQ.filter((t) => Array.isArray(t.roomRateDetailed) && t.roomRateDetailed.some((x) => x.date === partida)).length;
	verif(
		"getAvailableRoomTypes.endDate",
		`tipos disponíveis: ${tiposQ.length}; datas por tipo em roomRateDetailed: ${JSON.stringify(tamanhos)}; com a data de partida (endDate): ${incluiPartida}; ` +
			`propertyCurrency: ${tipo(r.disponiveis.json.data?.[0]?.propertyCurrency)}`,
	);
}

// 9. getWebhooks (sem escopo na documentação)
r.webhooks = await chamar("getWebhooks", "/api/v1.3/getWebhooks", { propertyID: PROPERTY_ID });
if (r.webhooks.ok) {
	const d = r.webhooks.json.data ?? [];
	verif("getWebhooks", `assinaturas: ${d.length}; por evento: ${JSON.stringify(contar(d, (w) => `${w.event?.entity}/${w.event?.action}`))}`);
}
} // fim da API clássica

// 9b. getHotels (read:hotel): onde a documentação põe propertyTimezone. O conector
// lê o fuso de getHotelDetails (src/tools/register.ts:96), que não tem esse campo.
if (roda("pms") || APENAS === "fuso") {
	r.hotels = await chamar("getHotels", "/api/v1.3/getHotels", { propertyIDs: PROPERTY_ID });
	if (r.hotels.ok) {
		const h = (r.hotels.json.data ?? [])[0] ?? {};
		const fuso = h.propertyTimezone;
		verif(
			"fuso.getHotels",
			`propertyTimezone existe: ${"propertyTimezone" in h}; tipo ${tipo(fuso)}; igual ao HOTEL_TIMEZONE do wrangler.jsonc (America/Sao_Paulo): ${fuso === TZ}; ` +
				`propertyCurrency: ${tipo(h.propertyCurrency)}`,
		);
	}
}

// ======================================================= Insights (10 a 14)
if (roda("insights")) {
// 10. Insights health
r.insights = await chamar("GET /datainsights/v1.1/health", "/datainsights/v1.1/health");

// 11. Insights: permissões do usuário dono da chave. Separa "falta escopo na chave"
// de "falta permissão do usuário" no 403 "User does not have permission to VIEW report".
r.politicas = await chamar("GET /datainsights/v1.1/me/policies", "/datainsights/v1.1/me/policies");
if (r.politicas.ok && Array.isArray(r.politicas.json)) {
	// Nomes de recurso e de ação são permissões do sistema, não dados de hóspede.
	const linhas = r.politicas.json.map((p) => `${p.resource}: ${(p.actions ?? []).join(",")}`);
	verif("insights.politicas", linhas.length ? linhas.join(" | ") : "(lista vazia)");
	// As ações vêm como ACTION_DI_VIEW etc.; casa o sufixo.
	const relatorio = r.politicas.json.filter((p) => /report/i.test(String(p.resource)));
	verif(
		"insights.report.VIEW",
		relatorio.length
			? relatorio.map((p) => `${p.resource} tem VIEW: ${(p.actions ?? []).some((a) => /(^|_)VIEW$/i.test(a))}`).join("; ")
			: "nenhum recurso com 'report' no nome",
	);
	const acls = r.politicas.json.find((p) => p.resource === "acls")?.actions ?? [];
	verif("insights.acls", `relatórios liberados: ${acls.length}; occupancy_report: ${acls.includes("occupancy_report")}; pace_report: ${acls.includes("pace_report")}`);
}

// 12. Insights: CDFs do dataset 7 (Occupancy) — nomes de coluna, não dados.
r.cdfs7 = await chamar("GET /datainsights/v1.1/datasets/7", "/datainsights/v1.1/datasets/7");
if (r.cdfs7.ok) {
	const cats = r.cdfs7.json?.cdfs ?? [];
	const colunas = cats.flatMap((c) => (c.cdfs ?? []).map((x) => ({ categoria: c.category, coluna: x.column, tipo: x.kind })));
	for (const c of cats) verif("dataset7.categoria", `${c.category}: ${(c.cdfs ?? []).map((x) => `${x.column}(${x.kind})`).join(", ")}`);
	const procurados = ["capacity_count", "rooms_sold", "blocked_room_count", "out_of_service_count"];
	const tem = new Set(colunas.map((c) => c.coluna));
	verif("dataset7.procurados", procurados.map((p) => `${p}: ${tem.has(p) ? "existe" : "NÃO existe"}`).join("; "));
	verif("dataset7.receita", `colunas com 'revenue' no nome: ${colunas.filter((c) => /revenue/i.test(c.coluna)).map((c) => c.coluna).join(", ") || "(nenhuma)"}`);
	verif("dataset7.total", `nome do dataset: ${r.cdfs7.json?.name}; categorias: ${cats.length}; CDFs: ${colunas.length}`);
}

// 13. Insights: reproduz fora do Worker a consulta que deu 403 no chat. Uma coluna
// agregada (capacity_count, soma) de outubro/2026: contagem de quartos, sem hóspede.
const consulta = {
	property_ids: [Number(PROPERTY_ID)],
	dataset_id: 7,
	columns: [{ cdf: { type: "default", column: "capacity_count" }, metrics: ["sum"] }],
	filters: {
		and: [
			{ cdf: { type: "default", column: "stay_date" }, operator: "greater_than_or_equal", value: "2026-10-01T00:00:00" },
			{ cdf: { type: "default", column: "stay_date" }, operator: "less_than_or_equal", value: "2026-10-31T00:00:00" },
		],
	},
	settings: { details: false, totals: true },
};
r.consulta = await chamar(
	"POST /datainsights/v1.1/reports/query/data (Preview, capacity_count de out/2026)",
	"/datainsights/v1.1/reports/query/data",
	{ mode: "Preview", format: "raw" },
	consulta,
);
if (r.consulta.ok) {
	// Soma de capacidade é contagem de quartos-noite, não dado de hóspede.
	const achado = JSON.stringify(r.consulta.json).match(/"capacity_count[^"]*"\s*:\s*\{?[^0-9-]*(-?\d+(\.\d+)?)/);
	verif("insights.consulta", `respondeu; capacity_count somado em out/2026: ${achado ? achado[1] : "(não localizado na resposta)"}; 21 quartos × 31 noites = 651`);
}

// 14. Insights: lista de relatórios salvos do hotel (recurso "report" em leitura).
r.relatorios = await chamar("GET /datainsights/v1.1/reports", "/datainsights/v1.1/reports");
if (r.relatorios.ok) {
	const lista = Array.isArray(r.relatorios.json) ? r.relatorios.json : r.relatorios.json?.reports ?? r.relatorios.json?.data ?? [];
	verif("insights.relatorios", `relatórios salvos listados: ${Array.isArray(lista) ? lista.length : "(formato inesperado)"}`);
}

// 15 e 16. Stock reports (relatórios-padrão da Cloudbeds): o relatório 310,
// "Channel Production Comparison - YOY by Month". Dados agregados por canal e mês.
const STOCK = 310;
const resumoStock = (rotulo, resp) => {
	if (!resp.ok) return;
	const j = resp.json ?? {};
	const linhas = Array.isArray(j.index) ? j.index.length : "(sem index)";
	verif(rotulo, `respondeu; chaves de topo: ${Object.keys(j).join(", ")}; linhas (index): ${linhas}; agrupado por: ${(j.group_rows ?? []).length} níveis; períodos: ${(j.periods ?? []).length}`);
};
r.stockDados = await chamar(`GET /datainsights/v1.1/stock_reports/${STOCK}/data`, `/datainsights/v1.1/stock_reports/${STOCK}/data`, {
	property_ids: PROPERTY_ID,
	format: "raw",
});
resumoStock("stock310.get", r.stockDados);
// A consulta substitui a configuração do relatório: só com property_ids, os
// períodos somem e as colunas calculadas que citam "This year"/"Last year" dão
// 400. Por isso lê a definição e reenvia periods/comparisons dela (sem imprimir).
r.stockDefinicao = await chamar(`GET /datainsights/v1.1/stock_reports/${STOCK} (definição)`, `/datainsights/v1.1/stock_reports/${STOCK}`);
const def = r.stockDefinicao.ok ? r.stockDefinicao.json ?? {} : {};
const corpoStock = { property_ids: [Number(PROPERTY_ID)] };
for (const k of ["periods", "comparisons"]) if (def[k] !== undefined && def[k] !== null) corpoStock[k] = def[k];
verif("stock310.definicao", `campos reaproveitados no corpo da consulta: ${Object.keys(corpoStock).join(", ")}`);
r.stockConsulta = await chamar(
	`POST /datainsights/v1.1/stock_reports/${STOCK}/query/data (Preview)`,
	`/datainsights/v1.1/stock_reports/${STOCK}/query/data`,
	{ mode: "Preview", format: "raw" },
	corpoStock,
);
resumoStock("stock310.query", r.stockConsulta);
} // fim do Insights

// ======================================================= Receita: diárias vs contabilidade (17 a 19)
// Pergunta: a soma de detailedRoomRates (o que o conector usa) bate com a receita
// de diárias postada na contabilidade, líquida de ajustes? Período: out/2026.
const MES_INI = "2026-10-01";
const MES_FIM = "2026-10-31";
const dinheiro = (n) => Math.round(n * 100) / 100;

if (roda("receita")) {
	// 17. Lado do conector: mesmo recorte de src/tools/analytics.ts (fetchStays) e
	// metrics.ts (extractNights): check-outs de início+1 até fim+1+14, sem canceladas.
	const reservas = [];
	let total = null;
	for (let pagina = 1; pagina <= 20; pagina++) {
		const resp = await chamar(
			`getReservationsWithRateDetails out/2026, página ${pagina}`,
			"/api/v1.3/getReservationsWithRateDetails",
			{ propertyID: PROPERTY_ID, reservationCheckOutFrom: "2026-10-02", reservationCheckOutTo: "2026-11-15", excludeStatuses: "canceled", pageNumber: pagina, pageSize: 100 },
			undefined,
			{ semEsqueleto: pagina > 1 },
		);
		if (!resp.ok) break;
		const d = resp.json.data ?? [];
		reservas.push(...d);
		if (typeof resp.json.total === "number") total = resp.json.total;
		if (d.length < 100 || (total !== null && reservas.length >= total)) break;
	}
	const somaPorStatus = {};
	const idsComNoiteEmOutubro = new Set();
	// Para a conciliação por reserva: diária registrada de 1/10 até hoje.
	const registradaPorReserva = new Map();
	const statusPorReserva = new Map();
	let noites = 0;
	for (const res of reservas) {
		if (res.isDeleted) continue;
		statusPorReserva.set(String(res.reservationID), res.status);
		for (const q of res.rooms ?? []) {
			if (q.roomStatus === "canceled" || q.roomStatus === "cancelled") continue;
			for (const [data, valor] of Object.entries(q.detailedRoomRates ?? {})) {
				if (data >= MES_INI && data <= hoje) {
					const id = String(res.reservationID);
					registradaPorReserva.set(id, (registradaPorReserva.get(id) ?? 0) + (Number(valor) || 0));
				}
				if (data < MES_INI || data > MES_FIM) continue;
				somaPorStatus[res.status] = (somaPorStatus[res.status] ?? 0) + (Number(valor) || 0);
				if (res.status !== "no_show") noites++;
				idsComNoiteEmOutubro.add(String(res.reservationID));
			}
		}
	}
	const somaConector = Object.entries(somaPorStatus).filter(([s]) => s !== "no_show").reduce((s, [, v]) => s + v, 0);
	verif(
		"receita.detailedRoomRates",
		`reservas lidas: ${reservas.length} (total=${total}); noites em out/2026 (sem cancelada e no-show): ${noites}; ` +
			`soma (regra do conector): ${dinheiro(somaConector)}; no-show à parte: ${dinheiro(somaPorStatus.no_show ?? 0)}; ` +
			`por status: ${JSON.stringify(Object.fromEntries(Object.entries(somaPorStatus).map(([k, v]) => [k, dinheiro(v)])))}`,
	);

	// 18. Códigos internos de transação (grupo e descrição oficiais).
	const codigos = await chamar("GET /accounting/v1.0/internal-transaction-codes", "/accounting/v1.0/internal-transaction-codes", {}, undefined, { bearer: true, semEsqueleto: true });
	const porCodigo = new Map();
	for (const c of codigos.json?.content ?? []) porCodigo.set(String(c.code), { grupo: c.group ?? "", descricao: c.description ?? "" });
	verif("receita.codigos", `códigos listados: ${porCodigo.size}`);
	// Diária = códigos do grupo ROOM_REVENUE_RATE/MANUAL e as variantes com sufixo de letra (ex.: 1000A).
	const baseDiaria = new Set([...porCodigo].filter(([, c]) => /^ROOM_REVENUE_(RATE|MANUAL)$/.test(c.grupo)).map(([k]) => k));
	const ehDiaria = (codigo) => baseDiaria.has(codigo) || baseDiaria.has(String(codigo).replace(/[A-Z]+$/, ""));

	// 19. Transações postadas: varre páginas (até 1100 por página) com um filtro.
	async function transacoes(rotulo, filtros) {
		const lista = [];
		let token;
		for (let pagina = 1; pagina <= 30; pagina++) {
			const corpo = { filters: { and: filtros }, limit: 1100, ...(token ? { pageToken: token } : {}) };
			const resp = await chamar(`${rotulo}, página ${pagina}`, "/accounting/v1.0/transactions", {}, corpo, { bearer: true, semEsqueleto: pagina > 1 });
			if (!resp.ok) return { lista, ok: false };
			lista.push(...(resp.json?.transactions ?? []));
			token = resp.json?.nextPageToken;
			if (!token) break;
		}
		return { lista, ok: true };
	}
	function somarPorCodigo(lista) {
		const tab = new Map();
		for (const t of lista) {
			const k = String(t.internalTransactionCode);
			const e = tab.get(k) ?? { n: 0, bruto: 0, escalado: 0, escalas: new Set(), tipos: new Set() };
			const a = Number(t.amount) || 0;
			e.n++;
			e.bruto += a;
			e.escalado += a / 10 ** (Number(t.currencyScale) || 0);
			e.escalas.add(t.currencyScale);
			e.tipos.add(Number.isInteger(a) ? "inteiro" : "decimal");
			tab.set(k, e);
		}
		return tab;
	}

	const mes = await transacoes("POST /accounting/v1.0/transactions (service_date em out/2026)", [
		{ field: "service_date", operator: "greater_than_or_equal", value: MES_INI },
		{ field: "service_date", operator: "less_than_or_equal", value: MES_FIM },
	]);
	if (mes.ok) {
		const tab = somarPorCodigo(mes.lista);
		let diariaBruto = 0;
		let diariaEscalado = 0;
		for (const [k, e] of [...tab].sort()) {
			const c = porCodigo.get(k) ?? { grupo: "?", descricao: "?" };
			const marca = ehDiaria(k) ? "DIÁRIA" : "      ";
			verif(
				"receita.porCodigo",
				`${marca} ${k.padEnd(6)} ${c.grupo.padEnd(26)} n=${String(e.n).padStart(5)} soma=${dinheiro(e.bruto)} soma/10^escala=${dinheiro(e.escalado)} escala=${[...e.escalas].join("/")} valores=${[...e.tipos].join("/")} — ${c.descricao}`,
			);
			if (ehDiaria(k)) {
				diariaBruto += e.bruto;
				diariaEscalado += e.escalado;
			}
		}
		const ligadas = mes.lista.filter((t) => ehDiaria(String(t.internalTransactionCode)));
		const casam = ligadas.filter((t) => idsComNoiteEmOutubro.has(String(t.sourceIdentifier)) || idsComNoiteEmOutubro.has(String(t.sourceId))).length;
		verif(
			"receita.contabil",
			`transações em out/2026: ${mes.lista.length}; de diária: ${ligadas.length}; diária líquida (soma dos códigos DIÁRIA): bruto=${dinheiro(diariaBruto)} escalado=${dinheiro(diariaEscalado)}; ` +
				`por sourceKind: ${JSON.stringify(contar(ligadas, (t) => t.sourceKind))}; transações de diária ligadas a reserva com noite em outubro (por sourceIdentifier/sourceId): ${casam} de ${ligadas.length}`,
		);
		verif(
			"receita.diferenca",
			`contábil − conector: bruto ${dinheiro(diariaBruto - somaConector)}; escalado ${dinheiro(diariaEscalado - somaConector)} (conector = ${dinheiro(somaConector)})`,
		);
	}

	// Ajustes de diária lançados depois do mês (1/11 até hoje) sobre reservas com noites em outubro.
	const depois = await transacoes(`POST /accounting/v1.0/transactions (service_date 2026-11-01..${hoje})`, [
		{ field: "service_date", operator: "greater_than_or_equal", value: "2026-11-01" },
		{ field: "service_date", operator: "less_than_or_equal", value: hoje },
	]);
	if (depois.ok) {
		const posteriores = depois.lista.filter(
			(t) => ehDiaria(String(t.internalTransactionCode)) && /[A-Z]$/.test(String(t.internalTransactionCode)) &&
				(idsComNoiteEmOutubro.has(String(t.sourceIdentifier)) || idsComNoiteEmOutubro.has(String(t.sourceId))),
		);
		const tab = somarPorCodigo(posteriores);
		verif(
			"receita.ajustesPosteriores",
			`ajustes de diária (código com sufixo de letra) lançados de 1/11 a ${hoje} em reservas com noite em outubro: ${posteriores.length}; ` +
				`${[...tab].map(([k, e]) => `${k}: n=${e.n} soma=${dinheiro(e.bruto)} escalado=${dinheiro(e.escalado)}`).join("; ") || "nenhum"}`,
		);

		// Conciliação por reserva (só contagens e totais, nenhum ID impresso):
		// diária registrada (detailedRoomRates, noites de 1/10 até hoje) contra a
		// contabilidade da mesma reserva no mesmo intervalo de service_date.
		if (mes.ok) {
			const idDe = (t) => (idsComNoiteEmOutubro.has(String(t.sourceIdentifier)) ? String(t.sourceIdentifier) : String(t.sourceId));
			const viaIdentifier = mes.lista.filter((t) => ehDiaria(String(t.internalTransactionCode)) && idsComNoiteEmOutubro.has(String(t.sourceIdentifier))).length;
			const contabil = new Map();
			const imposto = new Map();
			const comAjustePosterior = new Set(posteriores.map(idDe));
			for (const t of [...mes.lista, ...depois.lista]) {
				const id = idDe(t);
				if (!idsComNoiteEmOutubro.has(id)) continue;
				const codigo = String(t.internalTransactionCode);
				if (ehDiaria(codigo)) contabil.set(id, (contabil.get(id) ?? 0) + (Number(t.amount) || 0));
				if (codigo === "8000") imposto.set(id, (imposto.get(id) ?? 0) + (Number(t.amount) || 0));
			}
			const cat = { igual: 0, igual_somando_imposto_8000: 0, diferente: 0 };
			let somaDif = 0;
			let difComAjustePosterior = 0;
			let somaDifComAjustePosterior = 0;
			const difPorStatus = {};
			for (const id of idsComNoiteEmOutubro) {
				const reg = registradaPorReserva.get(id) ?? 0;
				const cont = contabil.get(id) ?? 0;
				const imp = imposto.get(id) ?? 0;
				if (Math.abs(cont - reg) < 0.01) cat.igual++;
				else if (Math.abs(cont + imp - reg) < 0.01) cat.igual_somando_imposto_8000++;
				else {
					cat.diferente++;
					somaDif += cont - reg;
					const st = statusPorReserva.get(id) ?? "?";
					difPorStatus[st] = dinheiro((difPorStatus[st] ?? 0) + (cont - reg));
					if (comAjustePosterior.has(id)) {
						difComAjustePosterior++;
						somaDifComAjustePosterior += cont - reg;
					}
				}
			}
			verif(
				"receita.porReserva",
				`reservas com noite em outubro: ${idsComNoiteEmOutubro.size}; transações de diária casadas por sourceIdentifier: ${viaIdentifier}; ` +
					`${JSON.stringify(cat)}; soma das diferenças (contábil − registrada): ${dinheiro(somaDif)}; por status: ${JSON.stringify(difPorStatus)}; ` +
					`reservas com ajuste posterior: ${comAjustePosterior.size}, das quais diferentes: ${difComAjustePosterior} (soma ${dinheiro(somaDifComAjustePosterior)})`,
			);
		}
	}
}

// ======================================================= Capacidade: bloqueios (20)
if (roda("bloqueios")) {
	// 20. getRoomBlocks de out/2026 (read:roomblock; até 35 dias por consulta).
	const blocos = [];
	for (let pagina = 1; pagina <= 10; pagina++) {
		const resp = await chamar(
			`getRoomBlocks out/2026, página ${pagina}`,
			"/api/v1.3/getRoomBlocks",
			{ propertyID: PROPERTY_ID, startDate: MES_INI, endDate: MES_FIM, pageNumber: pagina, pageSize: 100 },
			undefined,
			{ semEsqueleto: pagina > 1 },
		);
		if (!resp.ok) break;
		const d = resp.json?.data?.roomBlocks ?? (Array.isArray(resp.json?.data) ? resp.json.data.flatMap((p) => p.roomBlocks ?? []) : []);
		blocos.push(...d);
		if (d.length < 100) break;
	}
	// Quartos-noite bloqueados dentro de outubro, nas duas leituras possíveis de endDate.
	const noitesPorTipo = { inclusiva: {}, exclusiva: {} };
	for (const b of blocos) {
		const ini = b.startDate > MES_INI ? b.startDate : MES_INI;
		const quartos = (b.rooms ?? []).length;
		for (const leitura of ["inclusiva", "exclusiva"]) {
			const fimBloco = leitura === "inclusiva" ? b.endDate : somarDias(b.endDate, -1);
			const fim = fimBloco < MES_FIM ? fimBloco : MES_FIM;
			const n = fim >= ini ? noitesEntre(ini, fim) + 1 : 0;
			noitesPorTipo[leitura][b.roomBlockType] = (noitesPorTipo[leitura][b.roomBlockType] ?? 0) + n * quartos;
		}
	}
	verif(
		"bloqueios",
		`blocos que tocam out/2026: ${blocos.length}; por tipo: ${JSON.stringify(contar(blocos, (b) => b.roomBlockType))}; ` +
			`quartos por bloco: ${JSON.stringify(contar(blocos, (b) => (b.rooms ?? []).length))}`,
	);
	verif("bloqueios.quartosNoite", `endDate inclusiva: ${JSON.stringify(noitesPorTipo.inclusiva)}; endDate exclusiva: ${JSON.stringify(noitesPorTipo.exclusiva)}; capacidade bruta 21 × 31 = 651`);
}

// ---------------------------------------------------------------- resumo
console.log("\n=== RESUMO");
for (const x of Object.values(r)) console.log(`  ${x.ok ? "OK  " : "FALHA"} HTTP ${String(x.status).padEnd(3)} ${x.nome}`);
console.log("\n=== VERIFICAÇÕES DERIVADAS (só contagens)");
for (const l of linhasVerificacao) console.log(l);
