import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { usuarios } from "../db.js";
import { decifrarSegredo } from "../crypto/chaves.js";
import { verificarSenha, verificarSenhaFicticia } from "../crypto/senha.js";
import { verificarTotp } from "../crypto/totp.js";
import { registrarEvento } from "../services/auditoria.js";
import {
  emitirMfaPendente, emitirSessao, encerrarSessao, exigir, ipDe, lerMfaPendente, limiteLogin,
} from "../middleware/seguranca.js";

export const rotasAuth = Router();

const esquemaLogin = z.object({
  usuario: z.string().trim().regex(/^[a-z0-9._-]{3,20}$/i, "Usuário/título inválido"),
  senha: z.string().min(1).max(128),
}).strict();

const esquemaMfa = z.object({ codigo: z.string().regex(/^\d{6}$/, "Código deve ter 6 dígitos") }).strict();

const ERRO_GENERICO = "Usuário ou senha incorretos.";

async function registrarFalha(id: string, ip: string, etapa: "senha" | "mfa") {
  const u = await usuarios().findOneAndUpdate(
    { _id: id },
    { $inc: { tentativasFalhas: 1 } },
    { returnDocument: "after" },
  );
  await registrarEvento(etapa === "senha" ? "LOGIN_FALHA" : "MFA_FALHA", "anonimo", ip, { usuario: id });
  if (u && u.tentativasFalhas >= config.maxTentativasLogin) {
    await usuarios().updateOne(
      { _id: id },
      { $set: { bloqueadoAte: new Date(Date.now() + config.bloqueioMinutos * 60_000), tentativasFalhas: 0 } },
    );
    await registrarEvento("CONTA_BLOQUEADA", "sistema", ip, { usuario: id, minutos: config.bloqueioMinutos });
  }
}

/** Etapa 1: algo que você sabe (senha). */
rotasAuth.post("/login", limiteLogin, async (req, res) => {
  const { usuario, senha } = esquemaLogin.parse(req.body);
  const id = usuario.toLowerCase();
  const u = await usuarios().findOne({ _id: id });

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
  if (u.papel === "eleitor" && u.jaVotou) {
    return res.status(403).json({ erro: "Este eleitor já votou nesta eleição." });
  }

  emitirMfaPendente(res, id);
  res.json({ etapa: "mfa" });
});

/** Etapa 2: algo que você tem (código TOTP do aplicativo autenticador). */
rotasAuth.post("/mfa", limiteLogin, async (req, res) => {
  const { codigo } = esquemaMfa.parse(req.body);
  const id = lerMfaPendente(req);
  if (!id) return res.status(401).json({ erro: "Etapa de senha expirada. Entre novamente." });
  const u = await usuarios().findOne({ _id: id });
  if (!u || (u.bloqueadoAte && u.bloqueadoAte > new Date())) {
    return res.status(401).json({ erro: "Não foi possível concluir o login." });
  }

  const passo = verificarTotp(decifrarSegredo(u.totpCifrado), codigo, u.ultimoPassoTotp);
  // Grava o passo usado de forma condicional: o mesmo código não pode ser usado duas vezes (anti-replay).
  const aceito = passo !== null &&
    (await usuarios().updateOne({ _id: id, ultimoPassoTotp: { $lt: passo } }, { $set: { ultimoPassoTotp: passo, tentativasFalhas: 0 } })).modifiedCount === 1;

  if (!aceito) {
    await registrarFalha(id, ipDe(req), "mfa");
    return res.status(401).json({ erro: "Código de verificação inválido." });
  }

  const sessao = emitirSessao(res, id, u.papel);
  await registrarEvento("LOGIN_OK", u.papel === "eleitor" ? "eleitor" : `${u.papel}:${id}`, ipDe(req));
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
  await encerrarSessao(req, res);
  res.json({ ok: true });
});
