import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false, // declarations generated via `tsc --emitDeclarationOnly` (see build script)
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: true,
  // node: built-ins are left external by default (tsup/esbuild handle node:* correctly
  // when NOT listed in `external` — listing them there triggers prefix-stripping).
  banner: {
    js: "// warden — provably-safe context layer for AI coding agents",
  },
});
