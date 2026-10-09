import { useState } from "react";
import type { Candidato } from "../api";

/** Cores por partido (estáveis: o mesmo partido sempre tem a mesma cor). */
const PALETA = ["#1d3f6e", "#8a2432", "#2f6b3a", "#6b3f8a", "#a35a12", "#0f6d73", "#7a5a1e", "#3d4f9b", "#9b3d6b", "#4a6b1f"];
const corDo = (texto: string) => PALETA[[...texto].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETA.length];

/**
 * Foto do candidato na urna. Se o candidato tiver `foto` (ex.: /fotos/presidente-13.jpg em client/public),
 * mostra a imagem; senão (ou se ela falhar) desenha um retrato com as iniciais na cor do partido.
 */
export function Foto({ candidato, tamanho = "grande" }: { candidato: Candidato; tamanho?: "grande" | "pequena" }) {
  const [falhou, setFalhou] = useState(false);
  const classe = `foto-candidato ${tamanho}`;
  if (candidato.foto && !falhou) {
    return <img className={classe} src={candidato.foto} alt={`Foto de ${candidato.nome}`} onError={() => setFalhou(true)} />;
  }
  const iniciais = candidato.nome.split(/\s+/).filter((p) => p.length > 2 || /^[A-ZÁ-Ú]/.test(p)).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  const cor = corDo(candidato.partido);
  return (
    <svg className={classe} viewBox="0 0 120 150" role="img" aria-label={`Retrato de ${candidato.nome}`}>
      <rect width="120" height="150" fill="#e9ecef" />
      <rect width="120" height="150" fill={cor} opacity="0.14" />
      <circle cx="60" cy="58" r="30" fill={cor} opacity="0.85" />
      <path d="M14 150c4-30 22-46 46-46s42 16 46 46z" fill={cor} />
      <text x="60" y="67" textAnchor="middle" className="foto-iniciais">{iniciais}</text>
    </svg>
  );
}
