import esbuild from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await esbuild.build({
  entryPoints: ["src/main.ts"], outfile: "dist/main.js", bundle: true,
  format: "cjs", platform: "browser", target: "es2022", sourcemap: false,
  external: ["obsidian", "electron", "node:*"], logLevel: "info",
});
for (const file of ["manifest.json", "icon.png", "styles.css", "README.md", "CHANGELOG.md"]) {
  await copyFile(file, `dist/${file}`).catch(() => {});
}
