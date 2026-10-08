import { boletins, eleicoes, usuarios, type Boletim, type Eleicao, type EstadoEleicao } from "../db.js";
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

  const contagem = new Map(e.candidatos.map((c) => [c.numero, 0]));
  let brancos = 0;
  let nulos = 0;
  for (const b of votos) {
    try {
      const v = decifrarVoto(privada, b.conteudo as VotoCifrado) as { escolha?: unknown };
      if (v.escolha === "BRANCO") brancos++;
      else if (typeof v.escolha === "string" && contagem.has(v.escolha)) contagem.set(v.escolha, contagem.get(v.escolha)! + 1);
      else nulos++;
    } catch {
      nulos++; // voto ilegível conta como nulo (e não derruba a apuração)
    }
  }

  const base = {
    eleicaoId: e._id,
    cargo: e.cargo,
    resultado: e.candidatos
      .map((c) => ({ numero: c.numero, nome: c.nome, partido: c.partido, votos: contagem.get(c.numero)! }))
      .sort((a, b) => b.votos - a.votos),
    brancos,
    nulos,
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
