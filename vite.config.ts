import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          mui: ["@mui/material", "@mui/icons-material"],
          storage: ["idb-keyval"]
        }
      }
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "MUMBOX",
        short_name: "MUMBOX",
        description: "Offline-first customizable local audio pad.",
        theme_color: "#05070d",
        background_color: "#05070d",
        display: "standalone",
        orientation: "landscape",
        icons: [
          {
            src: "/icon-192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
            purpose: "any"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"]
      }
    })
  ]
});
