import { auditoria, type EventoAuditoria } from "../db.js";
import { HASH_GENESIS, jsonCanonico, sha256Hex } from "../crypto/hash.js";
import { assinarHash, verificarAssinatura } from "../crypto/chaves.js";
import { Fila } from "./fila.js";

/**
 * Trilha de auditoria: log append-only de eventos de segurança, com hash encadeado
 * e assinatura. Nunca há UPDATE/DELETE — só INSERT.
 */
const fila = new Fila();

function hashEvento(e: Omit<EventoAuditoria, "hash" | "assinatura">): string {
  return sha256Hex(jsonCanonico(e));
}

export function registrarEvento(
  tipo: string,
  ator: string,
  ip: string,
  detalhes: Record<string, unknown> = {},
): Promise<void> {
  return fila.executar(async () => {
    const ultimo = await auditoria().find().sort({ seq: -1 }).limit(1).next();
    const base = {
      seq: ultimo ? ultimo.seq + 1 : 0,
      hashAnterior: ultimo ? ultimo.hash : HASH_GENESIS,
      quando: new Date().toISOString(),
      tipo,
      ator,
      ip,
      detalhes,
    };
    const hash = hashEvento(base);
    await auditoria().insertOne({ ...base, hash, assinatura: assinarHash(hash) });
  });
}

export async function verificarTrilha() {
  let anterior = HASH_GENESIS;
  let esperado = 0;
  let total = 0;
  for await (const e of auditoria().find({}, { projection: { _id: 0 } }).sort({ seq: 1 })) {
    const { hash, assinatura, ...base } = e;
    const erro =
      e.seq !== esperado ? `sequência pulada (esperado ${esperado})`
      : e.hashAnterior !== anterior ? "elo quebrado: hashAnterior não confere"
      : hashEvento(base) !== hash ? "conteúdo alterado: hash recalculado diferente"
      : !verificarAssinatura(hash, assinatura) ? "assinatura inválida"
      : null;
    if (erro) return { integra: false, total, erro: { seq: e.seq, motivo: erro } };
    anterior = hash;
    esperado++;
    total++;
  }
  return { integra: true, total, hashFinal: anterior };
}
