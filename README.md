# Urna Segura

Sistema de votação eletrônica para o seminário de segurança, construído a partir do fluxograma da conversa:
eleitor → autenticação → cabine → **voto cifrado no navegador** → API protegida → **ledger com hash encadeado
replicado em 3 nós** → auditoria independente → boletim público assinado.

**Stack:** React 19 + Vite (front) · Express 5 + TypeScript (API) · MongoDB · Web Crypto / Node crypto (sem bibliotecas de criptografia de terceiros).

> Simulação acadêmica. Não usar em eleições reais.

---

## Como rodar

Pré-requisitos: Node.js 22+ e um MongoDB (local, `docker compose up -d` ou Atlas).

```bash
npm install
cp .env.example .env        # ajuste MONGODB_URI se não for local
npm run seed                # cédula 2026 + 500 cédulas simuladas (APAGA os dados de demo)
npm run dev                 # API em :3001 e site em http://localhost:5173
```

Código do autenticador (2º fator) da equipe, para a demonstração:

```bash
npm run token -- admin
```

**Eleitores:** botão **"Entrar com gov.br"** (simulado) → tela *Olá, Vinicius!* com título, zona e seção → cabine. O seed cria 30 eleitores de demonstração (o primeiro é **Vinicius Teste**, título `0000 0000 0001`); cada clique entrega o próximo que ainda não votou.

| Equipe (link *Sou da equipe eleitoral*) | Papel | Senha |
|---|---|---|
| `admin` | Junta eleitoral (abre, encerra, apura, repara nós) | `Admin@2026!` |
| `auditor` | Auditor (somente leitura) | `Auditor@2026!` |

Código do autenticador da equipe: `npm run token -- admin`. Frase-senha da Junta para apurar: `junta-eleitoral-demo-2026`.
O seed também imprime URIs `otpauth://` para cadastrar no Google/Microsoft Authenticator do celular.

**Produção:** `npm run build && NODE_ENV=production npm start` — o Express serve o React compilado na mesma origem, com HTTPS obrigatório (HSTS), cookies `Secure` e `JWT_SECRET`/`DATA_KEY` exigidos. O gov.br simulado fica **desligado** em produção, a menos que `GOVBR_SIMULADO=sim`.

## Telas

| Endereço | Quem vê | Para quê |
|---|---|---|
| `/` | todos | Entrar com gov.br (eleitor) ou acesso da equipe |
| `/cabine` | eleitor | Urna com os 6 votos (CONFIRMA 2×) |
| `/resultados` | **público, sem login** | **Resultados ao vivo** (atualiza a cada 5 s): participação, cédulas por hora, integridade dos nós; após a apuração, resultado por cargo com gráficos e boletim conferido no navegador |
| `/admin` | Junta (`admin`) | Abrir, encerrar, **apurar** (frase-senha) e reparar nós |
| `/painel` | Junta e auditor | Dashboard interno: tudo da tela pública + alertas de segurança e trilha de auditoria |
| `/auditoria` | Junta e auditor | Verificar réplicas, amostragem, eventos |
| `/comprovante` | público | Consultar o comprovante do eleitor |

## Roteiro da demonstração (≈ 8 min)

0. Deixe **Resultados ao vivo** (`/resultados`) aberto num telão: ele acompanha tudo sozinho. **Painel** (`auditor` ou `admin`) → *Painel*: participação, votos por hora, saúde do ledger e segurança. O resultado fica sob sigilo até a apuração.
1. A seed já deixa a votação **aberta** com 500 cédulas simuladas (presidente proporcional ao 1º turno de 2026). Para começar do zero: `SEED_VOTOS_SIMULADOS=0 npm run seed` e então **Junta** (`admin`) → *Abrir votação*.
2. **Eleitor** → *Entrar com gov.br* → *Olá, Vinicius!* → *Ir para a cabine*. Vote nos 6 campos (ex.: `1310`, `22` para legenda de deputado estadual, `131`, `222`, ANULA, `13`), sempre com **CONFIRMA duas vezes**. Mostre “Sua cédula” e “O que sai do seu computador”: só a cédula cifrada.
3. Copie o comprovante → *Consultar comprovante*: a cédula está nos 3 nós, sem revelar o conteúdo.
4. Clique de novo em *Entrar com gov.br* → vem **outro** eleitor: quem já votou nunca é entregue de novo (voto único).
5. **Ataque:** no terminal, `npm run demo:adulterar` (troca uma cédula no banco do nó `no_tre_sp` por uma falsa).
6. **Auditor** → *Verificar réplicas*: `no_tre_sp` aparece como **Adulteração detectada**, a maioria segue em consenso. *Sortear e conferir* mostra o bloco divergente.
7. **Junta** → *Reparar nó* (restaura a partir da maioria) → *Encerrar* → *Apurar* com a frase-senha.
8. **Resultados ao vivo** e **Painel** → resultado por cargo, quem está na frente, filtros por candidato e partido; o boletim tem a assinatura conferida no navegador.

Teste automatizado: `SEED_VOTOS_SIMULADOS=0 npm run seed`, suba a API com limites altos e rode `npm run testar` — 63 verificações, incluindo os ataques e a contagem por cargo.
Atenção: com `npm run dev` os valores do `.env` prevalecem sobre variáveis do terminal; para o teste, ou ajuste `RATE_LIMIT_LOGIN=1000` e `RATE_LIMIT_VOTO=1000` no `.env`, ou suba a API direto: `cd server && RATE_LIMIT_LOGIN=1000 RATE_LIMIT_VOTO=1000 node --env-file-if-exists=../.env --import tsx src/index.ts`.
No Windows, no lugar de `cp`, use `copy .env.example .env`.

> Entenda a lógica por trás de tudo (gov.br simulado, cédula cifrada, ledger, voto único, limites de proteção): **[docs/LOGICA.md](docs/LOGICA.md)**.

Cédula de 2026: deputado federal, deputado estadual, senador (2 vagas), governador e presidente. **Presidente** com os candidatos reais do 1º turno de 2026; **demais cargos** com candidatos fictícios. `SEED_VOTOS_SIMULADOS=N` define quantas cédulas sintéticas (padrão 500). Fotos: coloque `client/public/fotos/...` e preencha `foto` em `server/src/scripts/dados-2026.ts`; sem foto, a urna desenha um retrato com as iniciais.

## Requisitos de segurança e onde estão no código

| Requisito | Como foi implementado | Arquivo |
|---|---|---|
| Entrada do eleitor (gov.br simulado) | Reserva atômica do eleitor de demonstração, nunca entrega quem já votou; desligado em produção salvo `GOVBR_SIMULADO=sim` | `routes/auth.ts` |
| Autenticação forte (MFA) | Senha (scrypt, N=2¹⁵) + TOTP RFC 6238 com anti-replay | `server/src/crypto/senha.ts`, `totp.ts`, `routes/auth.ts` |
| Sessão curta e protegida | JWT HS256 de 10 min em cookie `httpOnly`, `SameSite=Strict`, `Secure`; algoritmo fixo; revogação por `jti`; logout automático após votar | `middleware/seguranca.ts` |
| Anti-força bruta | Bloqueio da conta após 5 erros (15 min) + rate limit por IP + mensagem genérica + tempo constante | `routes/auth.ts`, `middleware/seguranca.ts` |
| CSRF | Token CSRF atrelado à sessão (HMAC do `jti`) + só aceita JSON + SameSite | `middleware/seguranca.ts` |
| Injeção (NoSQL/XSS) | Validação estrita com Zod, bloqueio de chaves `$`/`.`, CSP `script-src 'self'`, React escapa saída | `routes/*`, `app.ts` |
| Sigilo do voto | Cifrado **no navegador**: AES-256-GCM + RSA-OAEP-3072; servidor nunca vê o voto | `client/src/crypto.ts` |
| Chave da apuração protegida | Chave privada RSA cifrada com a frase da Junta (scrypt + AES-GCM), aberta só em memória na apuração | `server/src/crypto/chaves.ts` |
| Voto único | Inserção com `_id` único + troca condicional `jaVotou` (testado com 5 envios simultâneos) | `routes/votacao.ts` |
| Anonimato | Nenhum vínculo eleitor↔voto: eleitor guarda só um booleano; bloco sem identidade; carimbo truncado ao minuto; trilha não registra IP do voto | `routes/votacao.ts`, `services/ledger.ts` |
| Integridade (append-only) | Hash encadeado SHA-256 + assinatura Ed25519 por bloco; índice único em `seq`; sem rota de UPDATE/DELETE | `services/ledger.ts` |
| Redundância / tolerância a falhas | Cada bloco gravado em 3 nós, confirmado só com maioria (quórum 2); reparo a partir da maioria | `services/ledger.ts` |
| Auditoria | Trilha de eventos encadeada e assinada; perfil auditor só leitura; recontagem por amostragem | `services/auditoria.ts`, `routes/gestao.ts` |
| Verificabilidade | Comprovante do eleitor; assinatura do boletim conferida **no navegador** de qualquer pessoa em Resultados ao vivo | `pages/Resultados.tsx`, `pages/ConsultarComprovante.tsx` |
| Ciclo da eleição | Máquina de estados atômica: preparada → aberta → encerrada → apurada (sem volta) | `services/eleicao.ts` |
| Cabeçalhos HTTP | Helmet: CSP, HSTS, `frame-ancestors 'none'`, `no-referrer`, `nosniff`, sem `x-powered-by` | `app.ts` |

## Limitações conhecidas (bom para a parte de “trabalhos futuros”)

- A chave da Junta é uma única frase-senha; em produção, dividir com *Shamir Secret Sharing* entre vários membros (k de n).
- A chave de assinatura Ed25519 fica em arquivo; em produção, usar HSM/KMS.
- A fila que ordena os blocos é por processo; com várias instâncias da API, usar lock distribuído.
- Os 3 nós podem estar no mesmo servidor MongoDB por padrão; para redundância real, aponte cada `LEDGER_URI_<nó>` para um cluster diferente.
- O horário de login (na trilha) e a ordem dos blocos permitem correlação aproximada por quem tiver acesso aos dois; *mixnets* ou embaralhamento em lote eliminariam isso.
