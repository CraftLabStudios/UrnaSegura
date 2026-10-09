import { auditoria, boletins, usuarios } from "../db.js";
import { eleicaoAtual } from "./eleicao.js";
import { estadoReplicas, noDeReferencia } from "./ledger.js";
import { verificarTrilha } from "./auditoria.js";

/** Eventos que indicam tentativa de abuso/falha — o que o painel de segurança conta. */
export const EVENTOS_ALERTA = [
  "LOGIN_FALHA", "MFA_FALHA", "CONTA_BLOQUEADA", "RATE_LIMIT", "CSRF_BLOQUEADO",
  "ACESSO_NEGADO", "VOTO_DUPLICADO_BLOQUEADO", "VOTO_NAO_REPLICADO", "APURACAO_RECUSADA",
] as const;

const JANELA_HORAS = 24;
const TTL_MS = 5_000;
// Guarda a PROMESSA, não só o resultado: 200 espectadores pedindo ao mesmo tempo disparam um único cálculo.
let cache: { em: number; dados: Promise<Painel> } | null = null;
type Painel = Awaited<ReturnType<typeof calcular>>;

/** Chamado quando o estado muda (abrir, encerrar, apurar, reparar): o painel não pode mostrar dado velho. */
export function limparCacheDashboard() {
  cache = null;
}

/**
 * Painel consolidado (somente leitura) para Junta e Auditores.
 *
 * SIGILO: antes da apuração os votos estão cifrados e NINGUÉM (nem o servidor) vê o placar parcial.
 * O dashboard mostra participação, saúde do ledger e segurança — o resultado só aparece depois que o
 * boletim assinado é publicado. Isso evita influenciar a votação e é o que a lei exige de uma eleição.
 *
 * O resultado é memorizado por poucos segundos: verificar o ledger recalcula hashes e assinaturas de
 * todos os blocos, e vários painéis abertos não devem multiplicar esse custo.
 */
export function montarDashboard(): Promise<Painel> {
  if (cache && Date.now() - cache.em < TTL_MS) return cache.dados;
  const dados = calcular();
  cache = { em: Date.now(), dados };
  dados.catch(() => { cache = null; }); // erro não fica em cache
  return dados;
}

/**
 * Versão PÚBLICA (sem login) para a tela "Resultados ao vivo": participação, ritmo, integridade do ledger e,
 * depois da apuração, o boletim completo e assinado. Nada de trilha de segurança, IPs ou contas bloqueadas.
 * Usa o mesmo cálculo memorizado do painel interno, então muitos espectadores custam quase nada.
 */
export async function painelPublico() {
  const d = await montarDashboard();
  return {
    geradoEm: d.geradoEm,
    eleicao: { titulo: d.eleicao.titulo, estado: d.eleicao.estado, abertaEm: d.eleicao.abertaEm, encerradaEm: d.eleicao.encerradaEm, cargos: d.eleicao.cargos },
    participacao: d.participacao,
    votosPorHora: d.votosPorHora,
    ledger: { temConsenso: d.ledger.temConsenso, quorum: d.ledger.quorum, totalNos: d.ledger.totalNos, nosEmConsenso: d.ledger.nosEmConsenso, hashFinal: d.ledger.hashFinal, nos: d.ledger.nos.map((n) => ({ nome: n.nome, situacao: n.situacao, blocos: n.blocos })) },
    boletim: d.boletimPublico,
  };
}

async function calcular() {
  const e = await eleicaoAtual();
  const agora = new Date();
  const desde = new Date(agora.getTime() - JANELA_HORAS * 3_600_000).toISOString();

  const [aptos, compareceram, contasBloqueadas, replicas, ref, trilha, boletim] = await Promise.all([
    usuarios().countDocuments({ papel: "eleitor" }),
    usuarios().countDocuments({ papel: "eleitor", jaVotou: true }),
    usuarios().countDocuments({ bloqueadoAte: { $gt: agora } }),
    estadoReplicas(e._id),
    noDeReferencia(e._id),
    verificarTrilha(),
    boletins().findOne({ _id: e._id }, { projection: { _id: 0 } }),
  ]);

  // Votos por hora: lidos do nó de referência (o carimbo já é público e truncado ao minuto).
  const votosPorHora = ref.no
    ? await ref.no.blocos
        .aggregate<{ _id: string; n: number }>([
          { $match: { eleicaoId: e._id, tipo: "voto" } },
          { $group: { _id: { $substrBytes: ["$carimboTempo", 0, 13] }, n: { $sum: 1 } } }, // "2026-10-04T09"
          { $sort: { _id: 1 } },
        ])
        .toArray()
    : [];

  const porTipo = await auditoria()
    .aggregate<{ _id: string; n: number }>([
      { $match: { quando: { $gte: desde }, tipo: { $in: [...EVENTOS_ALERTA, "LOGIN_OK"] } } },
      { $group: { _id: "$tipo", n: { $sum: 1 } } },
    ])
    .toArray();
  const contagem = Object.fromEntries(porTipo.map((t) => [t._id, t.n]));

  const alertasPorHora = await auditoria()
    .aggregate<{ _id: string; n: number }>([
      { $match: { quando: { $gte: desde }, tipo: { $in: [...EVENTOS_ALERTA] } } },
      { $group: { _id: { $substrBytes: ["$quando", 0, 13] }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  const ultimosAlertas = await auditoria()
    .find({ tipo: { $in: [...EVENTOS_ALERTA] } }, { projection: { _id: 0, seq: 1, quando: 1, tipo: 1, ator: 1, ip: 1 } })
    .sort({ seq: -1 })
    .limit(8)
    .toArray();

  const nosEmConsenso = replicas.nos.filter((n) => n.situacao === "consenso").length;

  return {
    geradoEm: agora.toISOString(),
    eleicao: {
      id: e._id, titulo: e.titulo, cargos: e.cargos.map((c) => ({ id: c.id, nome: c.nome, candidatos: c.candidatos.length })), estado: e.estado,
      abertaEm: e.abertaEm ?? null, encerradaEm: e.encerradaEm ?? null,
    },
    participacao: {
      aptos,
      compareceram,
      ausentes: aptos - compareceram,
      percentual: aptos ? (compareceram / aptos) * 100 : 0,
      votosNaCadeia: Math.max(replicas.blocosConsenso - 1, 0), // o bloco 0 é o gênese
    },
    votosPorHora: votosPorHora.map((h) => ({ hora: h._id, votos: h.n })),
    ledger: {
      temConsenso: replicas.temConsenso,
      quorum: replicas.quorum,
      totalNos: replicas.totalNos,
      nosEmConsenso,
      hashFinal: replicas.hashFinalConsenso,
      nos: replicas.nos.map((n) => ({ nome: n.nome, situacao: n.situacao, blocos: n.blocos, hashFinal: n.hashFinal })),
    },
    seguranca: {
      janelaHoras: JANELA_HORAS,
      loginsOk: contagem.LOGIN_OK ?? 0,
      alertas: EVENTOS_ALERTA.map((tipo) => ({ tipo, total: contagem[tipo] ?? 0 })),
      totalAlertas: EVENTOS_ALERTA.reduce((s, t) => s + (contagem[t] ?? 0), 0),
      alertasPorHora: alertasPorHora.map((h) => ({ hora: h._id, total: h.n })),
      contasBloqueadas,
      trilha: { integra: trilha.integra, eventos: trilha.total, erro: "erro" in trilha ? trilha.erro : undefined },
      ultimosAlertas,
    },
    // Boletim inteiro (com hash e assinatura) para a tela pública conferir no navegador.
    boletimPublico: boletim,
    // Só existe depois da apuração (boletim assinado). Antes disso: null — sigilo do voto.
    resultado: boletim
      ? {
          cargos: boletim.cargos,
          totalVotos: boletim.totalVotos,
          hashBoletim: boletim.hash,
          geradoEm: boletim.geradoEm,
        }
      : null,
  };
}
