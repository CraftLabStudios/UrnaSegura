import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ErroApi, type Boletim, type EstadoReplicas } from "../api";
import { Replicas } from "../components/Replicas";

interface Painel {
  eleicao: { id: string; titulo: string; cargo: string; estado: string; abertaEm?: string; encerradaEm?: string };
  eleitoresAptos: number;
  comparecimento: number;
  replicas: EstadoReplicas;
}

const ESTADOS = ["preparada", "aberta", "encerrada", "apurada"];

export function Admin() {
  const [painel, setPainel] = useState<Painel | null>(null);
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [frase, setFrase] = useState("");
  const [confirmar, setConfirmar] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(() => api.get<Painel>("/admin/painel").then(setPainel).catch((e) => setMsg({ tipo: "erro", texto: e.message })), []);
  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 5000);
    return () => clearInterval(t);
  }, [carregar]);

  async function executar(url: string, corpo: unknown, sucesso: string) {
    setOcupado(true);
    setMsg(null);
    try {
      await api.post(url, corpo);
      setMsg({ tipo: "ok", texto: sucesso });
      await carregar();
    } catch (e) {
      setMsg({ tipo: "erro", texto: (e as ErroApi).message });
    } finally {
      setOcupado(false);
      setConfirmar(null);
    }
  }

  async function apurar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    setMsg(null);
    try {
      const r = await api.post<{ boletim: Boletim }>("/admin/apurar", { frase });
      setFrase("");
      setMsg({ tipo: "ok", texto: `Apuração concluída: ${r.boletim.totalVotos} votos. Boletim publicado em Transparência.` });
      await carregar();
    } catch (err) {
      setMsg({ tipo: "erro", texto: (err as ErroApi).message });
    } finally {
      setOcupado(false);
    }
  }

  if (!painel) return <p className="carregando">{msg?.texto ?? "Carregando painel…"}</p>;
  const { eleicao } = painel;
  const etapa = ESTADOS.indexOf(eleicao.estado);

  return (
    <section className="painel">
      <h1>{eleicao.titulo}</h1>
      <p className="subtitulo">{eleicao.cargo}</p>

      <ol className="linha-estados" aria-label="Situação da eleição">
        {ESTADOS.map((s, i) => (
          <li key={s} className={i < etapa ? "feita" : i === etapa ? "atual" : ""}>{s[0].toUpperCase() + s.slice(1)}</li>
        ))}
      </ol>

      <div className="numeros-painel">
        <p><strong>{painel.comparecimento}</strong> de {painel.eleitoresAptos} eleitores votaram</p>
        <p><strong>{Math.max(painel.replicas.blocosConsenso - 1, 0)}</strong> votos na cadeia</p>
      </div>

      {msg && <p className={msg.tipo === "ok" ? "sucesso" : "erro"} role="status">{msg.texto}</p>}

      <div className="acoes-painel">
        {eleicao.estado === "preparada" && (
          confirmar === "abrir"
            ? <button className="botao primario" disabled={ocupado} onClick={() => executar("/admin/eleicao/abrir", {}, "Votação aberta.")}>Confirmar abertura</button>
            : <button className="botao primario" onClick={() => setConfirmar("abrir")}>Abrir votação</button>
        )}
        {eleicao.estado === "aberta" && (
          confirmar === "encerrar"
            ? <button className="botao perigo" disabled={ocupado} onClick={() => executar("/admin/eleicao/encerrar", {}, "Votação encerrada.")}>Confirmar encerramento (não há volta)</button>
            : <button className="botao perigo" onClick={() => setConfirmar("encerrar")}>Encerrar votação</button>
        )}
        {eleicao.estado === "encerrada" && (
          <form className="form-linha" onSubmit={apurar}>
            <label>
              Frase-senha da Junta Eleitoral
              <input type="password" value={frase} onChange={(e) => setFrase(e.target.value)} autoComplete="off" required minLength={8} />
            </label>
            <button className="botao primario" disabled={ocupado}>{ocupado ? "Apurando…" : "Apurar votos"}</button>
          </form>
        )}
        {eleicao.estado === "apurada" && <Link className="botao primario" to="/transparencia">Ver boletim publicado</Link>}
      </div>

      <h2>Réplicas do ledger</h2>
      <p className="dica">
        Cada voto é gravado em todos os nós e só é confirmado com maioria. Um nó adulterado é isolado e pode ser restaurado a
        partir da maioria íntegra — a operação fica registrada na trilha de auditoria.
      </p>
      <Replicas
        estado={painel.replicas}
        acao={(n) =>
          n.situacao !== "consenso" && painel.replicas.temConsenso ? (
            <button className="botao fantasma" disabled={ocupado} onClick={() => executar(`/admin/nos/${n.nome}/reparar`, {}, `Nó ${n.nome} restaurado a partir da maioria.`)}>
              Reparar nó
            </button>
          ) : null
        }
      />
    </section>
  );
}
