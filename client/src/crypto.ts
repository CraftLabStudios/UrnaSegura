/**
 * Criptografia no NAVEGADOR (Web Crypto API nativa — nenhuma biblioteca de terceiros).
 *
 * 1. cifrarVoto: o voto é cifrado aqui, antes de sair do computador do eleitor.
 *    Esquema híbrido: AES-256-GCM para o conteúdo + RSA-OAEP-SHA256 (chave da eleição) para a chave AES.
 *    O servidor nunca vê o voto em claro; só a Junta, com a chave privada, na apuração.
 * 2. verificarCadeia: qualquer pessoa recalcula os hashes e confere as assinaturas Ed25519
 *    sem confiar no servidor (verificação independente).
 */

const enc = new TextEncoder();

export const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const deHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** Mesmo algoritmo de server/src/crypto/hash.ts — precisa ser idêntico byte a byte. */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(",")}]`;
  const obj = valor as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jsonCanonico(obj[k])}`)
    .join(",")}}`;
}

export async function sha256Hex(texto: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(texto)));
}

export interface VotoCifrado {
  chaveEnvelopada: string;
  iv: string;
  cifrado: string;
}

export async function cifrarVoto(escolha: string, chavePublicaSpkiB64: string): Promise<VotoCifrado> {
  const chaveRsa = await crypto.subtle.importKey("spki", deB64(chavePublicaSpkiB64), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  // Chave AES nova a cada voto, extraível só para ser envelopada e depois descartada.
  const chaveAes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // nonce aleatório: dois votos iguais nunca geram o mesmo texto cifrado.
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, chaveAes, enc.encode(JSON.stringify({ escolha, nonce })));
  const bruta = await crypto.subtle.exportKey("raw", chaveAes);
  const chaveEnvelopada = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, chaveRsa, bruta);
  new Uint8Array(bruta).fill(0);
  return { chaveEnvelopada: b64(chaveEnvelopada), iv: b64(iv), cifrado: b64(cifrado) };
}

/* ------------------------- verificação independente ------------------------- */

export interface Bloco {
  seq: number;
  eleicaoId: string;
  hashAnterior: string;
  carimboTempo: string;
  tipo: "genesis" | "voto";
  conteudo: unknown;
  hashConteudo: string;
  hash: string;
  assinatura: string;
}

const GENESIS = "0".repeat(64);

async function importarEd25519(spkiB64: string) {
  return crypto.subtle.importKey("spki", deB64(spkiB64), { name: "Ed25519" }, false, ["verify"]);
}

export async function verificarAssinaturaHash(hashHex: string, assinaturaB64: string, spkiB64: string): Promise<boolean> {
  try {
    const chave = await importarEd25519(spkiB64);
    return await crypto.subtle.verify({ name: "Ed25519" }, chave, deB64(assinaturaB64), deHex(hashHex));
  } catch {
    return false;
  }
}

export interface PassoVerificacao {
  seq: number;
  tipo: string;
  hash: string;
  ok: boolean;
  motivo?: string;
}

export async function verificarCadeia(blocos: Bloco[], spkiB64: string) {
  const chave = await importarEd25519(spkiB64);
  const passos: PassoVerificacao[] = [];
  let anterior = GENESIS;
  for (let i = 0; i < blocos.length; i++) {
    const b = blocos[i];
    const hashConteudo = await sha256Hex(jsonCanonico(b.conteudo));
    const hash = await sha256Hex(
      jsonCanonico({ seq: b.seq, eleicaoId: b.eleicaoId, hashAnterior: b.hashAnterior, carimboTempo: b.carimboTempo, tipo: b.tipo, hashConteudo: b.hashConteudo }),
    );
    let motivo: string | undefined;
    if (b.seq !== i) motivo = "sequência pulada";
    else if (b.hashAnterior !== anterior) motivo = "elo quebrado com o bloco anterior";
    else if (hashConteudo !== b.hashConteudo) motivo = "conteúdo alterado";
    else if (hash !== b.hash) motivo = "cabeçalho alterado";
    else if (!(await crypto.subtle.verify({ name: "Ed25519" }, chave, deB64(b.assinatura), deHex(b.hash)))) motivo = "assinatura inválida";
    passos.push({ seq: b.seq, tipo: b.tipo, hash: b.hash, ok: !motivo, motivo });
    if (motivo) return { integra: false, passos, hashFinal: anterior };
    anterior = b.hash;
  }
  return { integra: true, passos, hashFinal: blocos.length ? anterior : null };
}

export const curto = (h?: string | null, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-6)}` : "—");
