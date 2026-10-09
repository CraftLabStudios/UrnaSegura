/**
 * Teste de ponta a ponta + testes de ataque contra a API em execução.
 * Pré-requisitos: `SEED_VOTOS_SIMULADOS=0 npm run seed` (eleição limpa, em 'preparada') e servidor rodando.
 * Uso: npm run testar   (variável API_URL, padrão http://localhost:3001)
 */
import { execFileSync } from "node:child_process";
import { conectar, desconectar, usuarios } from "../db.js";
import { decifrarSegredo } from "../crypto/chaves.js";
import { gerarCodigoTotp, passoAtual } from "../crypto/totp.js";
import { cifrarVoto, verificarCadeia, verificarAssinaturaHash, jsonCanonico, sha256Hex, type Bloco } from "../../../client/src/crypto.js";

const API = process.env.API_URL ?? "http://localhost:3001";
const FRASE = process.env.JUNTA_PASSPHRASE ?? "junta-eleitoral-demo-2026";
let falhas = 0;

function checar(nome: string, condicao: boolean, extra?: unknown) {
  console.log(`${condicao ? "  ✔" : "  ✘"} ${nome}${!condicao && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
  if (!condicao) falhas++;
}

class Cliente {
  cookies = new Map<string, string>();
  csrf = "";
  async req(metodo: string, url: string, corpo?: unknown, opts: { semCsrf?: boolean; tipo?: string } = {}) {
    const headers: Record<string, string> = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
    if (metodo !== "GET") {
      headers["content-type"] = opts.tipo ?? "application/json";
      if (!opts.semCsrf && this.csrf) headers["x-csrf-token"] = this.csrf;
    }
    const r = await fetch(API + "/api" + url, { method: metodo, headers, body: metodo === "GET" ? undefined : typeof corpo === "string" ? corpo : JSON.stringify(corpo ?? {}) });
    for (const c of r.headers.getSetCookie()) {
      const [par] = c.split(";");
      const [k, ...v] = par.split("=");
      const valor = v.join("=");
      if (valor) this.cookies.set(k, valor);
      else this.cookies.delete(k);
    }
    const dados = await r.json().catch(() => ({}));
    return { status: r.status, dados };
  }
}

await conectar();
async function codigo(id: string, passoExtra = 0) {
  const u = await usuarios().findOne({ _id: id });
  return gerarCodigoTotp(decifrarSegredo(u!.totpCifrado), Date.now() + passoExtra * 30_000);
}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Código TOTP válido e ainda não usado (espera a próxima janela de 30 s se o anti-replay exigir). */
async function codigoNovo(id: string) {
  for (;;) {
    const u = await usuarios().findOne({ _id: id });
    if (u!.ultimoPassoTotp < passoAtual()) return codigo(id, 0);
    if (u!.ultimoPassoTotp === passoAtual()) return codigo(id, 1);
    await dormir(1000);
  }
}
/** Equipe: usuário + senha → código TOTP. */
async function loginEquipe(id: string, senha: string) {
  const c = new Cliente();
  const a = await c.req("POST", "/auth/login", { usuario: id, senha });
  if (a.status !== 200) return { c, status: a.status, dados: a.dados };
  const b = await c.req("POST", "/auth/mfa", { codigo: await codigoNovo(id) });
  c.csrf = b.dados.csrf ?? "";
  return { c, status: b.status, dados: b.dados };
}
/** Eleitor: um clique no gov.br simulado. */
async function loginEleitor() {
  const c = new Cliente();
  const r = await c.req("POST", "/auth/govbr", {});
  c.csrf = r.dados.csrf ?? "";
  return { c, status: r.status, dados: r.dados, titulo: r.dados.eleitor?.titulo as string | undefined };
}

const eleicao = (await new Cliente().req("GET", "/eleicao")).dados;

console.log("\n1) Autenticação da equipe (senha + TOTP)");
const admin = await loginEquipe("admin", "Admin@2026!");
checar("admin entra com senha + TOTP", admin.status === 200, admin.dados);
const semMfa = new Cliente();
await semMfa.req("POST", "/auth/login", { usuario: "admin", senha: "Admin@2026!" });
checar("só a senha não dá acesso ao painel (falta o 2º fator)", (await semMfa.req("GET", "/admin/painel")).status === 401);
const replay = await semMfa.req("POST", "/auth/mfa", { codigo: await codigo("admin", 0) }); // mesmo código usado pelo admin acima
checar("código TOTP já usado é recusado (anti-replay)", replay.status === 401, replay);

console.log("\n1b) Eleitor: \"Entrar com gov.br\" (simulado)");
const g1 = await loginEleitor();
checar(`gov.br simulado entra e saúda o eleitor (Olá, ${g1.dados.eleitor?.nome})`, g1.status === 200 && g1.dados.eleitor?.nome === "Vinicius Teste" && g1.titulo === "000000000001", g1.dados);
checar("a sessão do eleitor existe após o clique", (await g1.c.req("GET", "/auth/me")).status === 200);
const g2 = await loginEleitor();
checar("dois cliques não recebem o mesmo eleitor (reserva)", g2.status === 200 && g2.titulo !== g1.titulo, [g1.titulo, g2.titulo]);
await g2.c.req("POST", "/auth/logout");
const g3 = await loginEleitor();
checar("\"Não sou eu\"/sair devolve o eleitor reservado", g3.titulo === g2.titulo, [g2.titulo, g3.titulo]);
checar("eleitor não entra pelo login da equipe (título não é usuário)", (await new Cliente().req("POST", "/auth/login", { usuario: "000000000001", senha: "x" })).status === 400);
checar("POST /auth/govbr com campos extras é recusado (400)", (await new Cliente().req("POST", "/auth/govbr", { usuario: "admin" })).status === 400);
await g1.c.req("POST", "/auth/logout");
await g3.c.req("POST", "/auth/logout");

console.log("\n2) Ataques de entrada");
const nosql = await new Cliente().req("POST", "/auth/login", { usuario: { $ne: "" }, senha: { $ne: "" } });
checar("NoSQL injection {\"$ne\": \"\"} bloqueada (400)", nosql.status === 400, nosql);
const form = await new Cliente().req("POST", "/auth/login", "usuario=admin&senha=x", { tipo: "application/x-www-form-urlencoded" });
checar("POST que não é JSON recusado (415) — barra CSRF via formulário", form.status === 415);
const csrf = await admin.c.req("POST", "/admin/eleicao/abrir", {}, { semCsrf: true });
checar("requisição sem token CSRF recusada (403)", csrf.status === 403, csrf);
const grande = await new Cliente().req("POST", "/auth/login", { usuario: "admin", senha: "x".repeat(20000) });
checar("corpo acima de 16 KB recusado (413)", grande.status === 413, grande.status);

console.log("\n3) Abertura e votação (cédula completa: 6 votos por eleitor)");
const cedula = (presidente: string, deputado_federal: string, deputado_estadual: string, senador_1: string, senador_2: string, governador: string) =>
  ({ deputado_federal, deputado_estadual, senador_1, senador_2, governador, presidente });
const antes = await loginEleitor();
checar("eleitor não vota antes da abertura", (await antes.c.req("POST", "/votos", await cifrarVoto(cedula("22", "1310", "13013", "131", "222", "13"), eleicao.chavePublica))).status === 409);
await antes.c.req("POST", "/auth/logout");
checar("admin abre a votação", (await admin.c.req("POST", "/admin/eleicao/abrir")).status === 200);
const cedulas = [
  cedula("22", "1310", "13013", "131", "222", "13"),
  cedula("22", "13", "22999", "131", "131", "22"), // legenda (2 dígitos), legenda (número errado do PL), senador repetido
  cedula("13", "9999", "BRANCO", "555", "BRANCO", "NULO"),
  cedula("BRANCO", "BRANCO", "BRANCO", "BRANCO", "BRANCO", "BRANCO"),
  cedula("99", "1310", "13013", "222", "131", "13"), // 99 não existe → nulo
  cedula("70", "2210", "NULO", "999", "300", "55"),
];
const comprovantes: string[] = [];
const votaram: string[] = [];
for (let i = 0; i < cedulas.length; i++) {
  const e = await loginEleitor();
  const v = await e.c.req("POST", "/votos", await cifrarVoto(cedulas[i], eleicao.chavePublica));
  checar(`eleitor ${e.titulo} vota (presidente ${cedulas[i].presidente})`, v.status === 201, v.dados);
  if (v.status === 201) { comprovantes.push(v.dados.comprovante.hash); votaram.push(e.titulo!); }
  if (i === 0) checar("sessão é encerrada após votar", (await e.c.req("GET", "/auth/me")).status === 401);
}
const proximo = await loginEleitor();
checar("o gov.br simulado nunca entrega quem já votou", !votaram.includes(proximo.titulo!), [votaram, proximo.titulo]);
await proximo.c.req("POST", "/auth/logout");
const comp = (await new Cliente().req("GET", `/public/comprovante/${comprovantes[0]}`)).dados;
checar("comprovante encontrado e válido em todos os nós", comp.encontrado && comp.nos.every((n: { presente: boolean }) => n.presente), comp);

console.log("\n4) Voto duplo simultâneo (condição de corrida)");
const corrida = await loginEleitor();
const tentativas = await Promise.all(Array.from({ length: 5 }, async () => corrida.c.req("POST", "/votos", await cifrarVoto({ presidente: "55" }, eleicao.chavePublica))));
const aceitos = tentativas.filter((t) => t.status === 201).length;
checar(`5 envios simultâneos → exatamente 1 voto aceito (aceitos: ${aceitos})`, aceitos === 1, tentativas.map((t) => t.status));

console.log("\n5) Controle de acesso");
const eleitor = await loginEleitor();
checar("eleitor não acessa o painel da Junta (403)", (await eleitor.c.req("GET", "/admin/painel")).status === 403);
checar("eleitor não acessa a auditoria (403)", (await eleitor.c.req("GET", "/auditoria/ledger")).status === 403);
const auditor = await loginEquipe("auditor", "Auditor@2026!");
checar("auditor lê o ledger", (await auditor.c.req("GET", "/auditoria/ledger")).status === 200);
checar("eleitor não acessa o dashboard (403)", (await eleitor.c.req("GET", "/auditoria/dashboard")).status === 403);
await eleitor.c.req("POST", "/auth/logout");
const dash = await auditor.c.req("GET", "/auditoria/dashboard");
checar("auditor lê o dashboard", dash.status === 200, dash.status);
checar("dashboard NÃO revela placar antes da apuração (sigilo do voto)", dash.dados.resultado === null);
checar("dashboard: votos na cadeia == comparecimento", dash.dados.participacao.votosNaCadeia === dash.dados.participacao.compareceram, dash.dados.participacao);
checar("auditor NÃO pode encerrar a eleição (403)", (await auditor.c.req("POST", "/admin/eleicao/encerrar")).status === 403);
const forjado = new Cliente();
forjado.cookies.set("sessao", "eyJhbGciOiJub25lIn0.eyJwYXBlbCI6ImFkbWluIiwidGlwbyI6InNlc3NhbyIsInN1YiI6ImFkbWluIiwianRpIjoieCJ9.");
checar("JWT forjado com alg=none recusado (401)", (await forjado.req("GET", "/admin/painel")).status === 401);

console.log("\n6) Força bruta (login da equipe)");
const res = [];
for (let i = 0; i < 6; i++) res.push((await new Cliente().req("POST", "/auth/login", { usuario: "auditor", senha: "errada" + i })).status);
checar("após 5 senhas erradas a conta é bloqueada (429)", res[5] === 429, res);
const certa = await new Cliente().req("POST", "/auth/login", { usuario: "auditor", senha: "Auditor@2026!" });
checar("conta bloqueada recusa até a senha certa", certa.status === 429);
await usuarios().updateOne({ _id: "auditor" }, { $set: { bloqueadoAte: null, tentativasFalhas: 0 } }); // desbloqueia para o resto do teste

console.log("\n7) Adulteração direta no banco de um nó");
// Usa o próprio Node com o loader do tsx: "npx" não é executável direto no Windows (seria npx.cmd).
execFileSync(process.execPath, ["--import", "tsx", "src/scripts/adulterar.ts", "--no=no_tre_sp", "--seq=2"], { stdio: "ignore" });
let rep = (await auditor.c.req("GET", "/auditoria/ledger")).dados;
const sp = rep.nos.find((n: { nome: string }) => n.nome === "no_tre_sp");
checar(`adulteração detectada no nó no_tre_sp (${sp.erro?.motivo})`, sp.situacao === "corrompido", sp);
checar("maioria (2 de 3) continua em consenso", rep.temConsenso);
const amostra = (await auditor.c.req("POST", "/auditoria/amostragem", { tamanho: 7 })).dados;
checar("amostragem aponta o bloco 2 como divergente", amostra.itens.some((i: { seq: number; conferido: boolean }) => i.seq === 2 && !i.conferido), amostra.itens.map((i: { seq: number; conferido: boolean }) => [i.seq, i.conferido]));
const reparo = await admin.c.req("POST", "/admin/nos/no_tre_sp/reparar");
rep = (await auditor.c.req("GET", "/auditoria/ledger")).dados;
checar(`nó restaurado a partir da maioria (${reparo.dados.substituidos} blocos)`, rep.nos.every((n: { situacao: string }) => n.situacao === "consenso"), rep.nos);

console.log("\n8) Encerramento, apuração por cargo e verificação independente");
checar("admin encerra a votação", (await admin.c.req("POST", "/admin/eleicao/encerrar")).status === 200);
const tarde = await loginEleitor();
checar("ninguém vota depois do encerramento", (await tarde.c.req("POST", "/votos", await cifrarVoto({ presidente: "22" }, eleicao.chavePublica))).status === 409);
checar("frase da Junta errada não abre a chave (403)", (await admin.c.req("POST", "/admin/apurar", { frase: "frase-errada-123" })).status === 403);
const ap = await admin.c.req("POST", "/admin/apurar", { frase: FRASE });
checar("apuração concluída", ap.status === 200, ap.dados);
const b = ap.dados.boletim;
type RC = { id: string; candidatos: { numero: string; votos: number }[]; legendas: { numero: string; votos: number }[]; brancos: number; nulos: number };
const cargo = (id: string) => {
  const r = b.cargos.find((x: RC) => x.id === id) as RC;
  return { ...Object.fromEntries(r.candidatos.map((c) => [c.numero, c.votos])), ...Object.fromEntries(r.legendas.map((l) => [`L${l.numero}`, l.votos])), B: r.brancos, N: r.nulos } as Record<string, number>;
};
const esperado: Record<string, Record<string, number>> = {
  presidente: { "22": 2, "13": 1, "70": 1, "55": 1, B: 1, N: 1 },
  deputado_federal: { "1310": 2, "2210": 1, L13: 1, B: 1, N: 2 },
  deputado_estadual: { "13013": 2, L22: 1, B: 2, N: 2 },
  senador_1: { "131": 2, "555": 1, "222": 1, B: 1, N: 2 },
  senador_2: { "222": 1, "131": 1, "300": 1, B: 2, N: 2 }, // o repetido (131 nas duas vagas) vira nulo
  governador: { "13": 2, "22": 1, "55": 1, B: 1, N: 2 },
};
for (const [id, exp] of Object.entries(esperado)) {
  const got = cargo(id);
  const ok = Object.entries(exp).every(([k, v]) => got[k] === v);
  checar(`contagem correta — ${id}: ${Object.entries(exp).map(([k, v]) => `${k}=${got[k] ?? 0}/${v}`).join(" ")}`, ok, got);
}

const dashFim = (await auditor.c.req("GET", "/auditoria/dashboard")).dados;
checar("após a apuração o dashboard mostra o resultado assinado", dashFim.resultado?.hashBoletim === b.hash, dashFim.resultado?.hashBoletim);

const pub = new Cliente();
const chaves = (await pub.req("GET", "/public/chaves")).dados;
const ledger = (await pub.req("GET", "/public/ledger")).dados;
const cadeia = await verificarCadeia(ledger.blocos as Bloco[], chaves.assinaturaEd25519Spki);
checar(`verificação independente: ${cadeia.passos.length} blocos íntegros`, cadeia.integra);
const { boletim } = (await pub.req("GET", "/public/boletim")).dados;
const { hash, assinatura, ...base } = boletim;
checar("boletim público: hash e assinatura conferem", (await sha256Hex(jsonCanonico(base))) === hash && (await verificarAssinaturaHash(hash, assinatura, chaves.assinaturaEd25519Spki)));
checar("hash final do boletim == hash final recalculado da cadeia", boletim.hashFinalLedger === cadeia.hashFinal);

console.log("\n9) Trilha de auditoria");
const ev = (await auditor.c.req("GET", "/auditoria/eventos")).dados;
checar(`trilha íntegra (${ev.verificacao.total} eventos encadeados)`, ev.verificacao.integra);
const tipos = new Set(ev.eventos.map((e: { tipo: string }) => e.tipo));
for (const t of ["CSRF_BLOQUEADO", "VOTO_DUPLICADO_BLOQUEADO", "CONTA_BLOQUEADA", "ACESSO_NEGADO", "NO_REPARADO", "APURACAO_RECUSADA", "APURACAO_CONCLUIDA"]) checar(`evento ${t} registrado`, tipos.has(t));
checar("nenhum evento de voto identifica o eleitor", ev.eventos.filter((e: { tipo: string }) => e.tipo === "VOTO_REGISTRADO").every((e: { ator: string; ip: string }) => e.ator === "eleitor" && e.ip === "-"));

await desconectar();
console.log(falhas ? `\n${falhas} verificação(ões) falharam.` : "\nTodas as verificações passaram.");
process.exit(falhas ? 1 : 0);
