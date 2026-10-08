import { useCallback, useEffect, useState } from "react";
import { api, ErroApi, type EstadoReplicas } from "../api";
import { Replicas } from "../components/Replicas";
import { curto } from "../crypto";

interface Evento {
  seq: number;
  quando: string;
  tipo: string;
  ator: string;
  ip: string;
  detalhes: Record<string, unknown>;
  hash: string;
}
interface Trilha {
  verificacao: { integra: boolean; total: number; hashFinal?: string; erro?: { seq: number; motivo: string } };
  eventos: Evento[];
}
interface Amostra {
  totalVotos: number;
  amostra: number;
  conferidos: number;
  itens: { seq: number; conferido: boolean; porNo: { no: string; hash: string | null; valido: boolean }[] }[];
}

const ALERTA = new Set(["LOGIN_FALHA", "MFA_FALHA", "CONTA_BLOQUEADA", "VOTO_DUPLICADO_BLOQUEADO", "ACESSO_NEGADO", "CSRF_BLOQUEADO", "RATE_LIMIT", "APURACAO_RECUSADA", "VOTO_NAO_REPLICADO"]);

export function Auditoria() {
  const [replicas, setReplicas] = useState<EstadoReplicas | null>(null);
  const [trilha, setTrilha] = useState<Trilha | null>(null);
  const [amostra, setAmostra] = useState<Amostra | null>(null);
  const [tamanho, setTamanho] = useState(5);
  const [erro, setErro] = useState<string | null>(null);

  const verificar = useCallback(async () => {
    setErro(null);
    try {
      const [r, t] = await Promise.all([api.get<EstadoReplicas>("/auditoria/ledger"), api.get<Trilha>("/auditoria/eventos")]);
      setReplicas(r);
      setTrilha(t);
    } catch (e) {
      setErro((e as ErroApi).message);
    }
  }, []);
  useEffect(() => {
    verificar();
  }, [verificar]);

  async function sortear() {
    setErro(null);
    try {
      setAmostra(await api.post<Amostra>("/auditoria/amostragem", { tamanho }));
    } catch (e) {
      setErro((e as ErroApi).message);
    }
  }

  return (
    <section className="painel">
      <h1>Auditoria</h1>
      <p className="subtitulo">Acesso somente leitura. Cada verificação recalcula hashes e assinaturas de todos os blocos e fica registrada na trilha.</p>
      {erro && <p className="erro" role="alert">{erro}</p>}

      <div className="cabecalho-secao">
        <h2>Réplicas do ledger de votos</h2>
        <button className="botao primario" onClick={verificar}>Verificar réplicas</button>
      </div>
      {replicas && <Replicas estado={replicas} />}

      <div className="cabecalho-secao">
        <h2>Recontagem por amostragem</h2>
        <div className="form-linha">
          <label>
            Blocos sorteados
            <input type="number" min={1} max={50} value={tamanho} onChange={(e) => setTamanho(Number(e.target.value))} />
          </label>
          <button className="botao" onClick={sortear}>Sortear e conferir</button>
        </div>
      </div>
      {amostra && (
        <>
          <p className={amostra.conferidos === amostra.amostra ? "sucesso" : "erro"}>
            {amostra.conferidos} de {amostra.amostra} blocos sorteados (de {amostra.totalVotos} votos) são idênticos e válidos em todos os nós.
          </p>
          <div className="tabela-rolagem">
            <table>
              <thead>
                <tr><th>Bloco</th>{amostra.itens[0]?.porNo.map((p) => <th key={p.no}>{p.no}</th>)}<th>Resultado</th></tr>
              </thead>
              <tbody>
                {amostra.itens.map((i) => (
                  <tr key={i.seq} className={i.conferido ? "" : "situacao-corrompido"}>
                    <td>{i.seq}</td>
                    {i.porNo.map((p) => <td key={p.no}><code>{p.valido ? curto(p.hash, 8) : "inválido"}</code></td>)}
                    <td>{i.conferido ? "Confere" : "Divergente"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="cabecalho-secao">
        <h2>Trilha de auditoria</h2>
      </div>
      {trilha && (
        <>
          <p className={trilha.verificacao.integra ? "sucesso" : "erro"}>
            {trilha.verificacao.integra
              ? `Trilha íntegra: ${trilha.verificacao.total} eventos encadeados e assinados.`
              : `Trilha adulterada no evento ${trilha.verificacao.erro?.seq}: ${trilha.verificacao.erro?.motivo}`}
          </p>
          <div className="tabela-rolagem">
            <table className="eventos">
              <thead><tr><th>#</th><th>Quando</th><th>Evento</th><th>Quem</th><th>IP</th><th>Detalhes</th><th>Hash</th></tr></thead>
              <tbody>
                {trilha.eventos.map((e) => (
                  <tr key={e.seq} className={ALERTA.has(e.tipo) ? "alerta" : ""}>
                    <td>{e.seq}</td>
                    <td>{new Date(e.quando).toLocaleString("pt-BR")}</td>
                    <td>{e.tipo}</td>
                    <td>{e.ator}</td>
                    <td>{e.ip}</td>
                    <td className="detalhes">{Object.keys(e.detalhes).length ? JSON.stringify(e.detalhes) : "—"}</td>
                    <td><code>{curto(e.hash, 8)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
