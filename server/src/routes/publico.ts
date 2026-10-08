import { Router } from "express";
import { z } from "zod";
import { boletins } from "../db.js";
import { chavePublicaAssinaturaSpki } from "../crypto/chaves.js";
import { eleicaoAtual } from "../services/eleicao.js";
import { listarBlocos, localizarBloco, noDeReferencia } from "../services/ledger.js";

/**
 * Transparência: qualquer pessoa, sem login, pode baixar a cadeia, as chaves públicas e o boletim
 * e verificar tudo por conta própria (a página /verificar faz isso no navegador).
 */
export const rotasPublicas = Router();

rotasPublicas.get("/chaves", async (_req, res) => {
  const e = await eleicaoAtual();
  res.json({
    assinaturaEd25519Spki: chavePublicaAssinaturaSpki(),
    eleicaoRsaSpki: e.chave.publicaSpkiB64,
    impressaoDigitalEleicao: e.chave.impressaoDigital,
  });
});

rotasPublicas.get("/ledger", async (_req, res) => {
  const e = await eleicaoAtual();
  const { estado, no } = await noDeReferencia(e._id);
  res.json({
    eleicaoId: e._id,
    fonte: no?.nome ?? null,
    hashFinalConsenso: estado.hashFinalConsenso,
    nos: estado.nos.map((n) => ({ nome: n.nome, situacao: n.situacao, blocos: n.blocos, hashFinal: n.hashFinal })),
    blocos: no ? await listarBlocos(no, e._id) : [],
  });
});

rotasPublicas.get("/comprovante/:hash", async (req, res) => {
  const hash = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.hash.toLowerCase());
  const nos = await localizarBloco(hash);
  res.json({ hash, encontrado: nos.some((n) => n.presente && n.assinaturaValida), nos });
});

rotasPublicas.get("/boletim", async (_req, res) => {
  const e = await eleicaoAtual();
  const b = await boletins().findOne({ _id: e._id });
  if (!b) return res.status(404).json({ erro: "Boletim ainda não publicado.", estado: e.estado });
  const { _id, ...boletim } = b;
  res.json({ boletim });
});
