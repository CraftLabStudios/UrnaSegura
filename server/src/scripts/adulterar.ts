/**
 * DEMONSTRAÇÃO DE ATAQUE — simula um invasor com acesso direto ao banco de UM nó do ledger.
 *
 *   npm run demo:adulterar                         → troca o último voto no nó no_tre_sp
 *   npm run demo:adulterar -- --no=no_tse --seq=2  → escolhe nó e bloco
 *   npm run demo:adulterar -- --modo=apagar        → apaga um bloco
 *   npm run demo:adulterar -- --modo=ingenuo       → troca o voto sem recalcular hashes
 *
 * Modo padrão "reescrever": o invasor cifra um voto falso com a chave PÚBLICA da eleição
 * (que é pública mesmo), recalcula hashConteudo e o hash do bloco — mas NÃO tem a chave
 * privada de assinatura do servidor. Resultado: assinatura inválida e o elo do bloco seguinte
 * quebra. Abra a tela de Auditoria e veja o nó marcado como "corrompido" e a maioria intacta.
 */
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { conectar, desconectar, eleicoes, nos } from "../db.js";
import { calcularHashBloco, calcularHashConteudo } from "../services/ledger.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const nomeNo = args.no ?? "no_tre_sp";
const modo = (args.modo ?? "reescrever") as "reescrever" | "ingenuo" | "apagar";

await conectar();
const e = await eleicoes().find().sort({ criadaEm: -1 }).limit(1).next();
const no = nos.find((n) => n.nome === nomeNo);
if (!e || !no) {
  console.error("Eleição ou nó não encontrado. Nós disponíveis:", nos.map((n) => n.nome).join(", "));
  process.exit(1);
}

const seq = args.seq ? Number(args.seq) : (await no.blocos.find({ eleicaoId: e._id, tipo: "voto" }).sort({ seq: -1 }).limit(1).next())?.seq;
if (!seq) {
  console.error("Ainda não há votos para adulterar. Vote pelo menos uma vez antes.");
  process.exit(1);
}
const bloco = await no.blocos.findOne({ eleicaoId: e._id, seq });
if (!bloco) {
  console.error(`Bloco ${seq} não existe no nó ${nomeNo}.`);
  process.exit(1);
}

if (modo === "apagar") {
  await no.blocos.deleteOne({ _id: bloco._id });
  console.log(`☠  Bloco #${seq} APAGADO do nó ${nomeNo}.`);
} else {
  // Invasor cifra um voto para o candidato 77 com a chave pública da eleição.
  const chaveAes = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chaveAes, iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ escolha: "77", nonce: randomBytes(16).toString("base64") })), c.final(), c.getAuthTag()]);
  const chaveEnvelopada = publicEncrypt(
    { key: createPublicKey({ key: Buffer.from(e.chave.publicaSpkiB64, "base64"), format: "der", type: "spki" }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    chaveAes,
  );
  const conteudo = { chaveEnvelopada: chaveEnvelopada.toString("base64"), iv: iv.toString("base64"), cifrado: ct.toString("base64") };

  const novo = { ...bloco, conteudo };
  if (modo === "reescrever") {
    novo.hashConteudo = calcularHashConteudo(conteudo);
    novo.hash = calcularHashBloco(novo);
    // novo.assinatura continua a antiga: sem a chave privada Ed25519, o invasor não consegue assinar.
  }
  await no.blocos.replaceOne({ _id: bloco._id }, novo);
  console.log(`☠  Bloco #${seq} do nó ${nomeNo} substituído por um voto falso (modo ${modo}).`);
}
console.log("→ Abra Auditoria → 'Verificar réplicas' para ver a detecção. Depois, Administração → 'Reparar nó'.");
await desconectar();
