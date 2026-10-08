import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Em desenvolvimento o Vite repassa /api para o Express: mesma origem para o navegador,
// então os cookies SameSite=Strict e a política "sem CORS" continuam valendo.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3001", changeOrigin: false } },
  },
  build: { sourcemap: false },
});
