import { useCallback, useEffect, useState } from "react";
import { api, ErroApi, type ResultadoCargo } from "../api";
import { curto } from "../crypto";
import { ResultadoCargos } from "../components/ResultadoCargos";

interface DadosDashboard {
  geradoEm: string;
  eleicao: { id: string; titulo: string; cargos: { id: string; nome: string; candidatos: number }[]; estado: "preparada" | "aberta" | "encerrada" | "apurada"; abertaEm: string | null; encerradaEm: string | null };
  participacao: { aptos: number; compareceram: number; ausentes: number; percentual: number; votosNaCadeia: number };
  votosPorHora: { hora: string; votos: number }[];
  ledger: {
    temConsenso: boolean; quorum: number; totalNos: number; nosEmConsenso: number; hashFinal: string | null;
    nos: { nome: string; situacao: string; blocos: number; hashFinal: string | null }[];
  };
  seguranca: {
    janelaHoras: number; loginsOk: number; totalAlertas: number; contasBloqueadas: number;
    alertas: { tipo: string; total: number }[];
    alertasPorHora: { hora: string; total: number }[];
    trilha: { integra: boolean; eventos: number; erro?: { seq: number; motivo: string } };
    ultimosAlertas: { seq: number; quando: string; tipo: string; ator: string; ip: string }[];
  };
  resultado: null | { cargos: ResultadoCargo[]; totalVotos: number; hashBoletim: string; geradoEm: string };
}

const ESTADO: Record<string, string> = { preparada: "Preparada", aberta: "Votação aberta", encerrada: "Encerrada, aguardando apuração", apurada: "Apurada" };

const NOME_EVENTO: Record<string, string> = {
  LOGIN_FALHA: "Senha incorreta",
  MFA_FALHA: "Código de verificação incorreto",
  CONTA_BLOQUEADA: "Conta bloqueada por excesso de erros",
  RATE_LIMIT: "Bloqueio por excesso de requisições",
  CSRF_BLOQUEADO: "Requisição forjada (CSRF) barrada",
  ACESSO_NEGADO: "Acesso a área sem permissão",
  VOTO_DUPLICADO_BLOQUEADO: "Segundo voto barrado",
  VOTO_NAO_REPLICADO: "Voto não replicado (revertido)",
  APURACAO_RECUSADA: "Apuração recusada",
};

const nf = new Intl.NumberFormat("pt-BR");
const pct = (n: number, d = 1) => `${n.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
const horaLocal = (h: string) => `${String(new Date(`${h}:00:00Z`).getHours()).padStart(2, "0")}h`;

/** Gráfico de barras em SVG puro: sem biblioteca, sem estilo inline (compatível com a CSP). */
function BarrasPorHora({ dados, rotulo, vazio }: { dados: { hora: string; valor: number }[]; rotulo: string; vazio: string }) {
  if (!dados.length) return <p className="vazio">{vazio}</p>;
  const max = Math.max(...dados.map((d) => d.valor), 1);
  const L = 560, A = 170, base = A - 28, passo = L / dados.length, larg = Math.min(passo * 0.7, 46);
  return (
    <svg className="grafico" viewBox={`0 0 ${L} ${A}`} role="img" aria-label={rotulo}>
      <line x1="0" y1={base} x2={L} y2={base} className="eixo" />
      {dados.map((d, i) => {
        const h = Math.max((d.valor / max) * (base - 18), d.valor ? 2 : 0);
        const x = i * passo + (passo - larg) / 2;
        return (
          <g key={d.hora}>
            <title>{`${horaLocal(d.hora)}: ${d.valor}`}</title>
            <rect x={x} y={base - h} width={larg} height={h} rx="2" className="coluna" />
            <text x={x + larg / 2} y={base - h - 4} textAnchor="middle" className="valor-svg">{d.valor}</text>
            <text x={x + larg / 2} y={A - 8} textAnchor="middle" className="rotulo-svg">{horaLocal(d.hora)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Bloco({ titulo, dica, children }: { titulo: string; dica?: string; children: React.ReactNode }) {
  return (
    <section className="cartao bloco-dash">
      <h2>{titulo}</h2>
      {dica && <p className="dica">{dica}</p>}
      {children}
    </section>
  );
}

export function Dashboard() {
  const [d, setD] = useState<DadosDashboard | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(
    () => api.get<DadosDashboard>("/auditoria/dashboard").then((x) => { setD(x); setErro(null); }).catch((e: ErroApi) => setErro(e.message)),
    [],
  );
  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 10_000);
    return () => clearInterval(t);
  }, [carregar]);

  if (!d) return <p className={erro ? "erro" : "carregando"}>{erro ?? "Carregando painel…"}</p>;
  const { participacao: p, ledger: l, seguranca: s, eleicao: e, resultado: r } = d;
  const maxAlerta = Math.max(...s.alertas.map((a) => a.total), 1);

  return (
    <section className="painel dash">
      <div className="cabecalho-secao">
        <div>
          <h1>Painel da eleição</h1>
          <p className="subtitulo">{e.titulo} — {e.cargos.length} cargos na cédula</p>
        </div>
        <p className="dica">
          <span className={`selo estado-${e.estado}`}>{ESTADO[e.estado]}</span>{" "}
          atualizado às {new Date(d.geradoEm).toLocaleTimeString("pt-BR")} (a cada 10 s)
        </p>
      </div>
      {erro && <p className="erro" role="status">{erro}</p>}

      <div className="tiles">
        <div className="tile">
          <span className="tile-valor">{pct(p.percentual)}</span>
          <span className="tile-rotulo">comparecimento</span>
          <span className="tile-nota">{nf.format(p.compareceram)} de {nf.format(p.aptos)} aptos</span>
        </div>
        <div className="tile">
          <span className="tile-valor">{nf.format(p.votosNaCadeia)}</span>
          <span className="tile-rotulo">votos na cadeia</span>
          <span className="tile-nota">{p.votosNaCadeia === p.compareceram ? "batem com o comparecimento" : "DIVERGE do comparecimento"}</span>
        </div>
        <div className={`tile ${l.temConsenso ? "" : "tile-alerta"}`}>
          <span className="tile-valor">{l.nosEmConsenso}/{l.totalNos}</span>
          <span className="tile-rotulo">nós em consenso</span>
          <span className="tile-nota">{l.temConsenso ? `quórum ${l.quorum} atingido` : "SEM consenso: votação bloqueada"}</span>
        </div>
        <div className={`tile ${s.totalAlertas ? "tile-aviso" : ""}`}>
          <span className="tile-valor">{nf.format(s.totalAlertas)}</span>
          <span className="tile-rotulo">alertas de segurança</span>
          <span className="tile-nota">últimas {s.janelaHoras} h · {nf.format(s.loginsOk)} logins válidos</span>
        </div>
      </div>

      <div className="grade-dash">
        <Bloco titulo="Participação">
          <div className="pilha" role="img" aria-label={`${p.compareceram} compareceram, ${p.ausentes} ausentes`}>
            <span className="pilha-voto" style={{ width: `${p.percentual}%` }} />
          </div>
          <dl className="pares">
            <dt>Compareceram</dt><dd>{nf.format(p.compareceram)} ({pct(p.percentual)})</dd>
            <dt>Ausentes (abstenção)</dt><dd>{nf.format(p.ausentes)} ({pct(100 - p.percentual)})</dd>
            <dt>Candidaturas</dt><dd>{e.cargos.filter((c) => c.id !== "senador_2").reduce((s, c) => s + c.candidatos, 0)}</dd>
          </dl>
        </Bloco>

        <Bloco titulo="Votos por hora" dica="Horário do carimbo do bloco (truncado ao minuto), no fuso do seu navegador.">
          <BarrasPorHora
            rotulo="Votos registrados por hora"
            vazio="Nenhum voto registrado ainda."
            dados={d.votosPorHora.map((h) => ({ hora: h.hora, valor: h.votos }))}
          />
        </Bloco>
      </div>

      <Bloco
        titulo="Resultado"
        dica={r ? undefined : "Os votos estão cifrados e só a Junta, com a frase-senha, consegue abri-los. Por sigilo, nenhum placar parcial existe: o resultado aparece aqui depois da apuração."}
      >
        {r ? (
          <>
            <ResultadoCargos cargos={r.cargos} totalVotos={r.totalVotos} />
            <dl className="pares">
              <dt>Cédulas apuradas</dt><dd>{nf.format(r.totalVotos)}</dd>
              <dt>Boletim assinado</dt><dd><code>{curto(r.hashBoletim, 14)}</code></dd>
            </dl>
          </>
        ) : (
          <p className="trava">🔒 Resultado sob sigilo até a apuração.</p>
        )}
      </Bloco>

      <div className="grade-dash">
        <Bloco titulo="Ledger replicado" dica="Cada nó guarda uma cópia da cadeia de votos; a maioria vence.">
          <div className="tabela-rolagem">
            <table>
              <thead><tr><th>Nó</th><th>Situação</th><th>Blocos</th><th>Hash final</th></tr></thead>
              <tbody>
                {l.nos.map((n) => (
                  <tr key={n.nome} className={`situacao-${n.situacao}`}>
                    <td><strong>{n.nome}</strong></td>
                    <td><span className="selo">{n.situacao === "consenso" ? "Em consenso" : n.situacao}</span></td>
                    <td>{n.blocos}</td>
                    <td><code>{curto(n.hashFinal, 8)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Bloco>

        <Bloco titulo="Trilha de auditoria" dica="Registro encadeado e assinado de tudo que é sensível.">
          <p className={`consenso ${s.trilha.integra ? "ok" : "falha"}`}>
            {s.trilha.integra
              ? `Íntegra: ${nf.format(s.trilha.eventos)} eventos com hash e assinatura conferidos.`
              : `ADULTERADA no evento ${s.trilha.erro?.seq}: ${s.trilha.erro?.motivo}`}
          </p>
          <dl className="pares">
            <dt>Contas bloqueadas agora</dt><dd>{s.contasBloqueadas}</dd>
          </dl>
        </Bloco>
      </div>

      <Bloco titulo="Segurança" dica={`Tentativas de abuso barradas nas últimas ${s.janelaHoras} horas.`}>
        <div className="grade-dash">
          <ul className="barras compacto">
            {s.alertas.map((a) => (
              <li key={a.tipo}>
                <span>{NOME_EVENTO[a.tipo] ?? a.tipo}</span>
                <span className="barra-trilho"><span className="barra alerta" style={{ width: `${(a.total / maxAlerta) * 100}%` }} /></span>
                <span className="barra-valor">{nf.format(a.total)}</span>
              </li>
            ))}
          </ul>
          <div>
            <h3 className="mini-titulo">Alertas por hora</h3>
            <BarrasPorHora rotulo="Alertas de segurança por hora" vazio="Nenhum alerta no período." dados={s.alertasPorHora.map((h) => ({ hora: h.hora, valor: h.total }))} />
          </div>
        </div>
        <h3 className="mini-titulo">Últimos alertas</h3>
        {s.ultimosAlertas.length === 0 ? (
          <p className="vazio">Nenhum alerta registrado.</p>
        ) : (
          <div className="tabela-rolagem">
            <table>
              <thead><tr><th>Quando</th><th>Evento</th><th>Origem</th><th>IP</th></tr></thead>
              <tbody>
                {s.ultimosAlertas.map((a) => (
                  <tr key={a.seq}>
                    <td>{new Date(a.quando).toLocaleString("pt-BR")}</td>
                    <td>{NOME_EVENTO[a.tipo] ?? a.tipo}</td>
                    <td>{a.ator}</td>
                    <td><code>{a.ip}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Bloco>
    </section>
  );
}
