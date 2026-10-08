import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ErroApi, type Usuario } from "../api";
import { useSessao } from "../sessao";

export function Entrar() {
  const [etapa, setEtapa] = useState<"senha" | "mfa">("senha");
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const { entrar } = useSessao();
  const nav = useNavigate();

  async function enviarSenha(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await api.post("/auth/login", { usuario: usuario.trim(), senha });
      setSenha(""); // não mantém a senha na memória da página
      setEtapa("mfa");
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
      const r = await api.post<{ usuario: Usuario; csrf: string; expiraEm: string }>("/auth/mfa", { codigo });
      entrar(r.usuario, r.csrf, r.expiraEm);
      nav(r.usuario.papel === "eleitor" ? "/cabine" : r.usuario.papel === "admin" ? "/admin" : "/auditoria");
    } catch (err) {
      setErro((err as ErroApi).message);
      setCodigo("");
      if ((err as ErroApi).status === 401 && (err as ErroApi).message.includes("expirada")) setEtapa("senha");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="entrada">
      <div className="entrada-texto">
        <h1>Identifique-se para votar</h1>
        <p>
          A identificação tem duas etapas: sua senha e um código de 6 dígitos do aplicativo autenticador. O seu voto é
          cifrado neste navegador antes de ser enviado — nem o servidor consegue lê-lo.
        </p>
        <ol className="etapas" aria-label="Etapas de identificação">
          <li className={etapa === "senha" ? "atual" : "feita"}>Título e senha</li>
          <li className={etapa === "mfa" ? "atual" : ""}>Código do autenticador</li>
          <li>Cabine de votação</li>
        </ol>
      </div>

      <div className="cartao formulario">
        {etapa === "senha" ? (
          <form onSubmit={enviarSenha} autoComplete="on">
            <label>
              Título de eleitor ou usuário
              <input
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
                autoComplete="username"
                inputMode="text"
                maxLength={20}
                required
                autoFocus
                placeholder="000000000001"
              />
            </label>
            <label>
              Senha
              <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="current-password" maxLength={128} required />
            </label>
            {erro && <p className="erro" role="alert">{erro}</p>}
            <button className="botao primario" disabled={enviando}>{enviando ? "Verificando…" : "Continuar"}</button>
          </form>
        ) : (
          <form onSubmit={enviarCodigo}>
            <label>
              Código de verificação
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
            <p className="dica">Abra o aplicativo autenticador. Na demonstração: <code>npm run token -- {usuario || "000000000001"}</code></p>
            {erro && <p className="erro" role="alert">{erro}</p>}
            <button className="botao primario" disabled={enviando || codigo.length !== 6}>{enviando ? "Conferindo…" : "Entrar"}</button>
            <button type="button" className="botao fantasma" onClick={() => setEtapa("senha")}>Voltar</button>
          </form>
        )}
      </div>
    </section>
  );
}
