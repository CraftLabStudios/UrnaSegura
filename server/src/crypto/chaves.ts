import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  scryptSync,
  sign,
  verify,
  constants,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { sha256Hex } from "./hash.js";

/* ------------------------------------------------------------------ */
/* 1) Chave de assinatura do servidor (Ed25519)                         */
/*    Assina cada bloco do ledger, cada evento de auditoria e o boletim. */
/*    Funciona como a "autoridade de carimbo de tempo" do fluxo.         */
/* ------------------------------------------------------------------ */

let chavePrivadaAssinatura: KeyObject | null = null;
let chavePublicaAssinatura: KeyObject | null = null;

export function garantirChaveAssinatura(): void {
  const priv = path.join(config.dirChaves, "assinatura-ed25519.pem");
  const pub = path.join(config.dirChaves, "assinatura-ed25519.pub.pem");
  if (!fs.existsSync(priv)) {
    if (config.producao) throw new Error(`Chave de assinatura ausente em ${priv}`);
    fs.mkdirSync(config.dirChaves, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
  }
  chavePrivadaAssinatura = createPrivateKey(fs.readFileSync(priv));
  chavePublicaAssinatura = createPublicKey(fs.readFileSync(pub));
}

function chavesAssinatura() {
  if (!chavePrivadaAssinatura || !chavePublicaAssinatura) garantirChaveAssinatura();
  return { priv: chavePrivadaAssinatura!, pub: chavePublicaAssinatura! };
}

export function assinarHash(hashHex: string): string {
  return sign(null, Buffer.from(hashHex, "hex"), chavesAssinatura().priv).toString("base64");
}

export function verificarAssinatura(hashHex: string, assinaturaB64: string): boolean {
  try {
    return verify(null, Buffer.from(hashHex, "hex"), chavesAssinatura().pub, Buffer.from(assinaturaB64, "base64"));
  } catch {
    return false;
  }
}

/** Chave pública em SPKI/base64 (o navegador importa com WebCrypto para verificar sozinho). */
export function chavePublicaAssinaturaSpki(): string {
  return chavesAssinatura().pub.export({ type: "spki", format: "der" }).toString("base64");
}

/* ------------------------------------------------------------------ */
/* 2) Cifragem em repouso (AES-256-GCM) de dados sensíveis do servidor  */
/* ------------------------------------------------------------------ */

function cifrarGcm(chave: Buffer, texto: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chave, iv);
  const ct = Buffer.concat([c.update(texto), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

function decifrarGcm(chave: Buffer, pacote: string): Buffer {
  const [iv, tag, ct] = pacote.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", chave, iv);
  d.setAuthTag(tag); // GCM autentica: qualquer bit alterado faz final() lançar erro.
  return Buffer.concat([d.update(ct), d.final()]);
}

const chaveDados = () => Buffer.from(config.chaveDados, "hex");
export const cifrarSegredo = (s: string) => cifrarGcm(chaveDados(), Buffer.from(s, "utf8"));
export const decifrarSegredo = (p: string) => decifrarGcm(chaveDados(), p).toString("utf8");

/* ------------------------------------------------------------------ */
/* 3) Chave da eleição (RSA-OAEP 3072)                                  */
/*    O navegador cifra o voto com a pública. A privada fica cifrada    */
/*    com a frase-senha da Junta Eleitoral e só é aberta na apuração.   */
/* ------------------------------------------------------------------ */

export interface ChaveEleicao {
  publicaSpkiB64: string;
  privadaCifrada: string;
  salKdf: string;
  impressaoDigital: string;
}

export function gerarChaveEleicao(fraseJunta: string): ChaveEleicao {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const sal = randomBytes(16);
  const kek = scryptSync(fraseJunta.normalize("NFKC"), sal, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return {
    publicaSpkiB64: spki.toString("base64"),
    privadaCifrada: cifrarGcm(kek, privateKey.export({ type: "pkcs8", format: "der" })),
    salKdf: sal.toString("base64"),
    impressaoDigital: sha256Hex(spki),
  };
}

/** Lança erro se a frase da junta estiver errada (o GCM falha na autenticação). */
export function abrirChavePrivadaEleicao(chave: ChaveEleicao, fraseJunta: string): KeyObject {
  const kek = scryptSync(fraseJunta.normalize("NFKC"), Buffer.from(chave.salKdf, "base64"), 32, {
    N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  const der = decifrarGcm(kek, chave.privadaCifrada);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export interface VotoCifrado {
  chaveEnvelopada: string; // chave AES do voto, cifrada com RSA-OAEP (base64)
  iv: string; // base64, 12 bytes
  cifrado: string; // AES-256-GCM do JSON do voto (base64, inclui a tag)
}

/** Usado apenas na apuração: desenvelopa a chave AES com RSA-OAEP e decifra o voto. */
export function decifrarVoto(privada: KeyObject, v: VotoCifrado): unknown {
  const chaveAes = privateDecrypt(
    { key: privada, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(v.chaveEnvelopada, "base64"),
  );
  const dados = Buffer.from(v.cifrado, "base64");
  const tag = dados.subarray(dados.length - 16);
  const ct = dados.subarray(0, dados.length - 16);
  const d = createDecipheriv("aes-256-gcm", chaveAes, Buffer.from(v.iv, "base64"));
  d.setAuthTag(tag);
  const claro = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  chaveAes.fill(0);
  return JSON.parse(claro);
}
