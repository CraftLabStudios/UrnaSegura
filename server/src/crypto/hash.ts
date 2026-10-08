import { createHash } from "node:crypto";

/**
 * JSON canônico: chaves ordenadas alfabeticamente, sem espaços.
 * Garante que servidor, auditores e o navegador calculem exatamente o mesmo hash
 * para o mesmo conteúdo (a mesma função existe em client/src/crypto.ts).
 */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(",")}]`;
  const obj = valor as Record<string, unknown>;
  const chaves = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${jsonCanonico(obj[k])}`).join(",")}}`;
}

export function sha256Hex(dados: string | Buffer): string {
  return createHash("sha256").update(dados).digest("hex");
}

export const HASH_GENESIS = "0".repeat(64);
