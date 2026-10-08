/**
 * Teste de ponta a ponta + testes de ataque contra a API em execução.
 * Pré-requisitos: `npm run seed` e servidor rodando (`npm run dev` ou `npm start`).
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
async function login(id: string, senha: string) {
  const c = new Cliente();
  const a = await c.req("POST", "/auth/login", { usuario: id, senha });
  if (a.status !== 200) return { c, status: a.status, dados: a.dados };
  // usa o próximo passo de tempo para não colidir com o anti-replay em logins seguidos do mesmo usuário
  const u = await usuarios().findOne({ _id: id });
  const extra = u!.ultimoPassoTotp >= passoAtual() ? 1 : 0;
  const b = await c.req("POST", "/auth/mfa", { codigo: await codigo(id, extra) });
  c.csrf = b.dados.csrf ?? "";
  return { c, status: b.status, dados: b.dados };
}

const eleicao = (await new Cliente().req("GET", "/eleicao")).dados;

console.log("\n1) Autenticação");
const admin = await login("admin", "Admin@2026!");
checar("admin entra com senha + TOTP", admin.status === 200, admin.dados);
const semMfa = new Cliente();
await semMfa.req("POST", "/auth/login", { usuario: "admin", senha: "Admin@2026!" });
checar("só a senha não dá acesso ao painel (falta o 2º fator)", (await semMfa.req("GET", "/admin/painel")).status === 401);
const replay = await semMfa.req("POST", "/auth/mfa", { codigo: await codigo("admin", 0) }); // mesmo código usado pelo admin acima
checar("código TOTP já usado é recusado (anti-replay)", replay.status === 401, replay);

console.log("\n2) Ataques de entrada");
const nosql = await new Cliente().req("POST", "/auth/login", { usuario: { $ne: "" }, senha: { $ne: "" } });
checar("NoSQL injection {\"$ne\": \"\"} bloqueada (400)", nosql.status === 400, nosql);
const form = await new Cliente().req("POST", "/auth/login", "usuario=admin&senha=x", { tipo: "application/x-www-form-urlencoded" });
checar("POST que não é JSON recusado (415) — barra CSRF via formulário", form.status === 415);
const csrf = await admin.c.req("POST", "/admin/eleicao/abrir", {}, { semCsrf: true });
checar("requisição sem token CSRF recusada (403)", csrf.status === 403, csrf);
const grande = await new Cliente().req("POST", "/auth/login", { usuario: "admin", senha: "x".repeat(20000) });
checar("corpo acima de 16 KB recusado (413)", grande.status === 413, grande.status);

console.log("\n3) Abertura e votação");
checar("eleitor não vota antes da abertura", (await (await login("000000000009", "Eleitor@2026")).c.req("POST", "/votos", await cifrarVoto("10", eleicao.chavePublica))).status === 409);
checar("admin abre a votação", (await admin.c.req("POST", "/admin/eleicao/abrir")).status === 200);
const escolhas = ["10", "10", "25", "BRANCO", "99", "40"];
const comprovantes: string[] = [];
for (let i = 0; i < escolhas.length; i++) {
  const id = String(i + 1).padStart(12, "0");
  const e = await login(id, "Eleitor@2026");
  const v = await e.c.req("POST", "/votos", await cifrarVoto(escolhas[i], eleicao.chavePublica));
  checar(`eleitor ${id} vota (${escolhas[i]})`, v.status === 201, v.dados);
  if (v.status === 201) comprovantes.push(v.dados.comprovante.hash);
  if (i === 0) {
    checar("sessão é encerrada após votar", (await e.c.req("GET", "/auth/me")).status === 401);
    checar("eleitor que já votou não consegue entrar de novo", (await login(id, "Eleitor@2026")).status === 403);
  }
}
const comp = (await new Cliente().req("GET", `/public/comprovante/${comprovantes[0]}`)).dados;
checar("comprovante encontrado e válido em todos os nós", comp.encontrado && comp.nos.every((n: { presente: boolean }) => n.presente), comp);

console.log("\n4) Voto duplo simultâneo (condição de corrida)");
const corrida = await login("000000000007", "Eleitor@2026");
const tentativas = await Promise.all(Array.from({ length: 5 }, async () => corrida.c.req("POST", "/votos", await cifrarVoto("77", eleicao.chavePublica))));
const aceitos = tentativas.filter((t) => t.status === 201).length;
checar(`5 envios simultâneos → exatamente 1 voto aceito (aceitos: ${aceitos})`, aceitos === 1, tentativas.map((t) => t.status));

console.log("\n5) Controle de acesso");
const eleitor = await login("000000000008", "Eleitor@2026");
checar("eleitor não acessa o painel da Junta (403)", (await eleitor.c.req("GET", "/admin/painel")).status === 403);
checar("eleitor não acessa a auditoria (403)", (await eleitor.c.req("GET", "/auditoria/ledger")).status === 403);
const auditor = await login("auditor", "Auditor@2026!");
checar("auditor lê o ledger", (await auditor.c.req("GET", "/auditoria/ledger")).status === 200);
checar("auditor NÃO pode encerrar a eleição (403)", (await auditor.c.req("POST", "/admin/eleicao/encerrar")).status === 403);
const forjado = new Cliente();
forjado.cookies.set("sessao", "eyJhbGciOiJub25lIn0.eyJwYXBlbCI6ImFkbWluIiwidGlwbyI6InNlc3NhbyIsInN1YiI6ImFkbWluIiwianRpIjoieCJ9.");
checar("JWT forjado com alg=none recusado (401)", (await forjado.req("GET", "/admin/painel")).status === 401);

console.log("\n6) Força bruta");
const res = [];
for (let i = 0; i < 6; i++) res.push((await new Cliente().req("POST", "/auth/login", { usuario: "000000000010", senha: "errada" + i })).status);
checar("após 5 senhas erradas a conta é bloqueada (429)", res[5] === 429, res);
const certa = await new Cliente().req("POST", "/auth/login", { usuario: "000000000010", senha: "Eleitor@2026" });
checar("conta bloqueada recusa até a senha certa", certa.status === 429);

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

console.log("\n8) Encerramento, apuração e verificação independente");
checar("admin encerra a votação", (await admin.c.req("POST", "/admin/eleicao/encerrar")).status === 200);
const tarde = await login("000000000009", "Eleitor@2026");
checar("ninguém vota depois do encerramento", (await tarde.c.req("POST", "/votos", await cifrarVoto("10", eleicao.chavePublica))).status === 409);
checar("frase da Junta errada não abre a chave (403)", (await admin.c.req("POST", "/admin/apurar", { frase: "frase-errada-123" })).status === 403);
const ap = await admin.c.req("POST", "/admin/apurar", { frase: FRASE });
checar("apuração concluída", ap.status === 200, ap.dados);
const b = ap.dados.boletim;
const votos = Object.fromEntries(b.resultado.map((r: { numero: string; votos: number }) => [r.numero, r.votos]));
checar(`contagem correta: 10=${votos["10"]} 25=${votos["25"]} 40=${votos["40"]} 77=${votos["77"]} brancos=${b.brancos} nulos=${b.nulos}`,
  votos["10"] === 2 && votos["25"] === 1 && votos["40"] === 1 && votos["77"] === 1 && b.brancos === 1 && b.nulos === 1);

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
