import { Router } from "express";
import { z } from "zod";
import { auditoria, usuarios } from "../db.js";
import { registrarEvento, verificarTrilha } from "../services/auditoria.js";
import { apurar, avancarEstado, eleicaoAtual } from "../services/eleicao.js";
import { amostragem, estadoReplicas, repararNo } from "../services/ledger.js";
import { ator, exigir, ipDe } from "../middleware/seguranca.js";

/* ============================ Administração ============================ */
/* Junta/Mesário: abre e encerra a votação, apura e repara réplicas.       */

export const rotasAdmin = Router();
rotasAdmin.use(exigir("admin"));

rotasAdmin.get("/painel", async (_req, res) => {
  const e = await eleicaoAtual();
  res.json({
    eleicao: { id: e._id, titulo: e.titulo, cargo: e.cargo, estado: e.estado, abertaEm: e.abertaEm, encerradaEm: e.encerradaEm },
    eleitoresAptos: await usuarios().countDocuments({ papel: "eleitor" }),
    comparecimento: await usuarios().countDocuments({ papel: "eleitor", jaVotou: true }),
    replicas: await estadoReplicas(e._id),
  });
});

rotasAdmin.post("/eleicao/abrir", async (req, res) => {
  const e = await avancarEstado("preparada", "aberta");
  await registrarEvento("ELEICAO_ABERTA", ator(req), ipDe(req), { eleicaoId: e._id });
  res.json({ estado: e.estado });
});

rotasAdmin.post("/eleicao/encerrar", async (req, res) => {
  const e = await avancarEstado("aberta", "encerrada");
  await registrarEvento("ELEICAO_ENCERRADA", ator(req), ipDe(req), { eleicaoId: e._id });
  res.json({ estado: e.estado });
});

rotasAdmin.post("/apurar", async (req, res) => {
  const { frase } = z.object({ frase: z.string().min(8).max(200) }).strict().parse(req.body);
  try {
    const boletim = await apurar(frase);
    await registrarEvento("APURACAO_CONCLUIDA", ator(req), ipDe(req), { hashBoletim: boletim.hash, hashFinalLedger: boletim.hashFinalLedger });
    res.json({ boletim });
  } catch (err) {
    await registrarEvento("APURACAO_RECUSADA", ator(req), ipDe(req), { motivo: (err as Error).message });
    throw err;
  }
});

rotasAdmin.post("/nos/:nome/reparar", async (req, res) => {
  const nome = z.string().regex(/^[a-z0-9_]{1,40}$/).parse(req.params.nome);
  const e = await eleicaoAtual();
  const r = await repararNo(nome, e._id);
  await registrarEvento("NO_REPARADO", ator(req), ipDe(req), { no: nome, ...r });
  res.json(r);
});

/* ============================== Auditoria ============================== */
/* Auditores (partidos, MP, OAB...) só LEEM e recalculam. Não escrevem nada. */

export const rotasAuditoria = Router();
rotasAuditoria.use(exigir("auditor", "admin"));

rotasAuditoria.get("/ledger", async (req, res) => {
  const e = await eleicaoAtual();
  const estado = await estadoReplicas(e._id);
  await registrarEvento("AUDITORIA_LEDGER", ator(req), ipDe(req), { consenso: estado.temConsenso });
  res.json(estado);
});

rotasAuditoria.post("/amostragem", async (req, res) => {
  const { tamanho } = z.object({ tamanho: z.number().int().min(1).max(50) }).strict().parse(req.body);
  const e = await eleicaoAtual();
  const r = await amostragem(e._id, tamanho);
  await registrarEvento("AMOSTRAGEM", ator(req), ipDe(req), { amostra: r.amostra, conferidos: r.conferidos });
  res.json(r);
});

rotasAuditoria.get("/eventos", async (_req, res) => {
  const eventos = await auditoria().find({}, { projection: { _id: 0 } }).sort({ seq: -1 }).limit(100).toArray();
  res.json({ verificacao: await verificarTrilha(), eventos });
});
