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
npm run seed                # cria usuários, chave da eleição e bloco gênese (APAGA os dados de demo)
npm run dev                 # API em :3001 e site em http://localhost:5173
```

Código do autenticador (2º fator) de qualquer usuário, para a demonstração:

```bash
npm run token -- 000000000001
```

| Usuário | Papel | Senha |
|---|---|---|
| `admin` | Junta eleitoral (abre, encerra, apura, repara nós) | `Admin@2026!` |
| `auditor` | Auditor (somente leitura) | `Auditor@2026!` |
| `000000000001` … `000000000010` | Eleitores | `Eleitor@2026` |

Frase-senha da Junta para apurar: `junta-eleitoral-demo-2026`.
O seed também imprime URIs `otpauth://` para cadastrar no Google/Microsoft Authenticator do celular.

**Produção:** `npm run build && NODE_ENV=production npm start` — o Express serve o React compilado na mesma origem, com HTTPS obrigatório (HSTS), cookies `Secure` e `JWT_SECRET`/`DATA_KEY` exigidos.

## Roteiro da demonstração (≈ 8 min)

1. **Junta** (`admin`) → *Abrir votação*.
2. **Eleitor** entra (senha + código) → digita `10` → *CONFIRMA*. Mostre o painel “O que sai do seu computador”: só o voto cifrado.
3. Copie o comprovante → *Consultar comprovante*: o voto está nos 3 nós, sem revelar o conteúdo.
4. Tente entrar de novo com o mesmo eleitor → bloqueado (voto único).
5. **Ataque:** no terminal, `npm run demo:adulterar` (troca um voto no banco do nó `no_tre_sp` por um voto falso para o 77).
6. **Auditor** → *Verificar réplicas*: `no_tre_sp` aparece como **Adulteração detectada**, a maioria segue em consenso. *Sortear e conferir* mostra o bloco divergente.
7. **Junta** → *Reparar nó* (restaura a partir da maioria) → *Encerrar* → *Apurar* com a frase-senha.
8. **Transparência** (sem login) → *Verificar no meu navegador*: recalcula toda a cadeia e confere a assinatura do boletim.

Teste automatizado (com o servidor rodando e após `npm run seed`; use limites altos para o teste):
`RATE_LIMIT_LOGIN=1000 RATE_LIMIT_VOTO=1000 npm run dev` e, em outro terminal, `npm run testar` — 47 verificações, incluindo os ataques.
No PowerShell: `$env:RATE_LIMIT_LOGIN=1000; $env:RATE_LIMIT_VOTO=1000; npm run dev` (ou ajuste os valores no `.env`); no lugar de `cp`, use `copy .env.example .env`.

## Requisitos de segurança e onde estão no código

| Requisito | Como foi implementado | Arquivo |
|---|---|---|
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
| Verificabilidade | Comprovante do eleitor; verificação da cadeia e do boletim **no navegador** de qualquer pessoa | `pages/Transparencia.tsx`, `pages/ConsultarComprovante.tsx` |
| Ciclo da eleição | Máquina de estados atômica: preparada → aberta → encerrada → apurada (sem volta) | `services/eleicao.ts` |
| Cabeçalhos HTTP | Helmet: CSP, HSTS, `frame-ancestors 'none'`, `no-referrer`, `nosniff`, sem `x-powered-by` | `app.ts` |

## Limitações conhecidas (bom para a parte de “trabalhos futuros”)

- A chave da Junta é uma única frase-senha; em produção, dividir com *Shamir Secret Sharing* entre vários membros (k de n).
- A chave de assinatura Ed25519 fica em arquivo; em produção, usar HSM/KMS.
- A fila que ordena os blocos é por processo; com várias instâncias da API, usar lock distribuído.
- Os 3 nós podem estar no mesmo servidor MongoDB por padrão; para redundância real, aponte cada `LEDGER_URI_<nó>` para um cluster diferente.
- O horário de login (na trilha) e a ordem dos blocos permitem correlação aproximada por quem tiver acesso aos dois; *mixnets* ou embaralhamento em lote eliminariam isso.
