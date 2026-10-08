import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) — o mesmo algoritmo do Google Authenticator / Microsoft Authenticator.
 * Segundo fator de autenticação: "algo que você tem" além de "algo que você sabe".
 */
const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PASSO = 30;

export function gerarSegredoTotp(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALFABETO[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = ALFABETO.indexOf(c);
    if (v < 0) throw new Error("base32 inválido");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codigoNoPasso(segredo: string, passo: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const hmac = createHmac("sha1", base32Decode(segredo)).update(contador).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const num = (hmac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return num.toString().padStart(6, "0");
}

export function passoAtual(agora = Date.now()): number {
  return Math.floor(agora / 1000 / PASSO);
}

export function gerarCodigoTotp(segredo: string, agora = Date.now()): string {
  return codigoNoPasso(segredo, passoAtual(agora));
}

/**
 * Verifica o código aceitando ±1 janela (relógio levemente dessincronizado).
 * Retorna o passo usado para impedir reutilização do mesmo código (anti-replay).
 */
export function verificarTotp(segredo: string, codigo: string, ultimoPassoUsado: number): number | null {
  if (!/^\d{6}$/.test(codigo)) return null;
  const atual = passoAtual();
  for (const passo of [atual - 1, atual, atual + 1]) {
    if (passo <= ultimoPassoUsado) continue;
    const esperado = Buffer.from(codigoNoPasso(segredo, passo));
    if (timingSafeEqual(esperado, Buffer.from(codigo))) return passo;
  }
  return null;
}

export function uriOtpAuth(segredo: string, conta: string): string {
  return `otpauth://totp/UrnaSegura:${encodeURIComponent(conta)}?secret=${segredo}&issuer=UrnaSegura&period=${PASSO}`;
}
