import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { usuarios } from "../db.js";
import { decifrarSegredo } from "../crypto/chaves.js";
import { verificarSenha, verificarSenhaFicticia } from "../crypto/senha.js";
import { verificarTotp } from "../crypto/totp.js";
import { registrarEvento } from "../services/auditoria.js";
import {
  emitirFluxo, emitirSessao, encerrarSessao, exigir, ipDe, lerFluxo, limiteFluxo, limiteLogin,
} from "../middleware/seguranca.js";

/**
 * Dois caminhos de entrada:
 *
 *  ELEITOR  → botão "Entrar com gov.br" (SIMULADO). Na vida real o gov.br faria a autenticação forte (OAuth/OpenID
 *             Connect) e devolveria quem é a pessoa. Aqui o servidor entrega um eleitor de demonstração que ainda não
 *             votou. Só funciona com GOVBR_SIMULADO ligado (padrão em desenvolvimento; desligado em produção).
 *  EQUIPE   → usuário + senha + código TOTP (Junta e auditores continuam com autenticação forte de verdade).
 */
export const rotasAuth = Router();

const esquemaLogin = z.object({
  usuario: z.string().trim().regex(/^[a-z][a-z0-9._-]{2,19}$/i, "Usuário inválido"),
  senha: z.string().min(1).max(128),
}).strict();
const esquemaMfa = z.object({ codigo: z.string().regex(/^\d{6}$/, "Código deve ter 6 dígitos") }).strict();

const ERRO_GENERICO = "Usuário ou senha incorretos.";

async function registrarFalha(id: string, ip: string, etapa: "senha" | "mfa") {
  const u = await usuarios().findOneAndUpdate({ _id: id }, { $inc: { tentativasFalhas: 1 } }, { returnDocument: "after" });
  await registrarEvento(etapa === "senha" ? "LOGIN_FALHA" : "MFA_FALHA", "anonimo", ip, { usuario: id });
  if (u && u.tentativasFalhas >= config.maxTentativasLogin) {
    await usuarios().updateOne(
      { _id: id },
      { $set: { bloqueadoAte: new Date(Date.now() + config.bloqueioMinutos * 60_000), tentativasFalhas: 0 } },
    );
    await registrarEvento("CONTA_BLOQUEADA", "sistema", ip, { usuario: id, minutos: config.bloqueioMinutos });
  }
}

/* ============================ Eleitor: gov.br simulado ============================ */

rotasAuth.post("/govbr", limiteFluxo, async (req, res) => {
  z.object({}).strict().parse(req.body);
  if (!config.govbrSimulado) return res.status(404).json({ erro: "Login gov.br simulado desativado neste servidor." });

  // Reserva atômica: o primeiro eleitor de demonstração que não votou e não está reservado por outro clique.
  const agora = new Date();
  const u = await usuarios().findOneAndUpdate(
    { papel: "eleitor", demo: true, jaVotou: false, $or: [{ reservadoAte: null }, { reservadoAte: { $exists: false } }, { reservadoAte: { $lt: agora } }] },
    { $set: { reservadoAte: new Date(agora.getTime() + config.sessaoMinutos * 60_000) } },
    { sort: { _id: 1 }, returnDocument: "after" },
  );
  if (!u) return res.status(409).json({ erro: "Todos os eleitores de demonstração já votaram ou estão em uso. Rode `npm run seed` para recomeçar." });

  const sessao = emitirSessao(res, u._id, "eleitor");
  await registrarEvento("LOGIN_OK", "eleitor", ipDe(req), { via: "govbr-simulado" });
  res.json({
    usuario: { nome: u.nome, papel: u.papel },
    eleitor: { nome: u.nome, titulo: u._id, zona: u.zona ?? null, secao: u.secao ?? null, localVotacao: u.localVotacao ?? null, municipio: u.municipio ?? null, uf: u.uf ?? null },
    ...sessao,
  });
});

/* ============================ Equipe: senha + TOTP ============================ */

/** Etapa 1: algo que você sabe (senha). */
rotasAuth.post("/login", limiteLogin, async (req, res) => {
  const { usuario, senha } = esquemaLogin.parse(req.body);
  const id = usuario.toLowerCase();
  const u = await usuarios().findOne({ _id: id, papel: { $in: ["admin", "auditor"] } });

  if (!u) {
    await verificarSenhaFicticia(senha); // mesmo tempo de resposta de um usuário existente
    await registrarEvento("LOGIN_FALHA", "anonimo", ipDe(req), { usuario: "(inexistente)" });
    return res.status(401).json({ erro: ERRO_GENERICO });
  }
  if (u.bloqueadoAte && u.bloqueadoAte > new Date()) {
    await verificarSenhaFicticia(senha);
    return res.status(429).json({ erro: `Conta bloqueada temporariamente por excesso de tentativas. Tente após ${config.bloqueioMinutos} minutos.` });
  }
  if (!(await verificarSenha(senha, u.senhaHash))) {
    await registrarFalha(id, ipDe(req), "senha");
    return res.status(401).json({ erro: ERRO_GENERICO });
  }

  emitirFluxo(res, id, "mfa");
  res.json({ etapa: "mfa" });
});

/** Etapa 2: algo que você tem (código TOTP do aplicativo autenticador). */
rotasAuth.post("/mfa", limiteLogin, async (req, res) => {
  const { codigo } = esquemaMfa.parse(req.body);
  const f = lerFluxo(req);
  if (!f || f.etapa !== "mfa") return res.status(401).json({ erro: "Etapa de senha expirada. Entre novamente." });
  const u = await usuarios().findOne({ _id: f.sub });
  if (!u || u.papel === "eleitor" || (u.bloqueadoAte && u.bloqueadoAte > new Date())) {
    return res.status(401).json({ erro: "Não foi possível concluir o login." });
  }

  const passo = verificarTotp(decifrarSegredo(u.totpCifrado), codigo, u.ultimoPassoTotp);
  // Grava o passo usado de forma condicional: o mesmo código não pode ser usado duas vezes (anti-replay).
  const aceito = passo !== null &&
    (await usuarios().updateOne({ _id: u._id, ultimoPassoTotp: { $lt: passo } }, { $set: { ultimoPassoTotp: passo, tentativasFalhas: 0 } })).modifiedCount === 1;
  if (!aceito) {
    await registrarFalha(u._id, ipDe(req), "mfa");
    return res.status(401).json({ erro: "Código de verificação inválido." });
  }

  const sessao = emitirSessao(res, u._id, u.papel);
  await registrarEvento("LOGIN_OK", `${u.papel}:${u._id}`, ipDe(req));
  res.json({ usuario: { nome: u.nome, papel: u.papel }, ...sessao });
});

rotasAuth.get("/me", exigir(), async (req, res) => {
  const u = await usuarios().findOne({ _id: req.sessao!.sub }, { projection: { nome: 1, papel: 1 } });
  if (!u) return res.status(401).json({ erro: "Sessão inválida." });
  res.json({
    usuario: { nome: u.nome, papel: u.papel },
    csrf: req.cookies?.csrf ?? null,
    expiraEm: new Date(req.sessao!.exp * 1000).toISOString(),
  });
});

rotasAuth.post("/logout", exigir(), async (req, res) => {
  // Eleitor que desiste sem votar devolve a reserva: o próximo clique no gov.br pode recebê-lo.
  if (req.sessao!.papel === "eleitor") await usuarios().updateOne({ _id: req.sessao!.sub, jaVotou: false }, { $set: { reservadoAte: null } });
  await encerrarSessao(req, res);
  res.json({ ok: true });
});
