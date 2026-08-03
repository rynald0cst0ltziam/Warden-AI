import { defineConfig } from "vitest/config";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    extensions: [".ts", ".js", ".mjs"],
  },
  plugins: [
    {
      name: "resolve-js-to-ts",
      resolveId(source, importer) {
        // Resolve .js imports to .ts for local source files
        if (source.endsWith(".js") && importer && source.startsWith(".")) {
          if (!isAbsolute(importer)) importer = join(__dirname, importer);
          const dir = dirname(importer);
          const tsPath = join(dir, source.replace(/\.js$/, ".ts"));
          return tsPath;
        }
        return null;
      },
    },
  ],
  esbuild: {
    target: "es2022",
  },
});
