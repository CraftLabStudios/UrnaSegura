import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function obrigatoria(nome: string, padraoDev?: string): string {
  const v = process.env[nome];
  if (v && v.length > 0) return v;
  if (process.env.NODE_ENV === "production" || padraoDev === undefined) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
  }
  return padraoDev;
}

const nos = (process.env.LEDGER_NODES ?? "no_tse,no_tre_sc,no_tre_sp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  producao: process.env.NODE_ENV === "production",
  porta: Number(process.env.PORT ?? 3001),
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
  bancoPrincipal: process.env.MONGODB_DB ?? "urna_segura",

  /** Nós de réplica do ledger. Cada um pode apontar para um cluster diferente via LEDGER_URI_<nome>. */
  nosLedger: nos.map((nome) => ({
    nome,
    uri: process.env[`LEDGER_URI_${nome}`] ?? process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
    banco: `ledger_${nome}`,
  })),

  /** Segredo do JWT de sessão (HS256). Em produção é obrigatório e deve ter >= 32 bytes aleatórios. */
  jwtSegredo: obrigatoria("JWT_SECRET", "dev-apenas-troque-este-segredo-com-32+bytes!!"),
  /** Chave (hex, 32 bytes) que cifra em repouso os segredos TOTP dos usuários. */
  chaveDados: obrigatoria("DATA_KEY", "0".repeat(64)),

  sessaoMinutos: Number(process.env.SESSION_MINUTES ?? 10),
  mfaMinutos: 3,
  maxTentativasLogin: 5,
  /** Limites por IP (janela de 15 min para login, 1 min para voto). */
  limiteLoginPorIp: Number(process.env.RATE_LIMIT_LOGIN ?? 10),
  limiteVotoPorIp: Number(process.env.RATE_LIMIT_VOTO ?? 5),
  bloqueioMinutos: 15,

  /** Diretório das chaves de assinatura do servidor (Ed25519). */
  dirChaves: process.env.KEYS_DIR ?? path.resolve(__dirname, "../../keys"),
  /** Pasta com o build do React servida em produção. */
  dirCliente: path.resolve(__dirname, "../../client/dist"),
  /** Atrás de proxy reverso / Vercel / Nginx, para req.ip e req.secure corretos. */
  trustProxy: process.env.TRUST_PROXY ?? "loopback",
};
