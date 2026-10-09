import { boletins, eleicoes, usuarios, type Boletim, type Cargo, type Eleicao, type EstadoEleicao, type Partido, type ResultadoCargo } from "../db.js";
import { abrirChavePrivadaEleicao, assinarHash, decifrarVoto, type VotoCifrado } from "../crypto/chaves.js";
import { jsonCanonico, sha256Hex } from "../crypto/hash.js";
import { ErroLedger, listarBlocos, noDeReferencia, parametrosEleicao } from "./ledger.js";

export class ErroRegra extends Error {
  constructor(msg: string, public status = 409) {
    super(msg);
  }
}

export async function eleicaoAtual(): Promise<Eleicao> {
  const e = await eleicoes().find().sort({ criadaEm: -1 }).limit(1).next();
  if (!e) throw new ErroRegra("Nenhuma eleição cadastrada. Rode `npm run seed`.", 404);
  return e;
}

const TRANSICOES: Record<EstadoEleicao, EstadoEleicao | null> = {
  preparada: "aberta",
  aberta: "encerrada",
  encerrada: "apurada",
  apurada: null,
};

/** Máquina de estados: preparada → aberta → encerrada → apurada. Não existe volta. */
export async function avancarEstado(de: EstadoEleicao, para: EstadoEleicao): Promise<Eleicao> {
  if (TRANSICOES[de] !== para) throw new ErroRegra(`Transição inválida: ${de} → ${para}`);
  const e = await eleicaoAtual();
  const campo = para === "aberta" ? { abertaEm: new Date() } : para === "encerrada" ? { encerradaEm: new Date() } : {};
  // Filtro pelo estado atual torna a transição atômica (duas requisições simultâneas não abrem duas vezes).
  const r = await eleicoes().findOneAndUpdate(
    { _id: e._id, estado: de },
    { $set: { estado: para, ...campo } },
    { returnDocument: "after" },
  );
  if (!r) throw new ErroRegra(`A eleição não está no estado "${de}".`);
  return r;
}

export function hashBoletim(b: Omit<Boletim, "hash" | "assinatura" | "_id">): string {
  return sha256Hex(jsonCanonico(b));
}

/**
 * Apuração:
 *  1. Verifica todos os nós; exige maioria íntegra e concordante (senão recusa apurar).
 *  2. Confere nº de votos no ledger == nº de eleitores que votaram.
 *  3. Abre a chave privada com a frase da Junta (só em memória) e decifra cada voto.
 *  4. Publica boletim assinado com o hash final da cadeia.
 */
export async function apurar(fraseJunta: string): Promise<Boletim> {
  const e = await eleicaoAtual();
  if (e.estado !== "encerrada") throw new ErroRegra("A apuração só ocorre com a eleição encerrada.");

  const { estado, no } = await noDeReferencia(e._id);
  if (!no || !estado.temConsenso) throw new ErroLedger("Apuração bloqueada: os nós do ledger não estão em consenso.");

  const blocos = await listarBlocos(no, e._id);
  const genesis = blocos[0];
  if (!genesis || genesis.tipo !== "genesis" || (genesis.conteudo as { parametrosEleicao: string }).parametrosEleicao !== parametrosEleicao(e)) {
    throw new ErroLedger("Bloco gênese não confere com os parâmetros da eleição (candidatos/chave foram alterados?).");
  }
  const votos = blocos.filter((b) => b.tipo === "voto");
  const comparecimento = await usuarios().countDocuments({ papel: "eleitor", jaVotou: true });
  if (votos.length !== comparecimento) {
    throw new ErroLedger(`Inconsistência: ${votos.length} votos no ledger x ${comparecimento} eleitores que votaram.`);
  }

  let privada;
  try {
    privada = abrirChavePrivadaEleicao(e.chave, fraseJunta);
  } catch {
    throw new ErroRegra("Frase-senha da Junta Eleitoral incorreta.", 403);
  }

  const contagens = e.cargos.map(novaContagem);
  for (const b of votos) {
    let cedula: Record<string, unknown> = {};
    try {
      const v = decifrarVoto(privada, b.conteudo as VotoCifrado) as { votos?: unknown };
      if (v.votos && typeof v.votos === "object" && !Array.isArray(v.votos)) cedula = v.votos as Record<string, unknown>;
    } catch {
      // cédula ilegível: todos os cargos contam como nulo (e não derruba a apuração)
    }
    e.cargos.forEach((cargo, i) => {
      const escolha = cedula[cargo.id];
      // 2ª vaga de senador no MESMO candidato da 1ª: nulo (cada vaga precisa de um nome diferente).
      const repetido = cargo.id === "senador_2" && typeof escolha === "string" && /^[0-9]+$/.test(escolha) && escolha === cedula.senador_1;
      contar(contagens[i], repetido ? "NULO" : escolha, cargo, e.partidos);
    });
  }

  const base = {
    eleicaoId: e._id,
    titulo: e.titulo,
    cargos: e.cargos.map((cargo, i) => resultadoCargo(cargo, contagens[i], e.partidos)),
    totalVotos: votos.length,
    eleitoresAptos: await usuarios().countDocuments({ papel: "eleitor" }),
    comparecimento,
    hashFinalLedger: blocos[blocos.length - 1].hash,
    blocosNoLedger: blocos.length,
    nosConcordantes: estado.nos.filter((n) => n.situacao === "consenso").map((n) => n.nome),
    geradoEm: new Date().toISOString(),
  };
  const hash = hashBoletim(base);
  const boletim: Boletim = { _id: e._id, ...base, hash, assinatura: assinarHash(hash) };
  await boletins().insertOne(boletim);
  await avancarEstado("encerrada", "apurada");
  return boletim;
}

/* ------------------------------ contagem por cargo ------------------------------ */

interface Contagem { candidatos: Map<string, number>; legendas: Map<string, number>; brancos: number; nulos: number }

const novaContagem = (cargo: Cargo): Contagem => ({ candidatos: new Map(cargo.candidatos.map((c) => [c.numero, 0])), legendas: new Map(), brancos: 0, nulos: 0 });

/**
 * Regras da urna para UM cargo:
 *  - "BRANCO" → branco
 *  - número de candidato existente → voto no candidato
 *  - cargo proporcional (deputados): número que começa com um partido existente → voto de LEGENDA (vai para o partido)
 *  - qualquer outra coisa ("NULO", número inexistente, cargo ausente) → nulo
 */
export function classificar(escolha: unknown, cargo: Cargo, partidos: Partido[]):
  { tipo: "candidato" | "legenda"; numero: string } | { tipo: "branco" | "nulo" } {
  if (escolha === "BRANCO") return { tipo: "branco" };
  if (typeof escolha !== "string" || !/^[0-9]+$/.test(escolha)) return { tipo: "nulo" };
  if (escolha.length === cargo.digitos && cargo.candidatos.some((c) => c.numero === escolha)) return { tipo: "candidato", numero: escolha };
  if (cargo.legenda && (escolha.length === 2 || escolha.length === cargo.digitos) && partidos.some((p) => p.numero === escolha.slice(0, 2))) {
    return { tipo: "legenda", numero: escolha.slice(0, 2) };
  }
  return { tipo: "nulo" };
}

function contar(c: Contagem, escolha: unknown, cargo: Cargo, partidos: Partido[]) {
  const r = classificar(escolha, cargo, partidos);
  if (r.tipo === "candidato") c.candidatos.set(r.numero, c.candidatos.get(r.numero)! + 1);
  else if (r.tipo === "legenda") c.legendas.set(r.numero, (c.legendas.get(r.numero) ?? 0) + 1);
  else if (r.tipo === "branco") c.brancos++;
  else c.nulos++;
}

function resultadoCargo(cargo: Cargo, c: Contagem, partidos: Partido[]): ResultadoCargo {
  const candidatos = cargo.candidatos
    .map((x) => ({ numero: x.numero, nome: x.nome, partido: x.partido, votos: c.candidatos.get(x.numero)! }))
    .sort((a, b) => b.votos - a.votos || a.numero.localeCompare(b.numero));
  const legendas = [...c.legendas]
    .map(([numero, votos]) => ({ numero, sigla: partidos.find((p) => p.numero === numero)?.sigla ?? numero, votos }))
    .sort((a, b) => b.votos - a.votos || a.numero.localeCompare(b.numero));
  const validos = candidatos.reduce((s, x) => s + x.votos, 0) + legendas.reduce((s, x) => s + x.votos, 0);
  return { id: cargo.id, nome: cargo.nome, candidatos, legendas, brancos: c.brancos, nulos: c.nulos, validos };
}
