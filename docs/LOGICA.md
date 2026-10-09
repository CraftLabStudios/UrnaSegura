# Como a Urna Segura funciona (a lógica por trás)

O sistema resolve um problema difícil: **provar que cada voto foi contado, sem mostrar em quem cada pessoa votou**.
Para isso, ele separa *quem votou* de *o que foi votado* e protege cada lado com uma técnica diferente.

## 1. O caminho de um voto

```
Eleitor ──gov.br (simulado)──► Sessão (cookie) ──► Cabine
                                                  │ digita os 6 votos (CONFIRMA 2×)
                                                  ▼
                              NAVEGADOR cifra a cédula (AES-256-GCM + RSA-3072)
                                                  │ só o texto cifrado viaja
                                                  ▼
                       API: confere sessão, CSRF, formato, "já votou?"
                                                  │
                    ┌─────────────────────────────┴───────────────────────┐
                    ▼                                                      ▼
        marca "compareceu" (booleano)                  grava bloco no LEDGER em 3 nós
        (sem horário, sem ligação com o bloco)          (hash encadeado + assinatura)
                                                  │
                                                  ▼
                              comprovante (hash do bloco) ──► eleitor confere depois
```

**Ponto-chave:** o registro "este eleitor votou" (`jaVotou = true`) e o registro "este voto existe" (bloco no ledger)
**não têm nenhum campo em comum**. Quem rouba o banco de usuários não descobre votos; quem rouba o ledger não descobre eleitores.

## 2. Entrada do eleitor: "Entrar com gov.br" (simulado)

```
[Entrar com gov.br] ─► "Olá, Vinicius!" (nome, título, zona, seção, local) ─► Cabine (6 votos) ─► FIM + comprovante
```

- **Na vida real** o gov.br faria a autenticação forte (senha + 2 fatores, selo prata/ouro) via OAuth/OpenID Connect e devolveria ao sistema *quem* é a pessoa. Aqui o botão **simula** isso: o servidor entrega o próximo **eleitor de demonstração** que ainda não votou (o seed cria 30, a começar por "Vinicius Teste", título `0000 0000 0001`).
- **Reserva atômica:** o eleitor entregue fica reservado pelo tempo da sessão (`findOneAndUpdate` com filtro), então dois cliques ao mesmo tempo nunca recebem a mesma pessoa. *Não sou eu* ou *Sair* devolvem a reserva.
- **Quem já votou nunca é entregue de novo** (filtro `jaVotou: false`), e o voto único continua garantido no banco (seção 4).
- **Liga/desliga:** `GOVBR_SIMULADO` — ligado por padrão em desenvolvimento, **desligado em produção** (lá exige `GOVBR_SIMULADO=sim` explícito). Isso evita que um servidor publicado por engano deixe qualquer visitante votar.
- **Ponto honesto para a apresentação:** com o gov.br simulado, *quem clica vota* — a força da autenticação do eleitor fica por conta do gov.br real. A equipe (Junta e auditores) continua com autenticação forte de verdade, descrita abaixo.

## 2b. Autenticação da equipe: duas coisas, não uma

| Fator | O que é | Onde está no código |
|---|---|---|
| Algo que você **sabe** | Senha, guardada só como hash **scrypt** (lento e caro de propósito, para tornar força bruta inviável) | `crypto/senha.ts` |
| Algo que você **tem** | Código **TOTP** de 6 dígitos do celular (mesmo algoritmo do Google Authenticator), válido por 30 s e **uma vez só** | `crypto/totp.ts` |

Detalhes que fecham brechas:

- A mensagem de erro é sempre a mesma (“usuário ou senha incorretos”) e o tempo de resposta também (`verificarSenhaFicticia`), para ninguém descobrir quais títulos existem.
- 5 erros bloqueiam a conta por 15 min; há ainda limite por IP.
- Cada código TOTP usado é gravado (`ultimoPassoTotp`): copiar o código de alguém e reusá-lo não funciona (*anti-replay*).
- A sessão é um **JWT de 10 min** num cookie `httpOnly` (JavaScript da página não lê), `SameSite=Strict` e `Secure` em produção. O algoritmo é fixo em HS256 (impede o ataque `alg: none`).
- Logout e voto **revogam** o token (`sessoes_revogadas`). A cada requisição o servidor também confere no banco se a conta ainda existe e se o papel continua o mesmo.

## 3. A cédula e o sigilo do voto

A urna segue a ordem de 2026: **deputado federal (4 dígitos) → deputado estadual (5) → senador 1ª vaga (3) → senador 2ª vaga (3) → governador (2) → presidente (2)**. Em cada cargo: digita o número → aparece **foto**, nome, partido, vice/suplentes → **CONFIRMA** → **CONFIRMA de novo**. BRANCO, ANULA e CORRIGE funcionam a qualquer momento antes da 2ª confirmação.

| O que o eleitor faz | Como é contado (`services/eleicao.ts → classificar`) |
|---|---|
| Número de candidato existente | voto no candidato |
| Deputado: só os 2 dígitos do partido, ou número inexistente que começa com um partido | **voto de legenda** (vai para o partido) |
| BRANCO | branco |
| ANULA, número inexistente, cargo faltando | nulo |
| Mesmo senador nas duas vagas | a 2ª vaga vira **nulo** |

A tela mostra exatamente essas regras antes de confirmar (a mesma lógica existe no navegador só para exibição — quem conta é o servidor).

**Uma cédula = um envio = um bloco.** Os 6 votos ficam só na memória da página até o último CONFIRMA; então:

1. O navegador gera uma chave **AES-256 nova só para aquela cédula** e cifra `{votos: {...6 cargos}, nonce}` com AES-GCM.
2. Cifra essa chave AES com a **chave pública RSA da eleição** (RSA-OAEP).
3. Envia `{chaveEnvelopada, iv, cifrado}`. O servidor valida só o *formato* (tamanhos exatos) — não tem como ler.
4. O `nonce` aleatório garante que dois votos iguais produzam textos cifrados diferentes (ninguém compara blocos para adivinhar).
5. A **chave privada** nasceu junto com a eleição, mas ficou **cifrada com a frase-senha da Junta** (scrypt + AES-GCM). Só na apuração ela é aberta, **na memória**, e descartada.

Consequência prática: nem o administrador do servidor consegue ver votos parciais. Por isso o dashboard **não mostra placar antes da apuração**.

## 4. Voto único (mesmo com 5 cliques simultâneos)

Duas barreiras no banco, que são atômicas (não dependem do código “ter chegado primeiro”):

1. `comparecimentos.insertOne({ _id: título })` — o `_id` é único; o segundo insert falha com erro 11000.
2. `findOneAndUpdate({ _id, jaVotou: false }, { $set: { jaVotou: true } })` — só uma requisição consegue virar o booleano.

Se o ledger não confirmar o voto (sem quórum), o sistema **desfaz** a marcação, e o eleitor pode tentar de novo.
O teste `npm run testar` dispara 5 envios simultâneos e exige exatamente 1 aceito.

## 5. O ledger: uma “blockchain simplificada”

Cada voto vira um **bloco**:

```
seq · hashAnterior · carimbo (minuto) · hashConteudo · hash = SHA-256(tudo isso) · assinatura Ed25519(hash)
```

- **Encadeado:** o bloco *n* contém o hash do bloco *n−1*. Mudar um voto antigo muda seu hash e quebra todos os seguintes.
- **Assinado:** o servidor assina cada hash com Ed25519; adulterar e recalcular o hash não basta, falta a chave privada.
- **Append-only:** o código só tem `INSERT`. Não existe rota para editar ou apagar voto, e há índice único em `(eleicao, seq)`.
- **Replicado:** o bloco vai para 3 nós; só vale com **maioria (2 de 3)**. Se não houver quórum, o voto não é aceito.
- **Fila serial:** garante que dois votos simultâneos não recebam o mesmo `seq`.
- **Sem identidade:** o carimbo é truncado ao minuto, o evento “voto registrado” não grava IP, e o bloco não contém nada do eleitor.

### Como uma adulteração é detectada

`estadoReplicas` recalcula hash e assinatura de cada bloco em cada nó e compara os hashes finais:

| Situação | Significa |
|---|---|
| `consenso` | Íntegro e igual à maioria |
| `corrompido` | Algum bloco não confere (conteúdo, elo ou assinatura) |
| `atrasado` | Íntegro, mas com menos blocos que a maioria |
| `divergente` | Íntegro, mas com cadeia diferente da maioria |
| `indisponivel` | Banco inacessível |

A Junta pode **reparar** um nó: ele é refeito a partir da maioria, e a operação fica na trilha de auditoria.

## 6. Ciclo da eleição e apuração

`preparada → aberta → encerrada → apurada`, sem volta. A troca usa um filtro pelo estado atual, então é atômica.

A apuração só roda se: (1) os nós estiverem em consenso; (2) o bloco gênese bater com candidatos e chave; (3) nº de votos no ledger == nº de eleitores que votaram; (4) a frase da Junta abrir a chave.
Votos ilegíveis ou com opção inexistente contam como **nulos** (e não derrubam a contagem). O resultado vira um **boletim assinado**, com o hash final da cadeia — qualquer pessoa vê em *Resultados ao vivo*, que confere a assinatura no próprio navegador.

## 7. Trilha de auditoria

Eventos de segurança (login falho, CSRF barrado, voto duplicado, apuração, reparo…) ficam numa cadeia própria, também encadeada e assinada. O dashboard conta esses eventos e **revalida a cadeia inteira** a cada atualização.

## 8. Camadas de proteção da aplicação

| Ameaça | Defesa | Onde |
|---|---|---|
| Roubo de sessão por XSS | Cookie `httpOnly` + CSP `script-src 'self'` + React escapa a saída | `app.ts`, `middleware/seguranca.ts` |
| CSRF (site malicioso dispara ação) | `SameSite=Strict` + token atrelado à sessão + só aceita JSON | `middleware/seguranca.ts` |
| NoSQL injection (`{"$ne": ""}`) | Zod `.strict()` + bloqueio de chaves com `$` ou `.` | `middleware/seguranca.ts` |
| Força bruta / enumeração | Bloqueio de conta, rate limit por IP, erro e tempo iguais | `routes/auth.ts` |
| Inundação da trilha | RATE_LIMIT registrado no máx. 1× por IP por janela | `middleware/seguranca.ts` |
| Chute da frase da Junta | Máx. 5 tentativas/15 min por IP, só admin, scrypt caro | `limiteApuracao` |
| Privilégio indevido | Autorização **sempre no backend** (`exigir(papel)`); o front só esconde menus | `routes/*.ts` |
| Segredos fracos | `JWT_SECRET` ≥ 32 chars e `DATA_KEY` de 64 hex validados; aviso se usar os de desenvolvimento | `config.ts` |
| Apagar dados por engano | O seed recusa `NODE_ENV=production` e qualquer MongoDB não-local | `scripts/seed.ts` |
| Clickjacking / MIME / referrer | Helmet: `frame-ancestors 'none'`, `nosniff`, `no-referrer`, HSTS | `app.ts` |

## 9. O que ainda NÃO está protegido (e deve ser dito na apresentação)

- **Computador do eleitor infectado:** se um malware controla o navegador, ele pode trocar o voto *antes* de cifrar. O comprovante prova que “um voto foi registrado”, não que “foi o que você digitou”.
- **Frase única da Junta:** quem a obtiver, com acesso ao banco, abre todos os votos. Em produção: dividir em partes (*Shamir*, k de n).
- **Chave de assinatura em arquivo:** em produção, HSM/KMS.
- **Bloqueio de conta pode virar negação de serviço:** alguém que erre a senha de um título 5× o bloqueia por 15 min (troca consciente: segurança contra força bruta × disponibilidade).
- **Correlação por tempo:** a ordem dos blocos e o horário de login permitem correlação aproximada por quem vê os dois; *mixnets* resolveriam.
- **Cenário real exige** HTTPS, WAF, backups cifrados, nós em organizações distintas e auditoria externa — e este projeto é uma **simulação acadêmica**.

## 10. Sobre os dados da seed

- **Presidente:** candidatos, números, partidos, vices e o resultado de referência são **reais**, do 1º turno de 2026 (`server/src/scripts/dados-2026.ts`). Confira os números oficiais no site do TSE antes de citá-los; o vice de Rui Costa Pimenta não foi confirmado nas fontes e fica em branco.
- **Deputados, senadores e governador:** candidatos **fictícios** (nomes inventados; partidos reais só para o número de legenda), para a cédula ficar completa.
- **Votos:** o seed **não** importa votos reais (isso é impossível e indevido). Cria eleitores *sintéticos* sem acesso cujas cédulas cifradas reproduzem as **proporções** reais para presidente e sorteiam os demais cargos, para o dashboard e a apuração terem dados verossímeis.
- **Eleitores de demonstração:** 30 nomes de teste (o primeiro é "Vinicius Teste"), entregues pelo botão gov.br simulado.
