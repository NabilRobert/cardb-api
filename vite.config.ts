import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  root: "client",
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: "../client-dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "client/index.html"),
        database: resolve(__dirname, "client/database.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
