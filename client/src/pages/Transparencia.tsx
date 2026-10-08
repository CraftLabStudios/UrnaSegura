import { useEffect, useState } from "react";
import { api, type Boletim } from "../api";
import { curto, jsonCanonico, sha256Hex, verificarAssinaturaHash, verificarCadeia, type Bloco, type PassoVerificacao } from "../crypto";

interface LedgerPublico {
  eleicaoId: string;
  fonte: string | null;
  hashFinalConsenso: string | null;
  nos: { nome: string; situacao: string; blocos: number; hashFinal: string | null }[];
  blocos: Bloco[];
}
interface Chaves {
  assinaturaEd25519Spki: string;
  eleicaoRsaSpki: string;
  impressaoDigitalEleicao: string;
}
interface Resultado {
  cadeiaIntegra: boolean;
  passos: PassoVerificacao[];
  hashFinal: string | null;
  boletimAssinaturaOk: boolean | null;
  boletimHashOk: boolean | null;
  boletimBateComCadeia: boolean | null;
}

export function Transparencia() {
  const [boletim, setBoletim] = useState<Boletim | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerPublico | null>(null);
  const [chaves, setChaves] = useState<Chaves | null>(null);
  const [res, setRes] = useState<Resultado | null>(null);
  const [verificando, setVerificando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ boletim: Boletim }>("/public/boletim").then((r) => setBoletim(r.boletim)).catch(() => setBoletim(null));
    api.get<{ estado: string }>("/eleicao").then((e) => setEstado(e.estado)).catch(() => undefined);
    api.get<Chaves>("/public/chaves").then(setChaves).catch((e) => setErro(e.message));
  }, []);

  async function verificar() {
    if (!chaves) return;
    setVerificando(true);
    setErro(null);
    try {
      // Baixa a cadeia inteira e refaz TODAS as contas aqui, sem confiar no servidor.
      const l = await api.get<LedgerPublico>("/public/ledger");
      setLedger(l);
      const cadeia = await verificarCadeia(l.blocos, chaves.assinaturaEd25519Spki);
      let assinaturaOk: boolean | null = null, hashOk: boolean | null = null, bate: boolean | null = null;
      if (boletim) {
        const { hash, assinatura, ...base } = boletim;
        hashOk = (await sha256Hex(jsonCanonico(base))) === hash;
        assinaturaOk = await verificarAssinaturaHash(hash, assinatura, chaves.assinaturaEd25519Spki);
        bate = cadeia.hashFinal === boletim.hashFinalLedger;
      }
      setRes({ cadeiaIntegra: cadeia.integra, passos: cadeia.passos, hashFinal: cadeia.hashFinal, boletimAssinaturaOk: assinaturaOk, boletimHashOk: hashOk, boletimBateComCadeia: bate });
    } catch (e) {
      setErro(`Não foi possível verificar: ${(e as Error).message}. O navegador precisa suportar Ed25519 na Web Crypto (Chrome 113+, Firefox 129+, Safari 17+).`);
    } finally {
      setVerificando(false);
    }
  }

  const maior = boletim ? Math.max(1, ...boletim.resultado.map((r) => r.votos)) : 1;

  return (
    <section className="painel">
      <h1>Transparência</h1>
      <p className="subtitulo">
        Qualquer pessoa pode baixar a cadeia de votos cifrados e conferir, neste navegador, se nenhum bloco foi alterado e se o
        boletim publicado corresponde exatamente a ela.
      </p>
      {erro && <p className="erro" role="alert">{erro}</p>}

      <h2>Boletim de urna</h2>
      {boletim ? (
        <div className="boletim">
          <p className="dica">{boletim.cargo}, apurado em {new Date(boletim.geradoEm).toLocaleString("pt-BR")}</p>
          <ul className="barras">
            {boletim.resultado.map((r) => (
              <li key={r.numero}>
                <span className="barra-nome"><b>{r.numero}</b> {r.nome} <small>{r.partido}</small></span>
                <span className="barra-trilho"><span className="barra" style={{ width: `${(r.votos / maior) * 100}%` }} /></span>
                <span className="barra-valor">{r.votos}</span>
              </li>
            ))}
          </ul>
          <dl className="pares">
            <dt>Brancos</dt><dd>{boletim.brancos}</dd>
            <dt>Nulos</dt><dd>{boletim.nulos}</dd>
            <dt>Comparecimento</dt><dd>{boletim.comparecimento} de {boletim.eleitoresAptos}</dd>
            <dt>Hash final da cadeia</dt><dd><code>{boletim.hashFinalLedger}</code></dd>
            <dt>Nós concordantes</dt><dd>{boletim.nosConcordantes.join(", ")}</dd>
            <dt>Assinatura do boletim</dt><dd><code>{curto(boletim.assinatura, 24)}</code></dd>
          </dl>
        </div>
      ) : (
        <p className="vazio">O boletim é publicado depois da apuração. Situação atual da eleição: <strong>{estado ?? "—"}</strong>. A cadeia já pode ser verificada abaixo.</p>
      )}

      <div className="cabecalho-secao">
        <h2>Verificação independente</h2>
        <button className="botao primario" onClick={verificar} disabled={verificando || !chaves}>
          {verificando ? "Verificando…" : "Verificar no meu navegador"}
        </button>
      </div>
      {chaves && (
        <p className="dica">
          Chave pública de assinatura (Ed25519): <code>{curto(chaves.assinaturaEd25519Spki, 20)}</code>. Impressão digital da chave da eleição: <code>{curto(chaves.impressaoDigitalEleicao, 16)}</code>
        </p>
      )}

      {res && ledger && (
        <div className="resultado-verificacao">
          <ul className="checagens">
            <li className={res.cadeiaIntegra ? "ok" : "falha"}>
              {res.cadeiaIntegra ? `Cadeia íntegra: ${res.passos.length} blocos recalculados e assinaturas válidas` : `Cadeia inválida no bloco ${res.passos.at(-1)?.seq}: ${res.passos.at(-1)?.motivo}`}
            </li>
            <li className={res.hashFinal === ledger.hashFinalConsenso ? "ok" : "falha"}>
              Hash final calculado aqui ({curto(res.hashFinal, 10)}) {res.hashFinal === ledger.hashFinalConsenso ? "confere" : "não confere"} com o consenso dos nós
            </li>
            {res.boletimHashOk !== null && (
              <>
                <li className={res.boletimHashOk && res.boletimAssinaturaOk ? "ok" : "falha"}>
                  Boletim {res.boletimHashOk && res.boletimAssinaturaOk ? "sem alterações e com assinatura válida" : "alterado ou com assinatura inválida"}
                </li>
                <li className={res.boletimBateComCadeia ? "ok" : "falha"}>
                  Hash final do boletim {res.boletimBateComCadeia ? "é o mesmo" : "é diferente"} do calculado a partir da cadeia
                </li>
              </>
            )}
          </ul>
          <p className="dica">Fonte: nó {ledger.fonte}. Situação dos nós: {ledger.nos.map((n) => `${n.nome} (${n.situacao})`).join(", ")}</p>
          <ol className="lista-blocos">
            {res.passos.map((p) => (
              <li key={p.seq} className={p.ok ? "" : "falha"}>
                <span>Bloco {p.seq}, {p.tipo === "genesis" ? "gênese" : "voto cifrado"}</span>
                <code>{curto(p.hash, 14)}</code>
                <span>{p.ok ? "válido" : p.motivo}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
