import { useState } from "react";
import type { ResultadoCargo } from "../api";

const nf = new Intl.NumberFormat("pt-BR");
const pct = (n: number) => `${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

/** Resultado apurado com uma aba por cargo. Percentuais de candidatos/legendas são sobre os votos válidos. */
export function ResultadoCargos({ cargos, totalVotos }: { cargos: ResultadoCargo[]; totalVotos: number }) {
  const [ativo, setAtivo] = useState(cargos.find((c) => c.id === "presidente")?.id ?? cargos[0]?.id);
  const r = cargos.find((c) => c.id === ativo) ?? cargos[0];
  if (!r) return null;
  const linhas = [
    ...r.candidatos.map((c) => ({ chave: `c${c.numero}`, numero: c.numero, nome: c.nome, partido: c.partido, votos: c.votos })),
    ...r.legendas.map((l) => ({ chave: `l${l.numero}`, numero: l.numero, nome: `Voto de legenda`, partido: l.sigla, votos: l.votos })),
  ].sort((a, b) => b.votos - a.votos);
  const max = Math.max(1, ...linhas.map((l) => l.votos));

  return (
    <div className="resultado-cargos">
      <div className="abas" role="tablist" aria-label="Cargo">
        {cargos.map((c) => (
          <button key={c.id} role="tab" aria-selected={c.id === r.id} className={`aba ${c.id === r.id ? "ativa" : ""}`} onClick={() => setAtivo(c.id)}>
            {c.nome}
          </button>
        ))}
      </div>
      <ol className="ranking" role="tabpanel" aria-label={r.nome}>
        {linhas.map((c, i) => (
          <li key={c.chave}>
            <span className="rk-pos">{i + 1}º</span>
            <span className="rk-nome"><strong>{c.nome}</strong> <small>{c.partido} · {c.numero}</small></span>
            <span className="barra-trilho"><span className={`barra ${i === 0 && c.votos > 0 ? "lider" : ""}`} style={{ width: `${(c.votos / max) * 100}%` }} /></span>
            <span className="rk-valor">{pct(r.validos ? (c.votos / r.validos) * 100 : 0)}<small>{nf.format(c.votos)}</small></span>
          </li>
        ))}
      </ol>
      <dl className="pares">
        <dt>Votos válidos</dt><dd>{nf.format(r.validos)} (candidatos + legendas)</dd>
        <dt>Brancos</dt><dd>{nf.format(r.brancos)} ({pct(totalVotos ? (r.brancos / totalVotos) * 100 : 0)} das cédulas)</dd>
        <dt>Nulos</dt><dd>{nf.format(r.nulos)} ({pct(totalVotos ? (r.nulos / totalVotos) * 100 : 0)} das cédulas)</dd>
      </dl>
    </div>
  );
}
