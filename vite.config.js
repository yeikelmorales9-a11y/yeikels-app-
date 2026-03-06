import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "https://yeikels-gy446btln-yeikelmorales9-a11ys-projects.vercel.app",
        changeOrigin: true,
      },
    },
  },
});