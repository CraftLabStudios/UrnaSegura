/**
 * Prepara o ambiente de demonstração:
 *  - APAGA os bancos da aplicação e dos nós do ledger (somente dev!)
 *  - cria equipe (admin, auditor) e 10 eleitores com senha + segredo TOTP
 *  - gera a chave RSA da eleição (privada cifrada com a frase da Junta)
 *  - grava o bloco gênese em todos os nós
 */
import { config } from "../config.js";
import { conectar, desconectar, eleicoes, usuarios, bancoPrincipal, nos, type Eleicao, type Usuario } from "../db.js";
import { cifrarSegredo, garantirChaveAssinatura, gerarChaveEleicao } from "../crypto/chaves.js";
import { gerarHashSenha } from "../crypto/senha.js";
import { gerarCodigoTotp, gerarSegredoTotp, uriOtpAuth } from "../crypto/totp.js";
import { iniciarLedger } from "../services/ledger.js";
import { registrarEvento } from "../services/auditoria.js";

if (config.producao) {
  console.error("O seed apaga dados e não roda com NODE_ENV=production.");
  process.exit(1);
}

const FRASE_JUNTA = process.env.JUNTA_PASSPHRASE ?? "junta-eleitoral-demo-2026";
const SENHA_ELEITOR = process.env.SEED_SENHA_ELEITOR ?? "Eleitor@2026";
const SENHA_ADMIN = process.env.SEED_SENHA_ADMIN ?? "Admin@2026!";
const SENHA_AUDITOR = process.env.SEED_SENHA_AUDITOR ?? "Auditor@2026!";

garantirChaveAssinatura();
await conectar();

console.log("Limpando bancos de dados de demonstração...");
await bancoPrincipal().dropDatabase();
for (const no of nos) await no.blocos.drop().catch(() => undefined);
await conectar(); // recria índices

const linhas: { usuario: string; nome: string; papel: string; senha: string; totp: string; codigoAgora: string }[] = [];

async function criar(id: string, nome: string, papel: Usuario["papel"], senha: string) {
  const segredo = gerarSegredoTotp();
  await usuarios().insertOne({
    _id: id,
    nome,
    papel,
    senhaHash: await gerarHashSenha(senha),
    totpCifrado: cifrarSegredo(segredo),
    ultimoPassoTotp: 0,
    tentativasFalhas: 0,
    bloqueadoAte: null,
    jaVotou: false,
  });
  linhas.push({ usuario: id, nome, papel, senha, totp: uriOtpAuth(segredo, id), codigoAgora: gerarCodigoTotp(segredo) });
}

await criar("admin", "Junta Eleitoral (Administrador)", "admin", SENHA_ADMIN);
await criar("auditor", "Auditor Independente", "auditor", SENHA_AUDITOR);
const nomes = ["Ana Souza", "Bruno Lima", "Carla Mendes", "Diego Rocha", "Elisa Martins", "Fábio Nunes", "Gabriela Prado", "Henrique Costa", "Isabela Ramos", "João Pereira"];
for (let i = 0; i < nomes.length; i++) {
  await criar(String(i + 1).padStart(12, "0"), nomes[i], "eleitor", SENHA_ELEITOR);
}

console.log("Gerando par de chaves RSA-3072 da eleição...");
const eleicao: Eleicao = {
  _id: "eleicao-simulada-2026",
  titulo: "Eleição Simulada 2026",
  cargo: "Presidente (simulação acadêmica)",
  candidatos: [
    { numero: "10", nome: "Helena Duarte", partido: "Partido da Inovação", vice: "Rafael Moura" },
    { numero: "25", nome: "Roberto Alves", partido: "Movimento Cidadão", vice: "Lúcia Campos" },
    { numero: "40", nome: "Camila Torres", partido: "Aliança Popular", vice: "Otávio Reis" },
    { numero: "77", nome: "Marcos Ferreira", partido: "Frente Democrática", vice: "Sônia Batista" },
  ],
  estado: "preparada",
  chave: gerarChaveEleicao(FRASE_JUNTA),
  criadaEm: new Date(),
};
await eleicoes().insertOne(eleicao);
const genesis = await iniciarLedger(eleicao);
await registrarEvento("ELEICAO_CRIADA", "sistema", "-", { eleicaoId: eleicao._id, hashGenesis: genesis.bloco.hash });

console.log("\n================ AMBIENTE DE DEMONSTRAÇÃO PRONTO ================\n");
console.table(linhas.map(({ usuario, nome, papel, senha, codigoAgora }) => ({ usuario, nome, papel, senha, "código MFA agora": codigoAgora })));
console.log(`Frase-senha da Junta (apuração): ${FRASE_JUNTA}`);
console.log(`Bloco gênese gravado em: ${genesis.replicadoEm.join(", ")}  hash ${genesis.bloco.hash.slice(0, 16)}…`);
console.log("\nCódigo MFA atual de qualquer usuário:  npm run token -- 000000000001");
console.log("Para usar o celular, cadastre no Google/Microsoft Authenticator a URI otpauth abaixo:\n");
for (const l of linhas) console.log(`  ${l.usuario.padEnd(14)} ${l.totp}`);
await desconectar();
