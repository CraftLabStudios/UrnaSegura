import { Router } from "express";
import { z } from "zod";
import { comparecimentos, usuarios } from "../db.js";
import { registrarEvento } from "../services/auditoria.js";
import { eleicaoAtual, ErroRegra } from "../services/eleicao.js";
import { registrarVoto } from "../services/ledger.js";
import { encerrarSessao, exigir, ipDe, limiteVoto } from "../middleware/seguranca.js";

export const rotasVotacao = Router();

/** Dados públicos da eleição + chave pública que o navegador usa para cifrar o voto. */
rotasVotacao.get("/eleicao", async (_req, res) => {
  const e = await eleicaoAtual();
  res.json({
    id: e._id,
    titulo: e.titulo,
    cargo: e.cargo,
    estado: e.estado,
    candidatos: e.candidatos,
    chavePublica: e.chave.publicaSpkiB64,
    impressaoDigitalChave: e.chave.impressaoDigital,
  });
});

const b64 = (min: number, max: number) =>
  z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).refine((s) => {
    const n = Buffer.from(s, "base64").length;
    return n >= min && n <= max;
  }, "tamanho inválido");

/**
 * O servidor recebe SOMENTE o voto cifrado. Ele valida o formato, mas não consegue ler o conteúdo.
 * RSA-3072 → chave envelopada tem exatamente 384 bytes; IV do GCM tem 12 bytes.
 */
const esquemaVoto = z.object({
  chaveEnvelopada: b64(384, 384),
  iv: b64(12, 12),
  cifrado: b64(17, 1024),
}).strict();

rotasVotacao.post("/votos", exigir("eleitor"), limiteVoto, async (req, res) => {
  const voto = esquemaVoto.parse(req.body);
  const e = await eleicaoAtual();
  if (e.estado !== "aberta") throw new ErroRegra("A votação não está aberta.");

  // VOTO ÚNICO — barreira dupla contra cliques/requisições simultâneas:
  //  1) inserção com _id = título: o índice único do _id só deixa UMA inserção passar (atômico no banco);
  //  2) troca condicional jaVotou false → true.
  // Não há horário nem referência ao voto nesse registro: ele só diz "compareceu".
  const id = req.sessao!.sub;
  let marcado = false;
  try {
    await comparecimentos().insertOne({ _id: id });
    marcado = !!(await usuarios().findOneAndUpdate({ _id: id, papel: "eleitor", jaVotou: false }, { $set: { jaVotou: true } }));
    if (!marcado) await comparecimentos().deleteOne({ _id: id }).catch(() => undefined);
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err; // 11000 = chave duplicada → já votou
  }
  if (!marcado) {
    await registrarEvento("VOTO_DUPLICADO_BLOQUEADO", "eleitor", ipDe(req));
    await encerrarSessao(req, res);
    return res.status(409).json({ erro: "Este eleitor já votou. Segunda tentativa registrada na auditoria." });
  }

  let resultado;
  try {
    resultado = await registrarVoto(e._id, voto);
  } catch (err) {
    // Compensação: se o ledger não confirmou o voto, o eleitor pode tentar de novo.
    await usuarios().updateOne({ _id: id }, { $set: { jaVotou: false } });
    await comparecimentos().deleteOne({ _id: id });
    await registrarEvento("VOTO_NAO_REPLICADO", "sistema", "-", { motivo: (err as Error).message });
    throw err;
  }

  // Sem IP, sem identificação, sem número do bloco: a trilha não liga o eleitor ao voto.
  await registrarEvento("VOTO_REGISTRADO", "eleitor", "-", { replicadoEm: resultado.replicadoEm.length, falharam: resultado.falharam });
  await encerrarSessao(req, res); // sessão encerrada automaticamente após votar

  res.status(201).json({
    comprovante: {
      hash: resultado.bloco.hash,
      seq: resultado.bloco.seq,
      carimboTempo: resultado.bloco.carimboTempo,
      assinatura: resultado.bloco.assinatura,
      replicadoEm: resultado.replicadoEm,
    },
  });
});
