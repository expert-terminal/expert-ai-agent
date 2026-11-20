export interface LocalEmbedderRuntime {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export function createEmbedder(
  onProgress?: (message: string) => void,
  wasmPaths?: { mjs: string; wasm: string },
): Promise<LocalEmbedderRuntime>;
