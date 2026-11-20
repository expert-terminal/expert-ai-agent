import esbuild from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

const extensionOnly = process.argv.includes("--extension-only");
const watch = process.argv.includes("--watch");
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const extension = {
  entryPoints: ["agent/obsidian-pi-extension.mjs"],
  outfile: "dist/obsidian-pi-extension.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
  external: ["node:*"],
};

const plugin = {
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  external: ["obsidian", "electron", "node:*"],
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(plugin);
  await ctx.watch();
  await esbuild.build(extension);
  console.log("Watching Expert AI plugin. Ctrl+C to stop.");
} else {
  if (!extensionOnly) await esbuild.build(plugin);
  await esbuild.build(extension);
  await copyFile("manifest.json", "dist/manifest.json");
  await copyFile("icon.png", "dist/icon.png");
  await copyFile("README.md", "dist/README.md");
  await copyFile("styles.css", "dist/styles.css").catch(() => {});
  await copyFile("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs", "dist/ort-wasm-simd-threaded.asyncify.mjs");
  await copyFile("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm", "dist/ort-wasm-simd-threaded.asyncify.wasm");
}
