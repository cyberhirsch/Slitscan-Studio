import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Suppress the large-chunk warning for opencv.js and ORT — these are
    // expected large deps loaded lazily; WASM is served from CDN, not dist.
    chunkSizeWarningLimit: 12000,
    rollupOptions: {
      plugins: [
        {
          // ORT WASM files are fetched from CDN (wasmPaths in neural.ts).
          // Exclude them from the dist so we stay under CF Pages' 25 MiB limit.
          name: "exclude-ort-wasm",
          resolveId(id: string) {
            if (id.endsWith(".wasm")) return { id, external: true };
            return null;
          },
        },
      ],
    },
  },
});
