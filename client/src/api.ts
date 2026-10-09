/**
 * Cliente HTTP. O token de sessão vive num cookie httpOnly (o JavaScript não consegue lê-lo).
 * Aqui só guardamos em memória o token CSRF, enviado no cabeçalho X-CSRF-Token.
 */
let csrf: string | null = null;
export const definirCsrf = (t: string | null) => {
  csrf = t;
};

export class ErroApi extends Error {
  constructor(msg: string, public status: number) {
    super(msg);
  }
}

async function req<T>(metodo: string, url: string, corpo?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (metodo !== "GET") {
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const r = await fetch(`/api${url}`, {
    method: metodo,
    headers,
    body: metodo === "GET" ? undefined : JSON.stringify(corpo ?? {}),
    credentials: "same-origin",
    cache: "no-store",
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi(dados.erro ?? `Erro ${r.status}`, r.status);
  return dados as T;
}

export const api = {
  get: <T,>(url: string) => req<T>("GET", url),
  post: <T,>(url: string, corpo?: unknown) => req<T>("POST", url, corpo),
};

export type Papel = "eleitor" | "admin" | "auditor";
export interface Usuario {
  nome: string;
  papel: Papel;
}
/** O que o gov.br simulado devolve para a tela "Olá". */
export interface DadosEleitor {
  nome: string;
  titulo: string;
  zona: number | null;
  secao: number | null;
  localVotacao: string | null;
  municipio: string | null;
  uf: string | null;
}
export interface Candidato {
  numero: string;
  nome: string;
  partido: string;
  vice?: string;
  suplentes?: string[];
  foto?: string;
}
export interface Partido {
  numero: string;
  sigla: string;
}
export interface Cargo {
  id: string;
  nome: string;
  digitos: number;
  legenda: boolean;
  candidatos: Candidato[];
}
export interface Eleicao {
  id: string;
  titulo: string;
  estado: "preparada" | "aberta" | "encerrada" | "apurada";
  cargos: Cargo[];
  partidos: Partido[];
  chavePublica: string;
  impressaoDigitalChave: string;
}
export interface Comprovante {
  hash: string;
  seq: number;
  carimboTempo: string;
  assinatura: string;
  replicadoEm: string[];
}
export interface NoEstado {
  nome: string;
  disponivel: boolean;
  integro: boolean;
  blocos: number;
  hashFinal: string | null;
  situacao: "consenso" | "atrasado" | "corrompido" | "divergente" | "indisponivel";
  erro?: { seq: number; motivo: string };
}
export interface EstadoReplicas {
  quorum: number;
  totalNos: number;
  temConsenso: boolean;
  hashFinalConsenso: string | null;
  blocosConsenso: number;
  nos: NoEstado[];
}
export interface ResultadoCargo {
  id: string;
  nome: string;
  candidatos: { numero: string; nome: string; partido: string; votos: number }[];
  legendas: { numero: string; sigla: string; votos: number }[];
  brancos: number;
  nulos: number;
  validos: number;
}
export interface Boletim {
  eleicaoId: string;
  titulo: string;
  cargos: ResultadoCargo[];
  totalVotos: number;
  eleitoresAptos: number;
  comparecimento: number;
  hashFinalLedger: string;
  blocosNoLedger: number;
  nosConcordantes: string[];
  geradoEm: string;
  hash: string;
  assinatura: string;
}
