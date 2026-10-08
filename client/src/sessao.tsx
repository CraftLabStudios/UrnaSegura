import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, definirCsrf, type Usuario } from "./api";

interface Ctx {
  usuario: Usuario | null;
  expiraEm: string | null;
  carregando: boolean;
  entrar: (u: Usuario, csrf: string, expiraEm: string) => void;
  sair: () => Promise<void>;
  limpar: () => void;
}

const SessaoCtx = createContext<Ctx>(null!);
export const useSessao = () => useContext(SessaoCtx);

export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [expiraEm, setExpiraEm] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const limpar = useCallback(() => {
    definirCsrf(null);
    setUsuario(null);
    setExpiraEm(null);
  }, []);

  useEffect(() => {
    api
      .get<{ usuario: Usuario; csrf: string; expiraEm: string }>("/auth/me")
      .then((r) => {
        definirCsrf(r.csrf);
        setUsuario(r.usuario);
        setExpiraEm(r.expiraEm);
      })
      .catch(() => undefined)
      .finally(() => setCarregando(false));
  }, []);

  // Sessão curta: ao expirar, a interface também esquece o usuário.
  useEffect(() => {
    if (!expiraEm) return;
    const ms = new Date(expiraEm).getTime() - Date.now();
    const t = setTimeout(limpar, Math.max(ms, 0));
    return () => clearTimeout(t);
  }, [expiraEm, limpar]);

  const entrar = (u: Usuario, csrf: string, exp: string) => {
    definirCsrf(csrf);
    setUsuario(u);
    setExpiraEm(exp);
  };
  const sair = async () => {
    await api.post("/auth/logout").catch(() => undefined);
    limpar();
  };

  return <SessaoCtx.Provider value={{ usuario, expiraEm, carregando, entrar, sair, limpar }}>{children}</SessaoCtx.Provider>;
}
