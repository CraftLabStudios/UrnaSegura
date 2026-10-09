/**
 * Prepara o ambiente de demonstração:
 *  - APAGA os bancos da aplicação e dos nós do ledger (somente dev, e somente em MongoDB local!)
 *  - cria a equipe (admin, auditor) com senha + segredo TOTP
 *  - cria eleitores de DEMONSTRAÇÃO ("Vinicius Teste" é o primeiro) que o botão gov.br simulado entrega
 *  - cédula completa de 2026: deputado federal, estadual, senador (2 vagas), governador e presidente
 *    (presidente com os candidatos REAIS do 1º turno; demais cargos fictícios — ver dados-2026.ts)
 *  - gera a chave RSA da eleição (privada cifrada com a frase da Junta) e grava o bloco gênese em todos os nós
 *  - SEED_VOTOS_SIMULADOS (padrão 500): cédulas cifradas de eleitores sintéticos — presidente proporcional ao
 *    resultado real, demais cargos sorteados — espalhadas nas últimas 10 horas; a eleição fica ABERTA.
 *    Use SEED_VOTOS_SIMULADOS=0 para começar do zero (eleição "preparada").
 */
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes, randomInt } from "node:crypto";
import { config } from "../config.js";
import { conectar, desconectar, eleicoes, usuarios, comparecimentos, bancoPrincipal, nos, type Cargo, type Eleicao, type Usuario } from "../db.js";
import { cifrarSegredo, garantirChaveAssinatura, gerarChaveEleicao } from "../crypto/chaves.js";
import { gerarHashSenha } from "../crypto/senha.js";
import { gerarCodigoTotp, gerarSegredoTotp, uriOtpAuth } from "../crypto/totp.js";
import { iniciarLedger, registrarVoto } from "../services/ledger.js";
import { registrarEvento } from "../services/auditoria.js";
import { CANDIDATOS_2026, CARGOS_2026, PARTIDOS_2026, TOTALIZACAO_2026 } from "./dados-2026.js";

if (config.producao) {
  console.error("O seed apaga dados e não roda com NODE_ENV=production.");
  process.exit(1);
}

// Trava: o seed faz dropDatabase. Só roda contra MongoDB local, a menos que se force explicitamente.
const ehLocal = (uri: string) => /^mongodb:\/\/(?:[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?]|$)/i.test(uri);
if (![config.mongoUri, ...config.nosLedger.map((n) => n.uri)].every(ehLocal) && process.env.SEED_PERMITIR_REMOTO !== "sim") {
  console.error("O seed APAGA os bancos e a URI do MongoDB não é local. Se for mesmo um banco de demonstração, rode com SEED_PERMITIR_REMOTO=sim.");
  process.exit(1);
}

/** Recusa cédulas impossíveis antes de gravar a eleição: número fora do tamanho, repetido no cargo ou que não começa pelo número do partido. */
function validarCedula(cargos: Cargo[]): string[] {
  const problemas: string[] = [];
  for (const cargo of cargos) {
    const vistos = new Map<string, string>();
    for (const c of cargo.candidatos) {
      const partido = PARTIDOS_2026.find((p) => p.sigla === c.partido);
      if (!new RegExp(`^[0-9]{${cargo.digitos}}$`).test(c.numero)) problemas.push(`${cargo.nome}: "${c.nome}" tem número ${c.numero}, mas o cargo usa ${cargo.digitos} dígitos.`);
      if (vistos.has(c.numero)) problemas.push(`${cargo.nome}: número ${c.numero} repetido ("${vistos.get(c.numero)}" e "${c.nome}"). Cada número é único no cargo.`);
      vistos.set(c.numero, c.nome);
      if (!partido) problemas.push(`${cargo.nome}: partido "${c.partido}" de "${c.nome}" não está em PARTIDOS_2026.`);
      else if (!c.numero.startsWith(partido.numero)) problemas.push(`${cargo.nome}: "${c.nome}" (${c.partido}) deveria começar com ${partido.numero}, mas é ${c.numero}.`);
    }
  }
  return problemas;
}
const problemasCedula = validarCedula(CARGOS_2026);
if (problemasCedula.length) {
  console.error("A cédula em dados-2026.ts tem problemas — corrija antes de rodar o seed:\n  - " + problemasCedula.join("\n  - "));
  process.exit(1);
}

const FRASE_JUNTA = process.env.JUNTA_PASSPHRASE ?? "junta-eleitoral-demo-2026";
const SENHA_ADMIN = process.env.SEED_SENHA_ADMIN ?? "Admin@2026!";
const SENHA_AUDITOR = process.env.SEED_SENHA_AUDITOR ?? "Auditor@2026!";

garantirChaveAssinatura();
await conectar();

console.log("Limpando bancos de dados de demonstração...");
await bancoPrincipal().dropDatabase();
for (const no of nos) await no.blocos.drop().catch(() => undefined);
await conectar(); // recria índices

/* ------------------------------------ equipe ------------------------------------ */

const linhas: { usuario: string; nome: string; papel: string; senha: string; totp: string; codigoAgora: string }[] = [];

async function criarEquipe(id: string, nome: string, papel: Usuario["papel"], senha: string) {
  const segredo = gerarSegredoTotp();
  await usuarios().insertOne({
    _id: id, nome, papel,
    senhaHash: await gerarHashSenha(senha),
    totpCifrado: cifrarSegredo(segredo),
    ultimoPassoTotp: 0, tentativasFalhas: 0, bloqueadoAte: null, jaVotou: false,
  });
  linhas.push({ usuario: id, nome, papel, senha, totp: uriOtpAuth(segredo, id), codigoAgora: gerarCodigoTotp(segredo) });
}
await criarEquipe("admin", "Junta Eleitoral (Administrador)", "admin", SENHA_ADMIN);
await criarEquipe("auditor", "Auditor Independente", "auditor", SENHA_AUDITOR);

/* ------------------------- eleitores (sem senha utilizável) ------------------------- */

// Eleitores não usam senha nesta simulação (quem autentica é o "gov.br"). Para não deixar campo vazio, todos
// recebem o hash de uma senha aleatória que ninguém conhece; reaproveitado porque gerar centenas de scrypt é lento.
const hashInutil = await gerarHashSenha(randomBytes(24).toString("hex"));
const totpInutil = cifrarSegredo(gerarSegredoTotp());
const eleitor = (id: string, nome: string, extra: Partial<Usuario> = {}): Usuario => ({
  _id: id, nome, papel: "eleitor", senhaHash: hashInutil, totpCifrado: totpInutil,
  ultimoPassoTotp: 0, tentativasFalhas: 0, bloqueadoAte: null, jaVotou: false, ...extra,
});

const NOMES_DEMO = [
  "Vinicius Teste", "Ana Souza", "Bruno Lima", "Carla Mendes", "Diego Rocha", "Elisa Martins", "Fábio Nunes",
  "Gabriela Prado", "Henrique Costa", "Isabela Ramos", "João Pereira", "Karina Duarte", "Leonardo Alves",
  "Mariana Freitas", "Nicolas Barros", "Olívia Campos", "Pedro Henrique Sales", "Quésia Nogueira",
  "Rafael Monteiro", "Sabrina Teles", "Thiago Moura", "Ursula Viana", "Valéria Santos", "William Rocha",
  "Yasmin Cardoso", "Zeca Antunes", "Aline Braga", "Caio Reis", "Débora Lins", "Eduardo Pires",
];
const LOCAIS = [
  { zona: 1, secao: 12, localVotacao: "Escola Municipal Machado de Assis", municipio: "São Paulo", uf: "SP" },
  { zona: 1, secao: 47, localVotacao: "Escola Municipal Machado de Assis", municipio: "São Paulo", uf: "SP" },
  { zona: 2, secao: 8, localVotacao: "Colégio Estadual Cecília Meireles", municipio: "São Paulo", uf: "SP" },
  { zona: 2, secao: 91, localVotacao: "Colégio Estadual Cecília Meireles", municipio: "São Paulo", uf: "SP" },
  { zona: 3, secao: 15, localVotacao: "Centro Comunitário Vila Nova", municipio: "São Paulo", uf: "SP" },
];
const nDemo = Math.min(NOMES_DEMO.length, Math.max(1, Number(process.env.SEED_ELEITORES_DEMO ?? NOMES_DEMO.length) || NOMES_DEMO.length));
await usuarios().insertMany(
  NOMES_DEMO.slice(0, nDemo).map((nome, i) => eleitor(String(i + 1).padStart(12, "0"), nome, { demo: true, reservadoAte: null, ...LOCAIS[i % LOCAIS.length] })),
);

/* ------------------------------------ eleição ------------------------------------ */

console.log("Gerando par de chaves RSA-3072 da eleição...");
const eleicao: Eleicao = {
  _id: "eleicao-simulada-2026",
  titulo: "Eleições Gerais 2026 (simulação)",
  cargos: CARGOS_2026,
  partidos: PARTIDOS_2026,
  estado: "preparada",
  chave: gerarChaveEleicao(FRASE_JUNTA),
  criadaEm: new Date(),
};
await eleicoes().insertOne(eleicao);
const genesis = await iniciarLedger(eleicao);
await registrarEvento("ELEICAO_CRIADA", "sistema", "-", { eleicaoId: eleicao._id, hashGenesis: genesis.bloco.hash });

/* ------------------------------- cédulas simuladas ------------------------------- */

/** Divide `total` entre os pesos pelo método do maior resto (a soma fecha exatamente). */
function repartir(total: number, pesos: number[]): number[] {
  const soma = pesos.reduce((a, b) => a + b, 0);
  const bruto = pesos.map((p) => (p / soma) * total);
  const base = bruto.map(Math.floor);
  const resto = total - base.reduce((a, b) => a + b, 0);
  [...bruto.keys()].sort((a, b) => bruto[b] - base[b] - (bruto[a] - base[a])).slice(0, resto).forEach((i) => base[i]++);
  return base;
}
const embaralhar = <T,>(xs: T[]) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

/** Cifra no servidor exatamente como o navegador (AES-256-GCM + RSA-OAEP-SHA256) — usado só pelo seed. */
function cifrarComoNavegador(votos: Record<string, string>) {
  const aes = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aes, iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ votos, nonce: randomBytes(16).toString("base64") }), "utf8"), c.final(), c.getAuthTag()]);
  const pub = createPublicKey({ key: Buffer.from(eleicao.chave.publicaSpkiB64, "base64"), format: "der", type: "spki" });
  const env = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aes);
  return { chaveEnvelopada: env.toString("base64"), iv: iv.toString("base64"), cifrado: ct.toString("base64") };
}

/** Sorteia uma escolha para um cargo fictício: candidato (pesos aleatórios), legenda, branco ou nulo. */
function sortear(cargo: Cargo, pesos: number[], evitar?: string): string {
  const r = Math.random();
  if (r < 0.03) return "BRANCO";
  if (r < 0.07) return "NULO";
  if (cargo.legenda && r < 0.15) return cargo.candidatos[randomInt(cargo.candidatos.length)].numero.slice(0, 2);
  for (;;) {
    let x = Math.random() * pesos.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < pesos.length - 1 && x > pesos[i]) x -= pesos[i++];
    if (cargo.candidatos[i].numero !== evitar) return cargo.candidatos[i].numero;
  }
}

const NSIM = Math.max(0, Math.floor(Number(process.env.SEED_VOTOS_SIMULADOS ?? 500)) || 0);
let resumoSim = "nenhuma (SEED_VOTOS_SIMULADOS=0): eleição em 'preparada'.";
if (NSIM > 0) {
  const T = TOTALIZACAO_2026;
  // Presidente: proporções REAIS do 1º turno de 2026.
  const brancos = Math.round((NSIM * T.brancos) / T.comparecimento);
  const nulos = Math.round((NSIM * T.nulos) / T.comparecimento);
  const porCandidato = repartir(NSIM - brancos - nulos, CANDIDATOS_2026.map((c) => c.votos));
  const presidente = embaralhar([
    ...CANDIDATOS_2026.flatMap((c, i) => Array<string>(porCandidato[i]).fill(c.numero)),
    ...Array<string>(brancos).fill("BRANCO"),
    ...Array<string>(nulos).fill("NULO"),
  ]);
  // Demais cargos: pesos aleatórios fixos por candidato (dá uma disputa com líderes e lanternas).
  const pesos = Object.fromEntries(CARGOS_2026.map((c) => [c.id, c.candidatos.map(() => 1 + Math.random() * 9)]));
  const cedulas = presidente.map((p) => {
    const v: Record<string, string> = {};
    for (const cargo of CARGOS_2026) {
      if (cargo.id === "presidente") v[cargo.id] = p;
      else v[cargo.id] = sortear(cargo, pesos[cargo.id], cargo.id === "senador_2" ? v.senador_1 : undefined);
    }
    return v;
  });

  const ausentes = Math.round((NSIM * T.abstencao) / T.comparecimento);
  const quemVotou = Array.from({ length: NSIM }, (_, i) => String(200_000_000_001 + i));
  const quemFaltou = Array.from({ length: ausentes }, (_, i) => String(300_000_000_001 + i));
  await usuarios().insertMany([
    ...quemVotou.map((id) => eleitor(id, "Eleitor simulado", { jaVotou: true })),
    ...quemFaltou.map((id) => eleitor(id, "Eleitor simulado (ausente)")),
  ]);
  await comparecimentos().insertMany(quemVotou.map((id) => ({ _id: id })));

  // Curva de um dia de votação: devagar cedo, pico no fim da manhã/começo da tarde, queda no fim.
  const PESO_HORA = [3, 6, 9, 10, 9, 7, 8, 9, 7, 4];
  const MINUTOS = PESO_HORA.length * 60;
  const somaPesos = PESO_HORA.reduce((a, b) => a + b, 0);
  const agora = Date.now();
  const minutos = cedulas
    .map(() => {
      let r = Math.random() * somaPesos;
      let h = 0;
      while (h < PESO_HORA.length - 1 && r > PESO_HORA[h]) r -= PESO_HORA[h++];
      return h * 60 + Math.floor(Math.random() * 60);
    })
    .sort((a, b) => a - b);

  console.log(`Registrando ${NSIM} cédulas cifradas no ledger (3 nós)...`);
  for (let i = 0; i < cedulas.length; i++) {
    const quando = new Date(agora - (MINUTOS - minutos[i]) * 60_000);
    quando.setSeconds(0, 0);
    await registrarVoto(eleicao._id, cifrarComoNavegador(cedulas[i]), quando.toISOString());
  }
  await eleicoes().updateOne({ _id: eleicao._id }, { $set: { estado: "aberta", abertaEm: new Date(agora - MINUTOS * 60_000) } });
  await registrarEvento("ELEICAO_ABERTA", "sistema", "-", { eleicaoId: eleicao._id, origem: "seed" });
  resumoSim = `${NSIM} cédulas + ${ausentes} ausentes; eleição ABERTA. Encerre e apure com a frase da Junta para ver o resultado.`;
}

console.log("\n================ AMBIENTE DE DEMONSTRAÇÃO PRONTO ================\n");
console.log(`Eleitores: botão "Entrar com gov.br" (simulado) → ${nDemo} eleitores de demonstração, a começar por "${NOMES_DEMO[0]}" (título 000000000001).`);
console.log("Equipe: link \"Sou da equipe eleitoral\" → usuário + senha + código:");
console.table(linhas.map(({ usuario, nome, papel, senha, codigoAgora }) => ({ usuario, nome, papel, senha, "código MFA agora": codigoAgora })));
console.log(`Frase-senha da Junta (apuração): ${FRASE_JUNTA}`);
console.log(`Cédulas simuladas: ${resumoSim}`);
console.log(`Bloco gênese gravado em: ${genesis.replicadoEm.join(", ")}  hash ${genesis.bloco.hash.slice(0, 16)}…`);
console.log("\nCódigo MFA atual da equipe:  npm run token -- admin");
console.log("Para usar o celular, cadastre no Google/Microsoft Authenticator a URI otpauth abaixo:\n");
for (const l of linhas) console.log(`  ${l.usuario.padEnd(10)} ${l.totp}`);
await desconectar();
