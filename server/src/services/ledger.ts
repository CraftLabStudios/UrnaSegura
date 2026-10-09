import { randomInt } from "node:crypto";
import { nos, type BlocoLedger, type Eleicao, type NoLedger } from "../db.js";
import { HASH_GENESIS, jsonCanonico, sha256Hex } from "../crypto/hash.js";
import { assinarHash, verificarAssinatura, type VotoCifrado } from "../crypto/chaves.js";
import { Fila } from "./fila.js";

/**
 * LEDGER DE VOTOS — "blockchain simplificada"
 *
 *  - Append-only: o código só faz INSERT. Não existe rota de UPDATE/DELETE de voto.
 *  - Hash encadeado: cada bloco guarda o hash do anterior. Alterar um bloco quebra todos os seguintes.
 *  - Assinatura Ed25519 em cada bloco (carimbo de tempo assinado pelo servidor).
 *  - Replicação: cada bloco é gravado em N nós (ex.: TSE, TRE-SC, TRE-SP). Só é confirmado
 *    se a MAIORIA gravar (quórum). A auditoria compara os nós entre si.
 *  - Anonimato: nenhum bloco contém identificação do eleitor; o conteúdo é o voto já cifrado.
 */

const fila = new Fila();
export const quorum = () => Math.floor(nos.length / 2) + 1;

type BaseBloco = Pick<BlocoLedger, "seq" | "eleicaoId" | "hashAnterior" | "carimboTempo" | "tipo" | "hashConteudo">;

export function calcularHashBloco(b: BaseBloco): string {
  return sha256Hex(
    jsonCanonico({
      seq: b.seq,
      eleicaoId: b.eleicaoId,
      hashAnterior: b.hashAnterior,
      carimboTempo: b.carimboTempo,
      tipo: b.tipo,
      hashConteudo: b.hashConteudo,
    }),
  );
}

export const calcularHashConteudo = (c: BlocoLedger["conteudo"]) => sha256Hex(jsonCanonico(c));

function carimboMinuto(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return d.toISOString();
}

export function parametrosEleicao(e: Pick<Eleicao, "_id" | "cargos" | "partidos" | "chave">): string {
  return sha256Hex(
    jsonCanonico({
      eleicaoId: e._id,
      cargos: e.cargos,
      partidos: e.partidos,
      chavePublica: e.chave.impressaoDigital,
    }),
  );
}

/** Último bloco de cada nó acessível; devolve o "topo" em que a maioria concorda. */
async function topoConsenso(eleicaoId: string) {
  const topos = await Promise.all(
    nos.map(async (no) => {
      try {
        const b = await no.blocos.find({ eleicaoId }).sort({ seq: -1 }).limit(1).next();
        return { no, topo: b };
      } catch {
        return { no, topo: undefined };
      }
    }),
  );
  const votos = new Map<string, { bloco: BlocoLedger | null; nos: NoLedger[] }>();
  for (const t of topos) {
    if (t.topo === undefined) continue;
    const chave = t.topo ? `${t.topo.seq}:${t.topo.hash}` : "vazio";
    const g = votos.get(chave) ?? { bloco: t.topo, nos: [] };
    g.nos.push(t.no);
    votos.set(chave, g);
  }
  const maior = [...votos.values()].sort((a, b) => b.nos.length - a.nos.length)[0];
  if (!maior || maior.nos.length < quorum()) {
    throw new ErroLedger("Sem quórum entre os nós do ledger. Votação suspensa por segurança.");
  }
  return maior;
}

export class ErroLedger extends Error {}

async function anexar(eleicaoId: string, tipo: BlocoLedger["tipo"], conteudo: BlocoLedger["conteudo"], carimbo?: string) {
  return fila.executar(async () => {
    const { bloco: topo, nos: nosEmDia } = await topoConsenso(eleicaoId);
    const base: BaseBloco = {
      seq: topo ? topo.seq + 1 : 0,
      eleicaoId,
      hashAnterior: topo ? topo.hash : HASH_GENESIS,
      carimboTempo: carimbo ?? carimboMinuto(),
      tipo,
      hashConteudo: calcularHashConteudo(conteudo),
    };
    if (tipo === "genesis" && base.seq !== 0) throw new ErroLedger("Ledger já iniciado para esta eleição.");
    const hash = calcularHashBloco(base);
    const bloco: BlocoLedger = { ...base, conteudo, hash, assinatura: assinarHash(hash) };

    // Grava em paralelo apenas nos nós que estão em dia com o consenso.
    const resultados = await Promise.allSettled(nosEmDia.map((no) => no.blocos.insertOne({ ...bloco })));
    const gravados = nosEmDia.filter((_, i) => resultados[i].status === "fulfilled");

    if (gravados.length < quorum()) {
      // Bloco não atingiu quórum: não foi confirmado. Remove das réplicas que chegaram a gravar.
      await Promise.allSettled(gravados.map((no) => no.blocos.deleteOne({ eleicaoId, seq: bloco.seq, hash })));
      throw new ErroLedger("Falha ao replicar o voto na maioria dos nós. Voto NÃO registrado.");
    }
    const falharam = nos.filter((n) => !gravados.includes(n)).map((n) => n.nome);
    return { bloco, replicadoEm: gravados.map((n) => n.nome), falharam };
  });
}

export function iniciarLedger(eleicao: Eleicao) {
  return anexar(eleicao._id, "genesis", { parametrosEleicao: parametrosEleicao(eleicao) });
}

/** `carimbo` existe só para o seed (horários espalhados nos votos de demonstração); a rota HTTP nunca o passa. */
export function registrarVoto(eleicaoId: string, voto: VotoCifrado, carimbo?: string) {
  return anexar(eleicaoId, "voto", voto, carimbo);
}

/* ---------------------------- verificação ---------------------------- */

export interface ResultadoNo {
  nome: string;
  disponivel: boolean;
  integro: boolean;
  blocos: number;
  hashFinal: string | null;
  erro?: { seq: number; motivo: string };
}

export function validarBloco(b: BlocoLedger, seqEsperado: number, anterior: string): string | null {
  if (b.seq !== seqEsperado) return `sequência pulada (esperado ${seqEsperado}, encontrado ${b.seq})`;
  if (b.hashAnterior !== anterior) return "elo quebrado: hashAnterior não aponta para o bloco anterior";
  if (calcularHashConteudo(b.conteudo) !== b.hashConteudo) return "conteúdo do voto alterado (hashConteudo não confere)";
  if (calcularHashBloco(b) !== b.hash) return "cabeçalho alterado (hash do bloco não confere)";
  if (!verificarAssinatura(b.hash, b.assinatura)) return "assinatura digital inválida";
  return null;
}

export async function verificarNo(no: NoLedger, eleicaoId: string): Promise<ResultadoNo> {
  try {
    let anterior = HASH_GENESIS;
    let n = 0;
    for await (const b of no.blocos.find({ eleicaoId }).sort({ seq: 1 })) {
      const erro = validarBloco(b, n, anterior);
      if (erro) return { nome: no.nome, disponivel: true, integro: false, blocos: n, hashFinal: anterior, erro: { seq: b.seq, motivo: erro } };
      anterior = b.hash;
      n++;
    }
    return { nome: no.nome, disponivel: true, integro: true, blocos: n, hashFinal: n ? anterior : null };
  } catch {
    return { nome: no.nome, disponivel: false, integro: false, blocos: 0, hashFinal: null };
  }
}

export type SituacaoNo = "consenso" | "atrasado" | "corrompido" | "divergente" | "indisponivel";

/** Verifica cada nó e compara os hashes finais entre eles (tolerância a falhas por maioria). */
export async function estadoReplicas(eleicaoId: string) {
  const res = await Promise.all(nos.map((no) => verificarNo(no, eleicaoId)));
  const grupos = new Map<string, ResultadoNo[]>();
  for (const r of res.filter((r) => r.integro)) {
    const k = `${r.blocos}:${r.hashFinal}`;
    grupos.set(k, [...(grupos.get(k) ?? []), r]);
  }
  const maior = [...grupos.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const temConsenso = maior.length >= quorum();
  const ref = temConsenso ? maior[0] : null;

  const nosComSituacao = res.map((r) => {
    let situacao: SituacaoNo;
    if (!r.disponivel) situacao = "indisponivel";
    else if (!r.integro) situacao = "corrompido";
    else if (ref && r.hashFinal === ref.hashFinal && r.blocos === ref.blocos) situacao = "consenso";
    else if (ref && r.blocos < ref.blocos) situacao = "atrasado";
    else situacao = "divergente";
    return { ...r, situacao };
  });

  return {
    quorum: quorum(),
    totalNos: nos.length,
    temConsenso,
    hashFinalConsenso: ref?.hashFinal ?? null,
    blocosConsenso: ref?.blocos ?? 0,
    nos: nosComSituacao,
  };
}

/** Nó de referência (íntegro e em consenso) usado para leitura pública, apuração e reparo. */
export async function noDeReferencia(eleicaoId: string) {
  const estado = await estadoReplicas(eleicaoId);
  const nome = estado.nos.find((n) => n.situacao === "consenso")?.nome;
  return { estado, no: nome ? nos.find((n) => n.nome === nome)! : null };
}

/** Restaura um nó corrompido/atrasado copiando os blocos da maioria íntegra a partir do ponto de divergência. */
export async function repararNo(nomeNo: string, eleicaoId: string) {
  return fila.executar(async () => {
    const { estado, no: fonte } = await noDeReferencia(eleicaoId);
    if (!fonte) throw new ErroLedger("Não há maioria íntegra para servir de fonte do reparo.");
    const alvo = nos.find((n) => n.nome === nomeNo);
    if (!alvo) throw new ErroLedger("Nó inexistente.");
    if (alvo === fonte) return { substituidos: 0, aPartirDe: null as number | null };

    const blocosFonte = await fonte.blocos.find({ eleicaoId }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray();
    const blocosAlvo = await alvo.blocos.find({ eleicaoId }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray();
    let i = 0;
    while (i < blocosFonte.length && i < blocosAlvo.length && blocosAlvo[i].hash === blocosFonte[i].hash &&
      validarBloco(blocosAlvo[i], i, i ? blocosFonte[i - 1].hash : HASH_GENESIS) === null) i++;

    await alvo.blocos.deleteMany({ eleicaoId, seq: { $gte: i } });
    const faltantes = blocosFonte.slice(i);
    if (faltantes.length) await alvo.blocos.insertMany(faltantes.map((b) => ({ ...b })));
    return { substituidos: faltantes.length, aPartirDe: i, hashFinal: estado.hashFinalConsenso };
  });
}

/** Comprovante do eleitor: em quais nós o bloco existe e é válido. */
export async function localizarBloco(hash: string) {
  const achados = await Promise.all(
    nos.map(async (no) => {
      try {
        const b = await no.blocos.findOne({ hash }, { projection: { _id: 0 } });
        return { no: no.nome, presente: !!b, assinaturaValida: b ? verificarAssinatura(b.hash, b.assinatura) && calcularHashBloco(b) === b.hash : false, seq: b?.seq ?? null, carimboTempo: b?.carimboTempo ?? null };
      } catch {
        return { no: no.nome, presente: false, assinaturaValida: false, seq: null, carimboTempo: null };
      }
    }),
  );
  return achados;
}

/** Recontagem por amostragem: sorteia blocos e confere se são idênticos e válidos em TODOS os nós. */
export async function amostragem(eleicaoId: string, tamanho: number) {
  const { estado, no: ref } = await noDeReferencia(eleicaoId);
  if (!ref) throw new ErroLedger("Sem consenso entre os nós.");
  const totalVotos = estado.blocosConsenso - 1;
  const sorteados = new Set<number>();
  while (sorteados.size < Math.min(tamanho, totalVotos)) sorteados.add(1 + randomInt(totalVotos));

  const itens = [];
  for (const seq of [...sorteados].sort((a, b) => a - b)) {
    const porNo = await Promise.all(
      nos.map(async (no) => {
        try {
          const b = await no.blocos.findOne({ eleicaoId, seq });
          if (!b) return { no: no.nome, hash: null, valido: false };
          const valido = calcularHashConteudo(b.conteudo) === b.hashConteudo && calcularHashBloco(b) === b.hash && verificarAssinatura(b.hash, b.assinatura);
          return { no: no.nome, hash: b.hash, valido };
        } catch {
          return { no: no.nome, hash: null, valido: false };
        }
      }),
    );
    // Conferido só se o bloco existir, for válido e for IDÊNTICO em todos os nós.
    const conferido = porNo.every((p) => p.valido) && new Set(porNo.map((p) => p.hash)).size === 1;
    itens.push({ seq, porNo, conferido });
  }
  return { totalVotos, amostra: itens.length, conferidos: itens.filter((i) => i.conferido).length, itens };
}

export async function listarBlocos(no: NoLedger, eleicaoId: string) {
  return no.blocos.find({ eleicaoId }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray();
}
