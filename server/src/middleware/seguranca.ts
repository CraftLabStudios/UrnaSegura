import type { NextFunction, Request, Response } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";
import { sessoesRevogadas, usuarios, type Papel } from "../db.js";
import { registrarEvento } from "../services/auditoria.js";

/* ============================== Sessão (JWT) ============================== */

export interface Sessao {
  sub: string;
  papel: Papel;
  jti: string;
  exp: number;
}

declare module "express-serve-static-core" {
  interface Request {
    sessao?: Sessao;
  }
}

const COOKIE_SESSAO = "sessao";
const COOKIE_FLUXO = "fluxo_login";
const COOKIE_CSRF = "csrf";

const opcoesCookie = (minutos: number, httpOnly = true) => ({
  httpOnly, // JavaScript da página não lê o cookie → XSS não rouba a sessão
  secure: config.producao, // só trafega em HTTPS em produção
  sameSite: "strict" as const, // não é enviado por outros sites → barra CSRF
  path: "/api",
  maxAge: minutos * 60 * 1000,
});

function tokenCsrf(jti: string): string {
  return createHmac("sha256", config.jwtSegredo).update(`csrf:${jti}`).digest("base64url");
}

export function emitirSessao(res: Response, sub: string, papel: Papel): { csrf: string; expiraEm: string } {
  const jti = randomUUID();
  const token = jwt.sign({ papel, tipo: "sessao" }, config.jwtSegredo, {
    algorithm: "HS256",
    subject: sub,
    jwtid: jti,
    expiresIn: `${config.sessaoMinutos}m`, // sessão curta
  });
  const csrf = tokenCsrf(jti);
  res.cookie(COOKIE_SESSAO, token, opcoesCookie(config.sessaoMinutos));
  res.cookie(COOKIE_CSRF, csrf, { ...opcoesCookie(config.sessaoMinutos, false), path: "/" });
  res.clearCookie(COOKIE_FLUXO, { path: "/api" });
  return { csrf, expiraEm: new Date(Date.now() + config.sessaoMinutos * 60_000).toISOString() };
}

export async function encerrarSessao(req: Request, res: Response): Promise<void> {
  if (req.sessao) {
    // Revoga o jti até o momento em que o token expiraria (índice TTL limpa depois).
    await sessoesRevogadas().updateOne(
      { _id: req.sessao.jti },
      { $set: { expiraEm: new Date(req.sessao.exp * 1000) } },
      { upsert: true },
    );
  }
  res.clearCookie(COOKIE_SESSAO, { path: "/api" });
  res.clearCookie(COOKIE_CSRF, { path: "/" });
}

/**
 * Etapa pendente do login da equipe (senha já conferida, falta o TOTP). É um JWT curto e assinado:
 * o navegador não consegue "pular" a etapa trocando um valor.
 */
export type EtapaLogin = "mfa";

export function emitirFluxo(res: Response, sub: string, etapa: EtapaLogin): void {
  const token = jwt.sign({ tipo: "fluxo", etapa }, config.jwtSegredo, { algorithm: "HS256", subject: sub, expiresIn: `${config.fluxoMinutos}m` });
  res.cookie(COOKIE_FLUXO, token, opcoesCookie(config.fluxoMinutos));
}

export function lerFluxo(req: Request): { sub: string; etapa: EtapaLogin } | null {
  try {
    const p = jwt.verify(req.cookies?.[COOKIE_FLUXO] ?? "", config.jwtSegredo, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    return p.tipo === "fluxo" && typeof p.sub === "string" && p.etapa === "mfa" ? { sub: p.sub, etapa: p.etapa } : null;
  } catch {
    return null;
  }
}

/** Exige sessão válida e (opcionalmente) um dos papéis. Toda a autorização é decidida aqui, no backend. */
export function exigir(...papeis: Papel[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let p: jwt.JwtPayload;
    try {
      // algorithms fixo: impede ataque "alg: none" / troca de algoritmo.
      p = jwt.verify(req.cookies?.[COOKIE_SESSAO] ?? "", config.jwtSegredo, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    } catch {
      return res.status(401).json({ erro: "Sessão inválida ou expirada. Entre novamente." });
    }
    if (p.tipo !== "sessao" || !p.jti || !p.sub) return res.status(401).json({ erro: "Sessão inválida." });
    if (await sessoesRevogadas().findOne({ _id: p.jti })) {
      return res.status(401).json({ erro: "Sessão encerrada." });
    }
    // O papel do token vale poucos minutos, mas a fonte da verdade é o banco: conta removida ou rebaixada
    // perde o acesso na hora, sem esperar o token expirar.
    const dono = await usuarios().findOne({ _id: p.sub }, { projection: { papel: 1 } });
    if (!dono || dono.papel !== p.papel) return res.status(401).json({ erro: "Sessão inválida." });
    req.sessao = { sub: p.sub, papel: dono.papel, jti: p.jti, exp: p.exp! };

    // CSRF (double submit atrelado à sessão) em toda requisição que altera estado.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const enviado = Buffer.from(String(req.get("x-csrf-token") ?? ""));
      const esperado = Buffer.from(tokenCsrf(p.jti));
      if (enviado.length !== esperado.length || !timingSafeEqual(enviado, esperado)) {
        await registrarEvento("CSRF_BLOQUEADO", ator(req), ipDe(req), { rota: req.originalUrl });
        return res.status(403).json({ erro: "Token CSRF inválido." });
      }
    }

    if (papeis.length && !papeis.includes(p.papel)) {
      await registrarEvento("ACESSO_NEGADO", ator(req), ipDe(req), { rota: req.originalUrl, papel: p.papel });
      return res.status(403).json({ erro: "Você não tem permissão para esta ação." });
    }
    next();
  };
}

/** Eleitores aparecem na trilha como "eleitor" (anônimo); equipe aparece identificada. */
export function ator(req: Request): string {
  if (!req.sessao) return "anonimo";
  return req.sessao.papel === "eleitor" ? "eleitor" : `${req.sessao.papel}:${req.sessao.sub}`;
}

export const ipDe = (req: Request) => req.ip ?? "desconhecido";

/* ============================ Rate limiting ============================ */

/**
 * Registra no máximo UM evento RATE_LIMIT por IP a cada janela. Sem isso, um atacante que já estourou o limite
 * faria cada requisição bloqueada gravar um evento assinado na trilha (inflando o banco e entupindo a fila).
 */
const ultimoRegistroRateLimit = new Map<string, number>();
function deveRegistrarRateLimit(ip: string, janelaMs: number): boolean {
  const agora = Date.now();
  if (ultimoRegistroRateLimit.size > 5000) {
    for (const [k, t] of ultimoRegistroRateLimit) if (agora - t > janelaMs) ultimoRegistroRateLimit.delete(k);
    if (ultimoRegistroRateLimit.size > 5000) return false; // enxurrada de IPs distintos: não deixa a memória crescer
  }
  const t = ultimoRegistroRateLimit.get(ip);
  if (t !== undefined && agora - t < janelaMs) return false;
  ultimoRegistroRateLimit.set(ip, agora);
  return true;
}

const limitador = (janelaMin: number, max: number, msg: string) =>
  rateLimit({
    windowMs: janelaMin * 60_000,
    limit: max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { erro: msg },
    handler: async (req, res, _next, opts) => {
      if (deveRegistrarRateLimit(ipDe(req), janelaMin * 60_000)) {
        await registrarEvento("RATE_LIMIT", "anonimo", ipDe(req), { rota: req.originalUrl });
      }
      res.status(opts.statusCode).json(opts.message);
    },
  });

export const limiteGeral = limitador(15, 600, "Muitas requisições. Aguarde alguns minutos.");
export const limiteLogin = limitador(15, config.limiteLoginPorIp, "Muitas tentativas de login deste endereço. Aguarde 15 minutos.");
export const limiteVoto = limitador(1, config.limiteVotoPorIp, "Muitas tentativas de voto. Aguarde.");
/** Botão gov.br simulado: um clique por eleitor; teto maior que o do login com senha para a demonstração fluir. */
export const limiteFluxo = limitador(15, config.limiteLoginPorIp * 6, "Muitas tentativas. Aguarde alguns minutos.");
/** Cada tentativa de apuração roda um scrypt caro (abre a chave privada): limita chute de frase-senha e abuso de CPU. */
export const limiteApuracao = limitador(15, 5, "Muitas tentativas de apuração. Aguarde 15 minutos.");

/* ====================== Higiene das requisições ====================== */

/** Rejeita chaves que começam com "$" ou contêm "." → impede NoSQL injection (ex.: {"senha": {"$ne": ""}}). */
export function bloquearOperadoresMongo(req: Request, res: Response, next: NextFunction) {
  const perigoso = (v: unknown, prof = 0): boolean => {
    if (prof > 10) return true;
    if (Array.isArray(v)) return v.some((x) => perigoso(x, prof + 1));
    if (v && typeof v === "object")
      return Object.entries(v).some(([k, x]) => k.startsWith("$") || k.includes(".") || k === "__proto__" || perigoso(x, prof + 1));
    return false;
  };
  if (perigoso(req.body) || perigoso(req.query) || perigoso(req.params)) {
    return res.status(400).json({ erro: "Requisição contém campos não permitidos." });
  }
  next();
}

/** Requisições que alteram estado precisam ser JSON (formulários de outros sites não conseguem enviar JSON sem CORS). */
export function exigirJson(req: Request, res: Response, next: NextFunction) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ erro: "Content-Type deve ser application/json." });
  }
  next();
}

/** Redireciona para HTTPS em produção (atrás de proxy com TRUST_PROXY configurado). */
export function forcarHttps(req: Request, res: Response, next: NextFunction) {
  if (config.producao && !req.secure) return res.redirect(308, `https://${req.hostname}${req.originalUrl}`);
  next();
}
