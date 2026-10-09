import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, ErroApi, type Candidato, type Cargo, type Comprovante, type Eleicao, type Partido } from "../api";
import { cifrarVoto, curto, type VotoCifrado } from "../crypto";
import { useSessao } from "../sessao";
import { Foto } from "../components/Foto";

/**
 * Cabine com a cédula completa (ordem da urna de 2026):
 *   deputado federal → deputado estadual → senador 1ª vaga → senador 2ª vaga → governador → presidente.
 * Cada cargo: digita o número (aparece foto e dados) → CONFIRMA → CONFIRMA de novo. BRANCO, ANULA e CORRIGE
 * funcionam como na urna. Só no final a cédula inteira é cifrada neste navegador e enviada de uma vez.
 */
type Fase = "votando" | "cifrando" | "enviando" | "concluido";
type Modo = "numero" | "branco" | "nulo";

interface Analise {
  completo: boolean; // pode confirmar?
  candidato?: Candidato;
  partido?: Partido;
  mensagem?: string; // VOTO NULO, VOTO DE LEGENDA...
  valor: string; // o que vai para a cédula
}

/** Mesmas regras da apuração no servidor (services/eleicao.ts), aqui só para mostrar ao eleitor o que vai acontecer. */
function analisar(cargo: Cargo, partidos: Partido[], modo: Modo, d: string, votos: Record<string, string>): Analise {
  if (modo === "branco") return { completo: true, mensagem: "VOTO EM BRANCO", valor: "BRANCO" };
  if (modo === "nulo") return { completo: true, mensagem: "VOTO NULO", valor: "NULO" };
  const partido = d.length >= 2 ? partidos.find((p) => p.numero === d.slice(0, 2)) : undefined;
  if (d.length < cargo.digitos) {
    // Deputado: 2 dígitos de um partido já valem como voto de legenda.
    if (cargo.legenda && d.length === 2 && partido) return { completo: true, partido, mensagem: "VOTO DE LEGENDA", valor: d };
    return { completo: false, partido, valor: d };
  }
  const candidato = cargo.candidatos.find((c) => c.numero === d);
  if (cargo.id === "senador_2" && d === votos.senador_1) {
    return { completo: true, candidato, mensagem: "CANDIDATO JÁ ESCOLHIDO NA 1ª VAGA — VOTO NULO", valor: d };
  }
  if (candidato) return { completo: true, candidato, partido, valor: d };
  if (cargo.legenda && partido) return { completo: true, partido, mensagem: "NÚMERO ERRADO — VOTO DE LEGENDA", valor: d };
  return { completo: true, mensagem: "NÚMERO ERRADO — VOTO NULO", valor: d };
}

/** Texto curto para o resumo da cédula. */
function descrever(cargo: Cargo, partidos: Partido[], valor: string, votos: Record<string, string>): string {
  if (valor === "BRANCO") return "Branco";
  if (valor === "NULO") return "Nulo";
  const a = analisar(cargo, partidos, "numero", valor, votos);
  if (a.candidato && !a.mensagem) return `${a.candidato.numero} · ${a.candidato.nome} (${a.candidato.partido})`;
  if (a.mensagem?.includes("LEGENDA")) return `Legenda ${a.partido?.numero} · ${a.partido?.sigla}`;
  return "Nulo";
}

export function Cabine() {
  const { limpar } = useSessao();
  const [eleicao, setEleicao] = useState<Eleicao | null>(null);
  const [idx, setIdx] = useState(0);
  const [digitos, setDigitos] = useState("");
  const [modo, setModo] = useState<Modo>("numero");
  const [segunda, setSegunda] = useState(false); // já apertou CONFIRMA uma vez?
  const [votos, setVotos] = useState<Record<string, string>>({});
  const [registrado, setRegistrado] = useState<string | null>(null); // flash "voto registrado"
  const [fase, setFase] = useState<Fase>("votando");
  const [pacote, setPacote] = useState<VotoCifrado | null>(null);
  const [comprovante, setComprovante] = useState<Comprovante | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const visorRef = useRef<HTMLDivElement>(null);

  const votou = useRef(false);
  useEffect(() => () => {
    if (votou.current) limpar();
  }, [limpar]);

  useEffect(() => {
    api.get<Eleicao>("/eleicao").then(setEleicao).catch((e) => setErro(e.message));
  }, []);
  useEffect(() => visorRef.current?.focus(), [eleicao, idx]);

  const cargo = eleicao?.cargos[idx];
  const analise = cargo && eleicao ? analisar(cargo, eleicao.partidos, modo, digitos, votos) : null;
  const travado = fase !== "votando" || !!registrado;

  const tecla = useCallback(
    (d: string) => {
      if (travado || !cargo || modo !== "numero" || segunda) return;
      setDigitos((x) => (x.length < cargo.digitos ? x + d : x));
    },
    [travado, cargo, modo, segunda],
  );

  const corrige = useCallback(() => {
    if (travado) return;
    setDigitos("");
    setModo("numero");
    setSegunda(false);
    setErro(null);
  }, [travado]);

  const branco = useCallback(() => {
    if (travado || digitos) return;
    setModo("branco");
    setSegunda(false);
  }, [travado, digitos]);

  const anula = useCallback(() => {
    if (travado) return;
    setDigitos("");
    setModo("nulo");
    setSegunda(false);
  }, [travado]);

  const enviar = useCallback(
    async (cedula: Record<string, string>) => {
      if (!eleicao) return;
      setErro(null);
      try {
        setFase("cifrando");
        const pacoteCifrado = await cifrarVoto(cedula, eleicao.chavePublica);
        setPacote(pacoteCifrado);
        setFase("enviando");
        const r = await api.post<{ comprovante: Comprovante }>("/votos", pacoteCifrado);
        setComprovante(r.comprovante);
        setFase("concluido");
        votou.current = true; // o servidor já encerrou a sessão; a interface esquece o usuário ao sair desta tela
      } catch (err) {
        setErro((err as ErroApi).message);
        setFase("votando");
        if ((err as ErroApi).status === 401 || (err as ErroApi).status === 409) limpar();
      }
    },
    [eleicao, limpar],
  );

  const confirma = useCallback(() => {
    if (travado || !eleicao || !cargo || !analise?.completo) return;
    if (!segunda) {
      setSegunda(true); // 1ª vez: pede confirmação
      return;
    }
    // 2ª vez: registra este cargo e passa para o próximo.
    const cedula = { ...votos, [cargo.id]: analise.valor };
    setVotos(cedula);
    setRegistrado(cargo.nome);
    setTimeout(() => {
      setRegistrado(null);
      setDigitos("");
      setModo("numero");
      setSegunda(false);
      if (idx + 1 < eleicao.cargos.length) setIdx(idx + 1);
      else enviar(cedula);
    }, 650);
  }, [travado, eleicao, cargo, analise, segunda, votos, idx, enviar]);

  useEffect(() => {
    const ouvir = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(e.key)) tecla(e.key);
      else if (e.key === "Backspace" || e.key === "Escape") corrige();
      else if (e.key === "Enter") { e.preventDefault(); confirma(); }
      else if (e.key.toLowerCase() === "b") branco();
      else if (e.key.toLowerCase() === "n") anula();
    };
    window.addEventListener("keydown", ouvir);
    return () => window.removeEventListener("keydown", ouvir);
  }, [tecla, corrige, confirma, branco, anula]);

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
            Sua cédula com os {eleicao.cargos.length} votos foi cifrada neste navegador, gravada na cadeia e replicada em{" "}
            {comprovante.replicadoEm.length} nós ({comprovante.replicadoEm.join(", ")}). Sua sessão foi encerrada.
          </p>
          <div className="cartao comprovante">
            <h2>Comprovante</h2>
            <p className="dica">Guarde o código abaixo. Ele prova que sua cédula está na cadeia, mas não revela em quem você votou.</p>
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

  const c = cargo!;
  const a = analise!;
  const finalizando = fase === "cifrando" || fase === "enviando";

  return (
    <section className="cabine-completa">
      <ol className="progresso-cargos" aria-label="Cargos da cédula">
        {eleicao.cargos.map((x, i) => (
          <li key={x.id} className={i < idx || votos[x.id] !== undefined ? "feito" : i === idx ? "atual" : ""} aria-current={i === idx ? "step" : undefined}>
            <span className="bolinha">{votos[x.id] !== undefined ? "✓" : i + 1}</span>
            <span className="rotulo-cargo">{x.nome}</span>
          </li>
        ))}
      </ol>

      <div className="cabine">
        <div className="urna">
          <div className={`visor ${segunda ? "aguardando" : ""}`} ref={visorRef} tabIndex={-1} aria-live="polite" aria-label={`Votação para ${c.nome}`}>
            {finalizando ? (
              <div className="visor-centro">
                <span className="giro escuro" aria-hidden="true" />
                <p className="visor-grande">{fase === "cifrando" ? "CIFRANDO SUA CÉDULA…" : "GRAVANDO…"}</p>
              </div>
            ) : registrado ? (
              <div className="visor-centro">
                <p className="visor-ok">✓</p>
                <p className="visor-grande pequeno">Voto para {registrado} registrado</p>
              </div>
            ) : (
              <>
                <div className="visor-cabecalho">
                  <p className="visor-topo">SEU VOTO PARA</p>
                  <p className="visor-contador">{idx + 1} de {eleicao.cargos.length}</p>
                </div>
                <p className="visor-cargo">{c.nome}</p>

                <div className="visor-corpo">
                  <div className="visor-dados">
                    {modo === "numero" && (
                      <div className="visor-numero">
                        <span>Número:</span>
                        {Array.from({ length: c.digitos }, (_, i) => (
                          <span key={i} className={`casa ${digitos.length === i && !segunda ? "pisca" : ""}`}>{digitos[i] ?? ""}</span>
                        ))}
                      </div>
                    )}
                    {a.candidato && !a.mensagem?.includes("NULO") && (
                      <dl className="visor-info">
                        <dt>Nome:</dt><dd><strong>{a.candidato.nome}</strong></dd>
                        <dt>Partido:</dt><dd>{a.candidato.partido}</dd>
                        {a.candidato.vice && <><dt>Vice:</dt><dd>{a.candidato.vice}</dd></>}
                        {a.candidato.suplentes?.map((s, i) => <Fragment key={i}><dt>{i + 1}º Suplente:</dt><dd>{s}</dd></Fragment>)}
                      </dl>
                    )}
                    {!a.candidato && a.partido && modo === "numero" && (
                      <dl className="visor-info"><dt>Partido:</dt><dd><strong>{a.partido.sigla}</strong></dd></dl>
                    )}
                    {a.mensagem && <p className={`visor-grande ${a.mensagem.includes("NULO") ? "nulo" : ""}`}>{a.mensagem}</p>}
                  </div>
                  {a.candidato && !a.mensagem?.includes("NULO") && <Foto candidato={a.candidato} />}
                </div>

                <div className="visor-rodape">
                  {a.completo && !segunda && (
                    <p>Aperte a tecla:<br /><b className="v">CONFIRMA</b> para CONFIRMAR este voto<br /><b className="l">CORRIGE</b> para REINICIAR este voto</p>
                  )}
                  {a.completo && segunda && (
                    <p className="confirme-de-novo">Tem certeza? Aperte <b className="v">CONFIRMA</b> de novo para registrar seu voto para {c.nome}.</p>
                  )}
                  {!a.completo && modo === "numero" && <p className="dica-visor">Digite o número do candidato ({c.digitos} dígitos){c.legenda ? " ou os 2 dígitos do partido" : ""}.</p>}
                </div>
              </>
            )}
          </div>

          <div className="teclado" role="group" aria-label="Teclado da urna">
            <div className="numeros">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => (
                <button key={d} className={`tecla ${d === "0" ? "zero" : ""}`} onClick={() => tecla(d)} disabled={travado || modo !== "numero" || segunda}>{d}</button>
              ))}
            </div>
            <div className="acoes">
              <button className="tecla-acao branco" onClick={branco} disabled={travado || !!digitos || modo !== "numero"}>BRANCO</button>
              <button className="tecla-acao anula" onClick={anula} disabled={travado || modo === "nulo"}>ANULA</button>
              <button className="tecla-acao corrige" onClick={corrige} disabled={travado}>CORRIGE</button>
              <button className={`tecla-acao confirma ${segunda ? "pulsa" : ""}`} onClick={confirma} disabled={travado || !a.completo}>CONFIRMA</button>
            </div>
            <p className="atalhos">Teclado: números · Enter = CONFIRMA · Backspace = CORRIGE · B = BRANCO · N = ANULA</p>
          </div>
        </div>

        <aside className="bastidores">
          <h2>Sua cédula</h2>
          <ul className="resumo-cedula">
            {eleicao.cargos.map((x) => (
              <li key={x.id} className={votos[x.id] !== undefined ? "ok" : ""}>
                <span>{x.nome}</span>
                <strong>{votos[x.id] !== undefined ? descrever(x, eleicao.partidos, votos[x.id], votos) : "—"}</strong>
              </li>
            ))}
          </ul>
          <h2>O que sai do seu computador</h2>
          <p className="dica">
            Ao final, o navegador cifra a cédula inteira com uma chave AES-256 nova e envelopa essa chave com a chave pública
            RSA da eleição. O servidor recebe apenas isto:
          </p>
          <pre className="pacote">
{pacote
  ? JSON.stringify({ chaveEnvelopada: curto(pacote.chaveEnvelopada, 28), iv: pacote.iv, cifrado: curto(pacote.cifrado, 28) }, null, 2)
  : "{ … aguardando o último CONFIRMA … }"}
          </pre>
          <p className="dica">Presidente: candidatos reais de 2026. Demais cargos: candidatos fictícios da simulação.</p>
          {erro && <p className="erro" role="alert">{erro}</p>}
        </aside>
      </div>
    </section>
  );
}
