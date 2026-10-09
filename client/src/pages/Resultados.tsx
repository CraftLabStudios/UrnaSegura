import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Boletim, type Candidato, type Eleicao } from "../api";
import { jsonCanonico, sha256Hex, verificarAssinaturaHash } from "../crypto";
import { Foto } from "../components/Foto";

/**
 * RESULTADOS AO VIVO (público, sem login). Consulta /api/public/ao-vivo a cada 5 s.
 * Antes da apuração não existe placar (as cédulas estão cifradas — sigilo do voto): a tela mostra a
 * participação e os candidatos. Depois, quem está na frente, a lista filtrável e o boletim conferido aqui.
 */
interface AoVivo {
  geradoEm: string;
  eleicao: { titulo: string; estado: "preparada" | "aberta" | "encerrada" | "apurada" };
  participacao: { aptos: number; compareceram: number; percentual: number; votosNaCadeia: number };
  votosPorHora: { hora: string; votos: number }[];
  ledger: { temConsenso: boolean; totalNos: number; nosEmConsenso: number };
  boletim: Boletim | null;
}

interface Linha {
  chave: string;
  numero: string;
  nome: string;
  partido: string;
  votos: number | null; // null = ainda não apurado
  pct: number | null;
  posicao: number | null;
  candidato: Candidato;
  legenda?: boolean;
}

const INTERVALO_MS = 5_000;
const ORDEM_CARGOS = ["presidente", "governador", "senador_1", "senador_2", "deputado_federal", "deputado_estadual"];
const NOME_CURTO: Record<string, string> = {
  presidente: "Presidente", governador: "Governador", senador_1: "Senador (1ª vaga)", senador_2: "Senador (2ª vaga)",
  deputado_federal: "Dep. Federal", deputado_estadual: "Dep. Estadual",
};
const ESTADO: Record<string, string> = { preparada: "Votação ainda não aberta", aberta: "Votação em andamento", encerrada: "Votação encerrada · aguardando apuração", apurada: "Apuração concluída" };

const nf = new Intl.NumberFormat("pt-BR");
const pct = (n: number, casas = 2) => `${n.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
/** Diferença em pontos percentuais (não é porcentagem de porcentagem). */
const pp = (n: number) => `${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${Math.abs(n) >= 2 ? "pontos percentuais" : "ponto percentual"}`;
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const horaLocal = (h: string) => `${String(new Date(`${h}:00:00Z`).getHours()).padStart(2, "0")}h`;

/** Cédulas por hora (antes da apuração): colunas finas, rótulo só no pico, valor de cada hora no title. */
function Ritmo({ dados }: { dados: { hora: string; votos: number }[] }) {
  if (!dados.length) return null;
  const max = Math.max(...dados.map((d) => d.votos), 1);
  const pico = dados.reduce((a, b) => (b.votos > a.votos ? b : a));
  return (
    <div className="res-ritmo" role="img" aria-label={`Cédulas por hora; pico de ${pico.votos} às ${horaLocal(pico.hora)}`}>
      {dados.map((d) => (
        <div key={d.hora} className="res-ritmo-col" title={`${horaLocal(d.hora)}: ${nf.format(d.votos)} cédulas`}>
          <span className="res-ritmo-valor">{d === pico ? d.votos : ""}</span>
          <span className="res-ritmo-barra" style={{ height: `${Math.max((d.votos / max) * 100, 3)}%` }} />
          <span className="res-ritmo-hora">{horaLocal(d.hora)}</span>
        </div>
      ))}
    </div>
  );
}

export function Resultados() {
  const [d, setD] = useState<AoVivo | null>(null);
  const [eleicao, setEleicao] = useState<Eleicao | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [agora, setAgora] = useState(Date.now());
  const [cargo, setCargo] = useState("presidente");
  const [busca, setBusca] = useState("");
  const [partido, setPartido] = useState("");
  const [foco, setFoco] = useState<string | null>(null); // número do candidato em foco
  const [chaveAssinatura, setChaveAssinatura] = useState<string | null>(null);
  const [autentico, setAutentico] = useState<{ hash: string; ok: boolean } | null>(null);

  const carregar = useCallback(() => {
    api.get<AoVivo>("/public/ao-vivo").then((x) => { setD(x); setFalhou(false); }).catch(() => setFalhou(true));
  }, []);
  useEffect(() => {
    carregar();
    api.get<Eleicao>("/eleicao").then(setEleicao).catch(() => undefined);
    api.get<{ assinaturaEd25519Spki: string }>("/public/chaves").then((c) => setChaveAssinatura(c.assinaturaEd25519Spki)).catch(() => undefined);
    const t = setInterval(carregar, INTERVALO_MS);
    const r = setInterval(() => setAgora(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(r); };
  }, [carregar]);

  // Confere o boletim NESTE navegador (hash recalculado + assinatura Ed25519), uma vez por boletim.
  const boletim = d?.boletim ?? null;
  useEffect(() => {
    if (!boletim || !chaveAssinatura || autentico?.hash === boletim.hash) return;
    const { hash, assinatura, ...base } = boletim;
    (async () => setAutentico({ hash, ok: (await sha256Hex(jsonCanonico(base))) === hash && (await verificarAssinaturaHash(hash, assinatura, chaveAssinatura)) }))()
      .catch(() => setAutentico({ hash: boletim.hash, ok: false }));
  }, [boletim, chaveAssinatura, autentico]);

  const cargos = useMemo(() => (eleicao ? ORDEM_CARGOS.map((id) => eleicao.cargos.find((c) => c.id === id)).filter((c) => !!c) : []), [eleicao]);
  const cargoAtual = cargos.find((c) => c.id === cargo) ?? cargos[0];
  const resultado = boletim?.cargos.find((c) => c.id === cargoAtual?.id);

  // Todas as linhas do cargo (com votos se já apurado), ordenadas por votos ou por número.
  const linhas: Linha[] = useMemo(() => {
    if (!cargoAtual) return [];
    const base: Linha[] = cargoAtual.candidatos.map((c) => {
      const v = resultado?.candidatos.find((x) => x.numero === c.numero)?.votos ?? null;
      return { chave: c.numero, numero: c.numero, nome: c.nome, partido: c.partido, votos: v, pct: null, posicao: null, candidato: c };
    });
    const legendas: Linha[] = (resultado?.legendas ?? []).map((l) => ({
      chave: `L${l.numero}`, numero: l.numero, nome: `Legenda ${l.sigla}`, partido: l.sigla, votos: l.votos, pct: null, posicao: null, legenda: true,
      candidato: { numero: l.numero, nome: l.sigla, partido: l.sigla },
    }));
    if (!resultado) return base.sort((a, b) => a.numero.localeCompare(b.numero));
    // Candidatos recebem posição; votos de legenda vêm depois, agrupados e sem posição (não disputam lugar).
    const porVotos = (a: Linha, b: Linha) => (b.votos ?? 0) - (a.votos ?? 0) || a.numero.localeCompare(b.numero);
    const todas = [...base.sort(porVotos), ...legendas.sort(porVotos)];
    todas.forEach((l, i) => {
      l.pct = resultado.validos ? ((l.votos ?? 0) / resultado.validos) * 100 : 0;
      l.posicao = l.legenda ? null : i + 1;
    });
    return todas;
  }, [cargoAtual, resultado]);

  const partidos = useMemo(() => [...new Set(linhas.filter((l) => !l.legenda).map((l) => l.partido))].sort(), [linhas]);
  const filtradas = linhas.filter((l) =>
    (!partido || l.partido === partido) &&
    (!busca || semAcento(`${l.nome} ${l.partido} ${l.numero}`).includes(semAcento(busca))),
  );
  const lider = resultado ? linhas.find((l) => !l.legenda) : undefined;
  const segundo = resultado ? linhas.filter((l) => !l.legenda)[1] : undefined;
  const emFoco = (foco && linhas.find((l) => l.chave === foco)) || lider;
  const maxPct = Math.max(...linhas.map((l) => l.pct ?? 0), 1);

  const trocarCargo = (id: string) => { setCargo(id); setFoco(null); setBusca(""); setPartido(""); };

  if (!d || !eleicao) return <p className="carregando">{falhou ? "Não foi possível carregar os resultados. Tentando de novo…" : "Carregando resultados…"}</p>;

  const p = d.participacao;
  const segundos = Math.max(0, Math.round((agora - new Date(d.geradoEm).getTime()) / 1000));

  return (
    <section className="res">
      <header className="res-topo">
        <div>
          <p className="res-sobre">Eleições Gerais 2026 · simulação</p>
          <h1>Resultados</h1>
        </div>
        <div className="res-status">
          <span className={`res-vivo ${falhou ? "off" : ""}`}><span className="res-ponto" aria-hidden="true" />{falhou ? "Reconectando" : "Ao vivo"}</span>
          <span className="res-estado">{ESTADO[d.eleicao.estado]}</span>
        </div>
      </header>

      {/* ---------------- filtros (uma linha) ---------------- */}
      <div className="res-filtros" role="search">
        <div className="res-cargos" role="tablist" aria-label="Cargo">
          {cargos.map((c) => (
            <button key={c.id} role="tab" aria-selected={c.id === cargoAtual?.id} className={c.id === cargoAtual?.id ? "ativo" : ""} onClick={() => trocarCargo(c.id)}>
              {NOME_CURTO[c.id] ?? c.nome}
            </button>
          ))}
        </div>
        <div className="res-campos">
          <input type="search" placeholder="Buscar candidato, partido ou número" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar candidato" />
          <select value={partido} onChange={(e) => setPartido(e.target.value)} aria-label="Filtrar por partido">
            <option value="">Todos os partidos</option>
            {partidos.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
      </div>

      {/* ---------------- destaque ---------------- */}
      {resultado && emFoco && lider ? (
        <article className={`res-destaque ${emFoco === lider ? "lider" : ""}`} aria-live="polite">
          <Foto candidato={emFoco.candidato} />
          <div className="res-destaque-info">
            <p className="res-etiqueta">{emFoco === lider ? "Na frente" : `${emFoco.posicao}º lugar`} · {cargoAtual?.nome}</p>
            <h2>{emFoco.nome}</h2>
            <p className="res-partido">{emFoco.partido} · {emFoco.numero}</p>
            <p className="res-situacao">
              {emFoco === lider
                ? segundo && `${pp((lider.pct ?? 0) - (segundo.pct ?? 0))} à frente de ${segundo.nome}`
                : `${pp((lider.pct ?? 0) - (emFoco.pct ?? 0))} atrás de ${lider.nome}`}
              {emFoco === lider && (cargo === "presidente" || cargo === "governador") && (
                <span className={`res-selo ${(lider.pct ?? 0) > 50 ? "eleito" : "turno"}`}>{(lider.pct ?? 0) > 50 ? "Eleito(a) no 1º turno" : "Vai ao 2º turno"}</span>
              )}
            </p>
          </div>
          <div className="res-destaque-num">
            <span className="res-pct">{pct(emFoco.pct ?? 0)}</span>
            <span className="res-votos">{nf.format(emFoco.votos ?? 0)} votos</span>
            {foco && <button className="res-limpar" onClick={() => setFoco(null)}>Ver quem está na frente</button>}
          </div>
        </article>
      ) : (
        <article className="res-destaque espera">
          <div>
            <p className="res-etiqueta">{d.eleicao.estado === "aberta" ? "Votação em andamento" : ESTADO[d.eleicao.estado]}</p>
            <h2>{nf.format(p.votosNaCadeia)} cédulas recebidas</h2>
            <p className="res-partido">{pct(p.percentual, 1)} de comparecimento · {nf.format(p.aptos)} eleitores aptos</p>
            <p className="res-nota">🔒 Não há placar parcial: os votos ficam cifrados até a apuração. O resultado aparece aqui assim que for publicado.</p>
          </div>
          <Ritmo dados={d.votosPorHora} />
        </article>
      )}

      {/* ---------------- lista ---------------- */}
      <div className="res-lista-topo">
        <h3>{resultado ? "Todos os candidatos" : "Candidatos"} <span>{filtradas.length}{filtradas.length !== linhas.length ? ` de ${linhas.length}` : ""}</span></h3>
        {resultado && <p>% dos votos válidos · {nf.format(resultado.validos)} válidos, {nf.format(resultado.brancos)} brancos, {nf.format(resultado.nulos)} nulos</p>}
      </div>
      {filtradas.length === 0 ? (
        <p className="res-vazio">Nenhum candidato encontrado com esses filtros. <button className="res-limpar" onClick={() => { setBusca(""); setPartido(""); }}>Limpar filtros</button></p>
      ) : (
        <ol className="res-lista">
          {filtradas.map((l) => (
            <li key={l.chave}>
              <button className={`res-linha ${l === lider ? "lider" : ""} ${foco === l.chave ? "foco" : ""}`} onClick={() => resultado && setFoco(l.chave)} disabled={!resultado}>
                <span className="res-pos">{l.posicao ? `${l.posicao}º` : l.legenda ? "" : l.numero}</span>
                {l.legenda ? <span className="res-mini-legenda" aria-hidden="true">{l.numero}</span> : <Foto candidato={l.candidato} tamanho="pequena" />}
                <span className="res-nome"><strong>{l.nome}</strong><small>{l.legenda ? "voto só no partido" : `${l.partido} · ${l.numero}`}</small></span>
                {resultado && (
                  <>
                    <span className="res-trilho"><span className="res-barra" style={{ width: `${((l.pct ?? 0) / maxPct) * 100}%` }} /></span>
                    <span className="res-num"><strong>{pct(l.pct ?? 0)}</strong><small>{nf.format(l.votos ?? 0)}</small></span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}

      {/* ---------------- rodapé técnico (discreto) ---------------- */}
      <footer className="res-rodape">
        <span className={d.ledger.temConsenso ? "ok" : "falha"}>{d.ledger.temConsenso ? "✓" : "⚠"} {d.ledger.nosEmConsenso}/{d.ledger.totalNos} nós íntegros</span>
        {boletim && <span className={autentico?.ok === false ? "falha" : "ok"}>{autentico === null ? "Conferindo boletim…" : autentico.ok ? "✓ Boletim autêntico (assinatura conferida aqui)" : "✕ Assinatura do boletim não confere"}</span>}
        <span>Comparecimento {pct(p.percentual, 1)}</span>
        <span>Atualizado há {segundos}s</span>
      </footer>
    </section>
  );
}
