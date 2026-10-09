import type { Cargo, Partido } from "../db.js";

/**
 * PRESIDENTE — dados REAIS do 1º turno de 2026 (4/10/2026), conforme a totalização do TSE divulgada pela imprensa
 * (CartaCapital, 5/10/2026). Números de urna e vices: lista de candidaturas deferidas (DCI / Gazeta SP).
 * Confira sempre em resultados.tse.jus.br antes de citar em trabalho formal.
 *
 * DEMAIS CARGOS — candidatos FICTÍCIOS (nomes inventados, partidos reais só para o número de legenda),
 * para a simulação ter a cédula completa de 2026 na ordem da urna.
 */
export const CANDIDATOS_2026 = [
  { numero: "22", nome: "Flávio Bolsonaro", partido: "PL", vice: "Alfredo Gaspar", votos: 56_104_503 },
  { numero: "13", nome: "Lula", partido: "PT", vice: "Geraldo Alckmin", votos: 53_879_538 },
  { numero: "70", nome: "Augusto Cury", partido: "Avante", vice: "Júlio Delgado", votos: 3_448_569 },
  { numero: "14", nome: "Renan Santos", partido: "Missão", vice: "Aroldo Medina", votos: 2_675_887 },
  { numero: "55", nome: "Ronaldo Caiado", partido: "PSD", vice: "Gilberto Kassab", votos: 2_605_148 },
  { numero: "30", nome: "Romeu Zema", partido: "Novo", vice: "Eduardo Girão", votos: 326_488 },
  { numero: "80", nome: "Samara Martins", partido: "UP", vice: "Raquel Brício", votos: 122_911 },
  { numero: "16", nome: "Hertz Dias", partido: "PSTU", vice: "Vanessa Portugal", votos: 43_103 },
  { numero: "27", nome: "Clariana Barão", partido: "DC", vice: "Fabiana Torquato", votos: 40_043 },
  { numero: "21", nome: "Edmilson Costa", partido: "PCB", vice: "Cleusa Santos", votos: 22_693 },
  { numero: "35", nome: "Wilson Grassi", partido: "Democrata", vice: "Suêd Haidar", votos: 16_881 },
  { numero: "29", nome: "Rui Costa Pimenta", partido: "PCO", vice: undefined, votos: 15_024 }, // vice não confirmado nas fontes
];

export const TOTALIZACAO_2026 = {
  aptos: 158_745_502,
  comparecimento: 125_275_835,
  abstencao: 33_469_244,
  brancos: 2_300_798,
  nulos: 3_674_249,
};

export const PARTIDOS_2026: Partido[] = [
  { numero: "10", sigla: "Republicanos" }, { numero: "11", sigla: "PP" }, { numero: "13", sigla: "PT" },
  { numero: "14", sigla: "Missão" }, { numero: "15", sigla: "MDB" }, { numero: "16", sigla: "PSTU" },
  { numero: "21", sigla: "PCB" }, { numero: "22", sigla: "PL" }, { numero: "27", sigla: "DC" },
  { numero: "29", sigla: "PCO" }, { numero: "30", sigla: "Novo" }, { numero: "35", sigla: "Democrata" },
  { numero: "40", sigla: "PSB" }, { numero: "44", sigla: "União" }, { numero: "50", sigla: "PSOL" },
  { numero: "55", sigla: "PSD" }, { numero: "70", sigla: "Avante" }, { numero: "80", sigla: "UP" },
];

const c = (numero: string, nome: string, partido: string, extra: { vice?: string; suplentes?: string[] } = {}) => ({ numero, nome, partido, ...extra });

const SENADORES = [
  c("222", "Carlos Bolsonaro", "PL", { suplentes: ["Rui Teixeira", "Marta Ilha"] }),
  c("221", "Carol De toni", "PL", { suplentes: ["Jonas Freire", "Telma Rios"] }),
  c("555", "Mirela Antunes", "PSD", { suplentes: ["Saulo Brito", "Cida Moraes"] }),
  c("151", "Jorge Valadares", "MDB", { suplentes: ["Ivo Peixoto", "Nair Campos"] }),
  c("400", "Carla Nogueira", "PSB", { suplentes: ["Bento Lago", "Alice Cunha"] }),
  c("300", "Henrique Leal", "Novo", { suplentes: ["Davi Matos", "Lena Cruz"] }),
];

/** A ordem do array é a ordem da urna. */
export const CARGOS_2026: Cargo[] = [
  {
    id: "deputado_federal", nome: "Deputado Federal", digitos: 4, legenda: true,
    candidatos: [
      c("2222", "Jair Bolsonaro", "PL"), c("1345", "Rogério Tavares", "PT"), c("2210", "Patrícia Leme", "PL"),
      c("2277", "Sérgio Bastos", "PL"), c("5501", "Helena Prates", "PSD"), c("1515", "Otávio Mendonça", "MDB"),
      c("4040", "Juliana Rocha", "PSB"), c("3030", "Caio Fontes", "Novo"), c("5050", "Lia Andrade", "PSOL"),
      c("1010", "Márcio Dantas", "Republicanos"), c("4444", "Renata Viana", "União"), c("1111", "Paulo Seixas", "PP"),
    ],
  },
  {
    id: "deputado_estadual", nome: "Deputado Estadual", digitos: 5, legenda: true,
    candidatos: [
      c("13013", "Beatriz Galvão", "PT"), c("13200", "Diego Paiva", "PT"), c("22022", "Fernanda Ribas", "PL"),
      c("15115", "Marcos Both", "MDB"), c("55555", "Ivone Castro", "PSD"), c("15100", "Leandro Queiroz", "MDB"),
      c("40123", "Nádia Freitas", "PSB"), c("30300", "Otto Barreto", "Novo"), c("50500", "Raquel Moura", "PSOL"),
      c("10100", "Tiago Brandão", "Republicanos"),
    ],
  },
  { id: "senador_1", nome: "Senador — 1ª vaga", digitos: 3, legenda: false, candidatos: SENADORES },
  { id: "senador_2", nome: "Senador — 2ª vaga", digitos: 3, legenda: false, candidatos: SENADORES },
  {
    id: "governador", nome: "Governador", digitos: 2, legenda: false,
    candidatos: [
      c("22", "Jorginho Mello", "PL", { vice: "Lucas Amaral" }),
      c("55", "Augusto Lacerda", "PSD", { vice: "Vera Pimentel" }), c("40", "Simone Barcelos", "PSB", { vice: "Hugo Taveira" }),
      c("30", "Ricardo Pena", "Novo", { vice: "Laura Bittencourt" }), c("50", "Luana Prates", "PSOL", { vice: "Mateus Quirino" }),
    ],
  },
  {
    id: "presidente", nome: "Presidente", digitos: 2, legenda: false,
    // Sem a chave "vice" quando ausente: undefined viraria null no banco e mudaria o hash do bloco gênese.
    candidatos: CANDIDATOS_2026.map(({ votos: _v, vice, ...x }) => (vice ? { ...x, vice } : x)),
  },
];
