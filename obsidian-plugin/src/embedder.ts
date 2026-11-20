import { createEmbedder } from "./transformer-loader.mjs";

export type EmbedBatch = (texts: string[]) => Promise<number[][]>;
export interface LocalEmbedder { embed(text: string): Promise<number[]>; embedBatch: EmbedBatch }

export async function loadLocalEmbedder(onProgress?: (message: string) => void, wasmPaths?: { mjs: string; wasm: string }): Promise<LocalEmbedder> {
  // Keep the implementation bundled in main.js instead of asking Obsidian's
  // app:// loader to fetch a second plugin module at runtime. The model itself
  // is still loaded only when the user enables semantic search.
  return createEmbedder(onProgress, wasmPaths);
}
