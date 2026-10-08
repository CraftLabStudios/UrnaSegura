import type { EstadoReplicas, NoEstado } from "../api";
import { curto } from "../crypto";

const ROTULO: Record<NoEstado["situacao"], string> = {
  consenso: "Íntegro, em consenso",
  atrasado: "Íntegro, atrasado",
  corrompido: "Adulteração detectada",
  divergente: "Diverge da maioria",
  indisponivel: "Fora do ar",
};

export function Replicas({ estado, acao }: { estado: EstadoReplicas; acao?: (no: NoEstado) => React.ReactNode }) {
  return (
    <div className="replicas">
      <p className={`consenso ${estado.temConsenso ? "ok" : "falha"}`}>
        {estado.temConsenso
          ? `Consenso: ${estado.nos.filter((n) => n.situacao === "consenso").length} de ${estado.totalNos} nós concordam (quórum ${estado.quorum}). Hash final ${curto(estado.hashFinalConsenso, 12)}`
          : `Sem consenso: menos de ${estado.quorum} nós íntegros concordam. Votação e apuração ficam bloqueadas.`}
      </p>
      <div className="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Nó</th>
              <th>Situação</th>
              <th>Blocos válidos</th>
              <th>Hash final</th>
              <th>Detalhe</th>
              {acao && <th><span className="sr">Ação</span></th>}
            </tr>
          </thead>
          <tbody>
            {estado.nos.map((n) => (
              <tr key={n.nome} className={`situacao-${n.situacao}`}>
                <td><strong>{n.nome}</strong></td>
                <td><span className="selo">{ROTULO[n.situacao]}</span></td>
                <td>{n.blocos}</td>
                <td><code>{curto(n.hashFinal, 10)}</code></td>
                <td>{n.erro ? `Bloco ${n.erro.seq}: ${n.erro.motivo}` : "—"}</td>
                {acao && <td>{acao(n)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
