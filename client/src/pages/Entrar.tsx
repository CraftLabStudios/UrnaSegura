import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, definirCsrf, ErroApi, type DadosEleitor, type Usuario } from "../api";
import { useSessao } from "../sessao";

/**
 * Entrada:
 *   ELEITOR → botão "Entrar com gov.br" (SIMULAÇÃO: não fala com o gov.br real) → "Olá, <nome>" → cabine.
 *   EQUIPE  → usuário + senha + código do autenticador.
 */
type Etapa = "inicio" | "conectando" | "ola" | "equipe-senha" | "equipe-mfa";
type RespostaSessao = { usuario: Usuario; csrf: string; expiraEm: string };

const formatarTitulo = (t: string) => t.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3");
const iniciais = (nome: string) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

function MarcaGovBr() {
  return (
    <span className="marca-govbr" aria-label="gov.br">
      <span className="g-azul">g</span><span className="g-amarelo">o</span><span className="g-verde">v</span><span className="g-azul">.br</span>
    </span>
  );
}

export function Entrar() {
  const [etapa, setEtapa] = useState<Etapa>("inicio");
  const [eleitor, setEleitor] = useState<DadosEleitor | null>(null);
  const [sessao, setSessao] = useState<RespostaSessao | null>(null);
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const { entrar } = useSessao();
  const nav = useNavigate();

  async function entrarGovBr() {
    setErro(null);
    setEtapa("conectando");
    try {
      const [r] = await Promise.all([
        api.post<RespostaSessao & { eleitor: DadosEleitor }>("/auth/govbr"),
        esperar(900), // só para a transição "conectando ao gov.br" ser perceptível
      ]);
      setEleitor(r.eleitor);
      setSessao({ usuario: r.usuario, csrf: r.csrf, expiraEm: r.expiraEm });
      setEtapa("ola");
    } catch (e) {
      setErro((e as ErroApi).message);
      setEtapa("inicio");
    }
  }

  function irParaCabine() {
    if (!sessao) return;
    entrar(sessao.usuario, sessao.csrf, sessao.expiraEm);
    nav("/cabine");
  }

  async function naoSouEu() {
    // Encerra a sessão recém-criada sem "entrar" na interface; o servidor libera o eleitor reservado.
    if (sessao) {
      definirCsrf(sessao.csrf);
      await api.post("/auth/logout").catch(() => undefined);
      definirCsrf(null);
    }
    setSessao(null);
    setEleitor(null);
    setEtapa("inicio");
    setErro("Tudo bem: nada foi registrado. Se os dados não são seus, procure a Justiça Eleitoral.");
  }

  async function enviarSenha(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await api.post("/auth/login", { usuario: usuario.trim(), senha });
      setSenha(""); // não mantém a senha na memória da página
      setEtapa("equipe-mfa");
    } catch (err) {
      setErro((err as ErroApi).message);
    } finally {
      setEnviando(false);
    }
  }

  async function enviarCodigo(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      const r = await api.post<RespostaSessao>("/auth/mfa", { codigo });
      entrar(r.usuario, r.csrf, r.expiraEm);
      nav(r.usuario.papel === "admin" ? "/admin" : "/painel");
    } catch (err) {
      setErro((err as ErroApi).message);
      setCodigo("");
      if ((err as ErroApi).message.includes("expirada")) setEtapa("equipe-senha");
    } finally {
      setEnviando(false);
    }
  }

  const passo = etapa === "ola" ? 1 : 0;

  return (
    <section className="entrada">
      <div className="entrada-texto">
        <p className="sobretitulo">Eleições Gerais 2026 · simulação</p>
        <h1>Vote com segurança, do começo ao fim</h1>
        <p>
          Entre com sua conta <strong>gov.br</strong>, confira seus dados e vote para os cinco cargos — deputado federal,
          deputado estadual, senador (duas vagas), governador e presidente. Sua cédula é cifrada neste navegador antes de
          sair do computador: nem o servidor consegue lê-la.
        </p>
        <ol className="etapas" aria-label="Etapas">
          {["Entrar com gov.br", "Confirmar quem é você", "Votar nos 6 campos da cédula", "Receber o comprovante"].map((r, i) => (
            <li key={r} className={i < passo ? "feita" : i === passo ? "atual" : ""}>{r}</li>
          ))}
        </ol>
      </div>

      <div className="cartao formulario cartao-entrada">
        {(etapa === "inicio" || etapa === "conectando") && (
          <div className="bloco-govbr">
            <MarcaGovBr />
            <h2>Identifique-se no gov.br</h2>
            <p className="dica">Use sua conta gov.br para acessar a cabine de votação.</p>
            <button className="botao-govbr" onClick={entrarGovBr} disabled={etapa === "conectando"} autoFocus>
              {etapa === "conectando" ? (
                <><span className="giro" aria-hidden="true" /> Conectando ao gov.br…</>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <circle cx="12" cy="8" r="4" fill="currentColor" />
                    <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" />
                  </svg>
                  Entrar com <strong>gov.br</strong>
                </>
              )}
            </button>
            <p className="aviso-simulacao">Simulação acadêmica: este botão não acessa o gov.br de verdade e entrega um eleitor de teste.</p>
            {erro && <p className="erro" role="alert">{erro}</p>}
            <button type="button" className="link-equipe" onClick={() => { setErro(null); setEtapa("equipe-senha"); }}>
              Sou da equipe eleitoral (Junta / auditor)
            </button>
          </div>
        )}

        {etapa === "ola" && eleitor && (
          <div className="ola" aria-live="polite">
            <div className="ola-topo">
              <span className="ola-avatar" aria-hidden="true">{iniciais(eleitor.nome)}</span>
              <div>
                <p className="ola-saudacao">Olá,</p>
                <h2 className="ola-nome">{eleitor.nome.split(" ")[0]}!</h2>
              </div>
              <span className="selo-verificado">✓ Verificado pelo gov.br</span>
            </div>
            <dl className="ficha">
              <div><dt>Nome completo</dt><dd>{eleitor.nome}</dd></div>
              <div><dt>Título de eleitor</dt><dd className="mono">{formatarTitulo(eleitor.titulo)}</dd></div>
              <div><dt>Zona</dt><dd>{eleitor.zona ?? "—"}</dd></div>
              <div><dt>Seção</dt><dd>{eleitor.secao ?? "—"}</dd></div>
              <div className="largo"><dt>Local de votação</dt><dd>{eleitor.localVotacao ?? "—"}{eleitor.municipio ? ` — ${eleitor.municipio}/${eleitor.uf}` : ""}</dd></div>
            </dl>
            <button className="botao primario grande" onClick={irParaCabine} autoFocus>Ir para a cabine de votação →</button>
            <button className="botao fantasma" onClick={naoSouEu}>Não sou eu</button>
          </div>
        )}

        {etapa === "equipe-senha" && (
          <form onSubmit={enviarSenha} autoComplete="on">
            <h2>Acesso da equipe eleitoral</h2>
            <label>
              Usuário
              <input value={usuario} onChange={(e) => setUsuario(e.target.value)} autoComplete="username" maxLength={20} required autoFocus placeholder="admin" />
            </label>
            <label>
              Senha
              <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="current-password" maxLength={128} required />
            </label>
            {erro && <p className="erro" role="alert">{erro}</p>}
            <button className="botao primario" disabled={enviando}>{enviando ? "Verificando…" : "Continuar"}</button>
            <button type="button" className="botao fantasma" onClick={() => { setErro(null); setEtapa("inicio"); }}>Voltar</button>
          </form>
        )}

        {etapa === "equipe-mfa" && (
          <form onSubmit={enviarCodigo}>
            <h2>Código de verificação</h2>
            <label>
              Código do aplicativo autenticador
              <input
                className="codigo"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                required
                autoFocus
                placeholder="000000"
              />
            </label>
            <p className="dica">Na demonstração: <code>npm run token -- {usuario || "admin"}</code></p>
            {erro && <p className="erro" role="alert">{erro}</p>}
            <button className="botao primario" disabled={enviando || codigo.length !== 6}>{enviando ? "Conferindo…" : "Entrar"}</button>
            <button type="button" className="botao fantasma" onClick={() => setEtapa("equipe-senha")}>Voltar</button>
          </form>
        )}
      </div>
    </section>
  );
}
