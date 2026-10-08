import { useState, type FormEvent } from "react";
import { api, ErroApi } from "../api";

interface Resposta {
  hash: string;
  encontrado: boolean;
  nos: { no: string; presente: boolean; assinaturaValida: boolean; seq: number | null; carimboTempo: string | null }[];
}

export function ConsultarComprovante() {
  const [hash, setHash] = useState("");
  const [r, setR] = useState<Resposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function consultar(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setR(null);
    try {
      setR(await api.get<Resposta>(`/public/comprovante/${hash.trim().toLowerCase()}`));
    } catch (err) {
      setErro((err as ErroApi).status === 400 ? "O código deve ter 64 caracteres hexadecimais (0-9, a-f)." : (err as ErroApi).message);
    }
  }

  return (
    <section className="painel estreito">
      <h1>Consultar comprovante</h1>
      <p className="subtitulo">
        Cole o código recebido ao votar para confirmar que seu voto está na cadeia, em quais nós ele foi replicado e se a
        assinatura confere. A consulta não revela o conteúdo do voto.
      </p>
      <form className="form-linha" onSubmit={consultar}>
        <label className="cresce">
          Código do comprovante
          <input value={hash} onChange={(e) => setHash(e.target.value)} maxLength={64} spellCheck={false} required className="mono" />
        </label>
        <button className="botao primario">Consultar</button>
      </form>
      {erro && <p className="erro" role="alert">{erro}</p>}
      {r && (
        <>
          <p className={r.encontrado ? "sucesso" : "erro"}>
            {r.encontrado ? "Voto encontrado na cadeia." : "Nenhum bloco válido com este código foi encontrado."}
          </p>
          <ul className="checagens">
            {r.nos.map((n) => (
              <li key={n.no} className={n.presente && n.assinaturaValida ? "ok" : "falha"}>
                {n.no}: {n.presente ? (n.assinaturaValida ? `presente no bloco ${n.seq}, assinatura válida` : "presente, mas com assinatura inválida") : "não encontrado"}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
