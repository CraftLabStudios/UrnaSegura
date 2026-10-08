import { useCallback, useEffect, useRef, useState } from "react";
import { api, ErroApi, type Comprovante, type Eleicao } from "../api";
import { cifrarVoto, curto, type VotoCifrado } from "../crypto";
import { useSessao } from "../sessao";

type Fase = "digitando" | "cifrando" | "enviando" | "concluido";

export function Cabine() {
  const { limpar } = useSessao();
  const [eleicao, setEleicao] = useState<Eleicao | null>(null);
  const [digitos, setDigitos] = useState("");
  const [branco, setBranco] = useState(false);
  const [fase, setFase] = useState<Fase>("digitando");
  const [pacote, setPacote] = useState<VotoCifrado | null>(null);
  const [comprovante, setComprovante] = useState<Comprovante | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const votou = useRef(false);
  useEffect(() => () => {
    if (votou.current) limpar();
  }, [limpar]);

  useEffect(() => {
    api.get<Eleicao>("/eleicao").then(setEleicao).catch((e) => setErro(e.message));
  }, []);

  const candidato = eleicao?.candidatos.find((c) => c.numero === digitos);
  const completo = branco || digitos.length === 2;
  const travado = fase !== "digitando";

  const tecla = useCallback(
    (d: string) => {
      if (travado || branco) return;
      setDigitos((x) => (x.length < 2 ? x + d : x));
    },
    [travado, branco],
  );
  const corrige = useCallback(() => {
    if (travado) return;
    setDigitos("");
    setBranco(false);
    setErro(null);
  }, [travado]);

  const confirma = useCallback(async () => {
    if (!eleicao || !completo || travado) return;
    setErro(null);
    try {
      setFase("cifrando");
      // Votos para número inexistente são enviados como estão e contam como nulos na apuração.
      const voto = await cifrarVoto(branco ? "BRANCO" : digitos, eleicao.chavePublica);
      setPacote(voto);
      setFase("enviando");
      const r = await api.post<{ comprovante: Comprovante }>("/votos", voto);
      setComprovante(r.comprovante);
      setFase("concluido");
      votou.current = true; // o servidor já encerrou a sessão; a interface esquece o usuário ao sair desta tela
    } catch (err) {
      setErro((err as ErroApi).message);
      setFase("digitando");
      if ((err as ErroApi).status === 401 || (err as ErroApi).status === 409) limpar();
    }
  }, [eleicao, completo, travado, branco, digitos, limpar]);

  useEffect(() => {
    const ouvir = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) tecla(e.key);
      else if (e.key === "Backspace") corrige();
      else if (e.key === "Enter") confirma();
    };
    window.addEventListener("keydown", ouvir);
    return () => window.removeEventListener("keydown", ouvir);
  }, [tecla, corrige, confirma]);

  if (!eleicao) return <p className="carregando">{erro ?? "Carregando a cabine…"}</p>;

  if (eleicao.estado !== "aberta" && fase !== "concluido") {
    return (
      <section className="aviso-estado">
        <h1>A votação não está aberta</h1>
        <p>Situação atual: <strong>{eleicao.estado}</strong>. Aguarde a Junta Eleitoral abrir a votação.</p>
      </section>
    );
  }

  if (fase === "concluido" && comprovante) {
    return (
      <section className="fim">
        <div className="tela-fim" aria-live="polite">FIM</div>
        <div>
          <h1>Voto registrado</h1>
          <p>
            Seu voto foi cifrado neste navegador, gravado na cadeia e replicado em {comprovante.replicadoEm.length} nós
            ({comprovante.replicadoEm.join(", ")}). Sua sessão foi encerrada.
          </p>
          <div className="cartao comprovante">
            <h2>Comprovante</h2>
            <p className="dica">Guarde o código abaixo. Ele prova que seu voto está na cadeia, mas não revela em quem você votou.</p>
            <code className="hash-grande">{comprovante.hash}</code>
            <dl className="pares">
              <dt>Posição na cadeia</dt><dd>bloco {comprovante.seq}</dd>
              <dt>Carimbo de tempo</dt><dd>{new Date(comprovante.carimboTempo).toLocaleString("pt-BR")}</dd>
              <dt>Assinatura</dt><dd><code>{curto(comprovante.assinatura, 18)}</code></dd>
            </dl>
            <button className="botao fantasma" onClick={() => navigator.clipboard?.writeText(comprovante.hash)}>Copiar código</button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="cabine">
      <div className="urna">
        <div className="visor" aria-live="polite">
          <p className="visor-topo">Seu voto para</p>
          <p className="visor-cargo">{eleicao.cargo}</p>
          {branco ? (
            <p className="visor-grande">VOTO EM BRANCO</p>
          ) : (
            <>
              <div className="visor-numero">
                <span>Número:</span>
                {[0, 1].map((i) => (
                  <span key={i} className={`casa ${digitos.length === i && !travado ? "pisca" : ""}`}>{digitos[i] ?? ""}</span>
                ))}
              </div>
              {digitos.length === 2 &&
                (candidato ? (
                  <div className="visor-candidato">
                    <div className="foto" aria-hidden="true">{candidato.nome.split(" ").map((p) => p[0]).join("")}</div>
                    <div>
                      <p>Nome: <strong>{candidato.nome}</strong></p>
                      <p>Partido: {candidato.partido}</p>
                      {candidato.vice && <p>Vice: {candidato.vice}</p>}
                    </div>
                  </div>
                ) : (
                  <p className="visor-grande">NÚMERO ERRADO<br />VOTO NULO</p>
                ))}
            </>
          )}
          <div className="visor-rodape">
            {fase === "cifrando" && "Cifrando o voto neste navegador…"}
            {fase === "enviando" && "Enviando voto cifrado…"}
            {fase === "digitando" && completo && (
              <>Aperte a tecla <b>CONFIRMA</b> para confirmar este voto ou <b>CORRIGE</b> para reiniciar</>
            )}
          </div>
        </div>

        <div className="teclado" role="group" aria-label="Teclado da urna">
          <div className="numeros">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => (
              <button key={d} className={`tecla ${d === "0" ? "zero" : ""}`} onClick={() => tecla(d)} disabled={travado}>{d}</button>
            ))}
          </div>
          <div className="acoes">
            <button className="tecla-acao branco" onClick={() => !travado && !digitos && setBranco(true)} disabled={travado || !!digitos}>BRANCO</button>
            <button className="tecla-acao corrige" onClick={corrige} disabled={travado}>CORRIGE</button>
            <button className="tecla-acao confirma" onClick={confirma} disabled={travado || !completo}>CONFIRMA</button>
          </div>
        </div>
      </div>

      <aside className="bastidores">
        <h2>O que sai do seu computador</h2>
        <p>
          Ao confirmar, o navegador gera uma chave AES-256 só para este voto, cifra sua escolha com ela e envelopa a chave
          com a chave pública RSA da eleição. O servidor recebe apenas isto:
        </p>
        <pre className="pacote">
{pacote
  ? JSON.stringify({ chaveEnvelopada: curto(pacote.chaveEnvelopada, 28), iv: pacote.iv, cifrado: curto(pacote.cifrado, 28) }, null, 2)
  : "{ … aguardando confirmação … }"}
        </pre>
        <p className="dica">Impressão digital da chave da eleição: <code>{curto(eleicao.impressaoDigitalChave, 16)}</code></p>
        {erro && <p className="erro" role="alert">{erro}</p>}
      </aside>
    </section>
  );
}
