import { criarApp } from "./app.js";
import { config } from "./config.js";
import { conectar } from "./db.js";
import { garantirChaveAssinatura } from "./crypto/chaves.js";

garantirChaveAssinatura();
await conectar();

criarApp().listen(config.porta, () => {
  console.log(`API da Urna Segura em http://localhost:${config.porta}`);
  console.log(`Nós do ledger: ${config.nosLedger.map((n) => n.nome).join(", ")}`);
});
