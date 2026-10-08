import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { config } from "./config.js";
import { rotasAuth } from "./routes/auth.js";
import { rotasVotacao } from "./routes/votacao.js";
import { rotasAdmin, rotasAuditoria } from "./routes/gestao.js";
import { rotasPublicas } from "./routes/publico.js";
import { ErroRegra } from "./services/eleicao.js";
import { ErroLedger } from "./services/ledger.js";
import { bloquearOperadoresMongo, exigirJson, forcarHttps, limiteGeral } from "./middleware/seguranca.js";

export function criarApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use(forcarHttps);
  app.use(
    helmet({
      // CSP: a página só executa scripts do próprio domínio → mitiga XSS.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"], // anti-clickjacking
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          upgradeInsecureRequests: config.producao ? [] : null,
        },
      },
      strictTransportSecurity: config.producao ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: "no-referrer" },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  );
  // Sem CORS: a API só aceita chamadas do mesmo domínio do site.

  app.use("/api", limiteGeral);
  app.use("/api", express.json({ limit: "16kb", strict: true }));
  app.use("/api", cookieParser());
  app.use("/api", exigirJson);
  app.use("/api", bloquearOperadoresMongo);
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use("/api/auth", rotasAuth);
  app.use("/api", rotasVotacao);
  app.use("/api/admin", rotasAdmin);
  app.use("/api/auditoria", rotasAuditoria);
  app.use("/api/public", rotasPublicas);
  app.use("/api", (_req, res) => res.status(404).json({ erro: "Rota não encontrada." }));

  // Produção: o próprio Express serve o React compilado (mesma origem → cookies SameSite=Strict funcionam).
  if (fs.existsSync(config.dirCliente)) {
    app.use(express.static(config.dirCliente, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(config.dirCliente, "index.html")));
  }

  // Tratador de erros: mensagens claras para o usuário, nunca stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ erro: "Dados inválidos.", detalhes: err.issues.map((i) => i.message) });
    if (err instanceof ErroRegra) return res.status(err.status).json({ erro: err.message });
    if (err instanceof ErroLedger) return res.status(503).json({ erro: err.message });
    if ((err as { type?: string }).type === "entity.too.large") return res.status(413).json({ erro: "Requisição grande demais." });
    if ((err as { type?: string }).type === "entity.parse.failed") return res.status(400).json({ erro: "JSON malformado." });
    console.error(err);
    res.status(500).json({ erro: "Erro interno." });
  });

  return app;
}
