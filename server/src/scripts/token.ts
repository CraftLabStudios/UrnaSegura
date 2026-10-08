/**
 * Simula o aplicativo autenticador do usuário (Google Authenticator) para a demonstração em sala.
 * Uso: npm run token -- 000000000001
 */
import { conectar, desconectar, usuarios } from "../db.js";
import { decifrarSegredo } from "../crypto/chaves.js";
import { gerarCodigoTotp } from "../crypto/totp.js";

const id = (process.argv[2] ?? "").toLowerCase();
if (!id) {
  console.error("Informe o usuário. Ex.: npm run token -- 000000000001");
  process.exit(1);
}
await conectar();
const u = await usuarios().findOne({ _id: id });
if (!u) {
  console.error("Usuário não encontrado.");
} else {
  const restam = 30 - (Math.floor(Date.now() / 1000) % 30);
  console.log(`\n  ${u.nome} (${u.papel})\n  Código: ${gerarCodigoTotp(decifrarSegredo(u.totpCifrado))}   (válido por ~${restam}s)\n`);
}
await desconectar();
