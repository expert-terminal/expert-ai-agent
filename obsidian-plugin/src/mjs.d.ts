declare module "*.mjs" {
  export function createEmbedder(onProgress?: (message: string) => void): Promise<{ embed(text: string): Promise<number[]>; embedBatch(texts: string[]): Promise<number[][]> }>;
}
