import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        arena: resolve(__dirname, "arena.html"),
        verify: resolve(__dirname, "verify.html"),
      },
    },
  },
});
