import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "./config.js";
import type { VotoCifrado, ChaveEleicao } from "./crypto/chaves.js";

export type Papel = "eleitor" | "admin" | "auditor";

export interface Usuario {
  _id: string; // número do título (12 dígitos) ou login da equipe
  nome: string;
  papel: Papel;
  senhaHash: string;
  totpCifrado: string; // segredo TOTP cifrado com AES-GCM (DATA_KEY)
  ultimoPassoTotp: number; // anti-replay do código TOTP
  tentativasFalhas: number;
  bloqueadoAte: Date | null;
  /** Único vínculo do eleitor com a eleição: um booleano, sem horário e sem referência ao voto. */
  jaVotou: boolean;
  /** Dados exibidos na tela "Olá" depois do gov.br simulado. */
  zona?: number;
  secao?: number;
  localVotacao?: string;
  municipio?: string;
  uf?: string;
  /** Eleitor de demonstração que o botão "Entrar com gov.br" (simulado) pode entregar. */
  demo?: boolean;
  /** Reserva temporária: dois cliques simultâneos no gov.br simulado não recebem o mesmo eleitor. */
  reservadoAte?: Date | null;
}

export type EstadoEleicao = "preparada" | "aberta" | "encerrada" | "apurada";

export interface Candidato {
  numero: string;
  nome: string;
  partido: string; // sigla
  vice?: string;
  suplentes?: string[];
  foto?: string; // caminho opcional (ex.: /fotos/presidente-13.jpg); sem foto, a urna desenha um avatar
}

export interface Partido {
  numero: string; // 2 dígitos
  sigla: string;
}

export interface Cargo {
  id: string; // ex.: "deputado_federal"
  nome: string; // ex.: "Deputado Federal"
  digitos: number; // quantos dígitos o número tem na urna
  legenda: boolean; // aceita voto só no partido (2 primeiros dígitos)?
  candidatos: Candidato[];
}

export interface Eleicao {
  _id: string;
  titulo: string;
  /** Cédula na ordem da urna real: deputado federal → estadual → senador (2 vagas) → governador → presidente. */
  cargos: Cargo[];
  partidos: Partido[];
  estado: EstadoEleicao;
  chave: ChaveEleicao;
  criadaEm: Date;
  abertaEm?: Date;
  encerradaEm?: Date;
}

export interface BlocoLedger {
  seq: number;
  eleicaoId: string;
  hashAnterior: string;
  carimboTempo: string; // ISO, truncado ao minuto (reduz correlação horário ↔ eleitor)
  tipo: "genesis" | "voto";
  conteudo: VotoCifrado | { parametrosEleicao: string };
  hashConteudo: string;
  hash: string;
  assinatura: string;
}

export interface EventoAuditoria {
  seq: number;
  hashAnterior: string;
  quando: string;
  tipo: string;
  ator: string; // "eleitor" (anônimo) ou identificador da equipe
  ip: string;
  detalhes: Record<string, unknown>;
  hash: string;
  assinatura: string;
}

export interface ResultadoCargo {
  id: string;
  nome: string;
  candidatos: { numero: string; nome: string; partido: string; votos: number }[];
  legendas: { numero: string; sigla: string; votos: number }[];
  brancos: number;
  nulos: number;
  validos: number; // candidatos + legendas
}

export interface Boletim {
  _id: string; // eleicaoId
  eleicaoId: string;
  titulo: string;
  cargos: ResultadoCargo[];
  totalVotos: number; // cédulas apuradas
  eleitoresAptos: number;
  comparecimento: number;
  hashFinalLedger: string;
  blocosNoLedger: number;
  nosConcordantes: string[];
  geradoEm: string;
  hash: string;
  assinatura: string;
}

export interface NoLedger {
  nome: string;
  blocos: Collection<BlocoLedger>;
}

let cliente: MongoClient;
let db: Db;
const clientesNos = new Map<string, MongoClient>();
export let nos: NoLedger[] = [];

export async function conectar(): Promise<void> {
  if (!cliente) {
    cliente = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
    await cliente.connect();
    clientesNos.set(config.mongoUri, cliente);
  }
  db = cliente.db(config.bancoPrincipal);

  nos = [];
  for (const no of config.nosLedger) {
    let c = clientesNos.get(no.uri);
    if (!c) {
      c = new MongoClient(no.uri, { serverSelectionTimeoutMS: 5000 });
      await c.connect();
      clientesNos.set(no.uri, c);
    }
    nos.push({ nome: no.nome, blocos: c.db(no.banco).collection<BlocoLedger>("blocos") });
  }

  await usuarios().createIndex({ papel: 1 });
  await usuarios().createIndex({ demo: 1, jaVotou: 1 }, { partialFilterExpression: { demo: true } });
  await auditoria().createIndex({ seq: 1 }, { unique: true });
  await auditoria().createIndex({ tipo: 1, quando: 1 }); // dashboard: contagens por tipo e janela de tempo
  // TTL: o MongoDB apaga sozinho revogações de tokens que já expirariam de qualquer forma.
  await sessoesRevogadas().createIndex({ expiraEm: 1 }, { expireAfterSeconds: 0 }).catch((e) => {
    console.warn(`Aviso: índice TTL não suportado por este servidor (${e.message}). Continuando.`);
  });
  for (const no of nos) {
    // Índice único em seq: impede dois blocos com a mesma posição (bifurcação da cadeia).
    await no.blocos.createIndex({ eleicaoId: 1, seq: 1 }, { unique: true });
    await no.blocos.createIndex({ hash: 1 });
  }
}

export async function desconectar(): Promise<void> {
  for (const c of clientesNos.values()) await c.close();
}

export const usuarios = () => db.collection<Usuario>("usuarios");
export const eleicoes = () => db.collection<Eleicao>("eleicoes");
export const auditoria = () => db.collection<EventoAuditoria>("auditoria");
export const boletins = () => db.collection<Boletim>("boletins");
/** Barreira de voto único: _id = título do eleitor. Inserir duas vezes o mesmo _id é impossível (índice único). */
export const comparecimentos = () => db.collection<{ _id: string }>("comparecimentos");
export const sessoesRevogadas = () => db.collection<{ _id: string; expiraEm: Date }>("sessoes_revogadas");
export const bancoPrincipal = () => db;
