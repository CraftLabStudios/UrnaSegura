import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./estilos.css";
import { ProvedorSessao, useSessao } from "./sessao";
import { Moldura } from "./components/Moldura";
import { Entrar } from "./pages/Entrar";
import { Cabine } from "./pages/Cabine";
import { Admin } from "./pages/Admin";
import { Auditoria } from "./pages/Auditoria";
import { Dashboard } from "./pages/Dashboard";
import { Resultados } from "./pages/Resultados";
import { ConsultarComprovante } from "./pages/ConsultarComprovante";
import type { Papel } from "./api";

/** Proteção de rota no front é só conveniência de navegação: quem decide o acesso é o backend. */
function Protegida({ papeis, children }: { papeis: Papel[]; children: React.ReactNode }) {
  const { usuario, carregando } = useSessao();
  if (carregando) return null;
  if (!usuario) return <Navigate to="/" replace />;
  if (!papeis.includes(usuario.papel)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Inicio() {
  const { usuario, carregando } = useSessao();
  if (carregando) return null;
  if (!usuario) return <Entrar />;
  return <Navigate to={usuario.papel === "eleitor" ? "/cabine" : usuario.papel === "admin" ? "/admin" : "/auditoria"} replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ProvedorSessao>
        <Routes>
          <Route element={<Moldura />}>
            <Route path="/" element={<Inicio />} />
            <Route path="/cabine" element={<Protegida papeis={["eleitor"]}><Cabine /></Protegida>} />
            <Route path="/admin" element={<Protegida papeis={["admin"]}><Admin /></Protegida>} />
            <Route path="/auditoria" element={<Protegida papeis={["auditor", "admin"]}><Auditoria /></Protegida>} />
            <Route path="/painel" element={<Protegida papeis={["auditor", "admin"]}><Dashboard /></Protegida>} />
            <Route path="/resultados" element={<Resultados />} />
            <Route path="/comprovante" element={<ConsultarComprovante />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </ProvedorSessao>
    </BrowserRouter>
  </StrictMode>,
);
