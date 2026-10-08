import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useSessao } from "../sessao";

function Relogio({ expiraEm }: { expiraEm: string }) {
  const [agora, setAgora] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((new Date(expiraEm).getTime() - agora) / 1000));
  return (
    <span className="relogio" title="Sessão curta: expira automaticamente">
      Sessão expira em {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

export function Moldura() {
  const { usuario, expiraEm, sair } = useSessao();
  const nav = useNavigate();

  return (
    <div className="pagina">
      <header className="topo">
        <NavLink to="/" className="marca" aria-label="Urna Segura, início">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <rect x="3" y="9" width="26" height="20" rx="3" fill="currentColor" />
            <rect x="11" y="3" width="10" height="11" rx="1.5" fill="var(--cedula)" stroke="currentColor" strokeWidth="2" />
            <rect x="9" y="12" width="14" height="2.4" rx="1.2" fill="var(--cedula)" />
          </svg>
          <span>Urna Segura</span>
        </NavLink>
        <nav className="menu">
          {usuario?.papel === "eleitor" && <NavLink to="/cabine">Cabine</NavLink>}
          {usuario?.papel === "admin" && <NavLink to="/admin">Junta eleitoral</NavLink>}
          {(usuario?.papel === "auditor" || usuario?.papel === "admin") && <NavLink to="/auditoria">Auditoria</NavLink>}
          <NavLink to="/transparencia">Transparência</NavLink>
          <NavLink to="/comprovante">Consultar comprovante</NavLink>
        </nav>
        <div className="quem">
          {usuario ? (
            <>
              <span>{usuario.nome}</span>
              {expiraEm && <Relogio expiraEm={expiraEm} />}
              <button
                className="botao fantasma"
                onClick={async () => {
                  await sair();
                  nav("/");
                }}
              >
                Sair
              </button>
            </>
          ) : (
            <NavLink to="/" className="botao fantasma">Entrar</NavLink>
          )}
        </div>
      </header>
      <main className="conteudo">
        <Outlet />
      </main>
      <footer className="rodape">
        Simulação acadêmica — sistema de votação com voto cifrado no navegador, registro em cadeia de hashes assinada e
        réplicas auditáveis. Não usar em eleições reais.
      </footer>
    </div>
  );
}
