import { defineConfig } from "vite";
import { readdirSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 12000,
    rollupOptions: {
      plugins: [
        {
          // ORT WASM files are fetched from CDN (wasmPaths set in neural.ts).
          // Delete them from dist after build — CF Pages has a 25 MiB file limit.
          name: "remove-ort-wasm",
          closeBundle() {
            const dir = resolve("dist/assets");
            if (!existsSync(dir)) return;
            for (const f of readdirSync(dir)) {
              if (f.endsWith(".wasm")) {
                unlinkSync(resolve(dir, f));
                console.log(`[remove-ort-wasm] removed ${f} (served from CDN)`);
              }
            }
          },
        },
      ],
    },
  },
});
