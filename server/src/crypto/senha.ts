import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** Parâmetros do scrypt (função de derivação lenta e cara em memória contra força bruta). */
const N = 2 ** 15;
const r = 8;
const p = 1;
const TAMANHO = 64;

function scryptAsync(senha: string, sal: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(senha, sal, TAMANHO, opts, (err, chave) => (err ? reject(err) : resolve(chave))),
  );
}

export async function gerarHashSenha(senha: string): Promise<string> {
  const sal = randomBytes(16);
  const chave = await scryptAsync(senha.normalize("NFKC"), sal, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${sal.toString("base64")}$${chave.toString("base64")}`;
}

export async function verificarSenha(senha: string, armazenado: string): Promise<boolean> {
  const [alg, nS, rS, pS, salB64, chaveB64] = armazenado.split("$");
  if (alg !== "scrypt") return false;
  const n = Number(nS), rr = Number(rS), pp = Number(pS);
  const esperado = Buffer.from(chaveB64, "base64");
  const calculado = await scryptAsync(senha.normalize("NFKC"), Buffer.from(salB64, "base64"), {
    N: n, r: rr, p: pp, maxmem: 128 * n * rr * 2,
  });
  // Comparação em tempo constante: não vaza quantos bytes coincidem.
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

/** Hash "falso" usado quando o usuário não existe, para o tempo de resposta ser igual (anti-enumeração). */
let hashFicticio: string | null = null;
export async function verificarSenhaFicticia(senha: string): Promise<false> {
  hashFicticio ??= await gerarHashSenha(randomBytes(16).toString("hex"));
  await verificarSenha(senha, hashFicticio);
  return false;
}
