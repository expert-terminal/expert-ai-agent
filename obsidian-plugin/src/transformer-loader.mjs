import { env, pipeline } from "@huggingface/transformers";

// Bound ONNX Runtime parallelism so optional local embeddings do not claim
// every CPU core or slow other desktop work while a large archive is indexed.
env.backends.onnx = env.backends.onnx || {};
env.backends.onnx.wasm = env.backends.onnx.wasm || {};
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = true;

env.allowRemoteModels = true;
// Obsidian runs this bundled loader in an Electron renderer. Keep the model in
// the browser's local CacheStorage rather than probing a nonexistent /models path.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.cacheKey = "expert-ai-companion-transformers";

let extractorPromise;

export async function createEmbedder(onProgress = () => {}, wasmPaths) {
  if (wasmPaths?.mjs && wasmPaths?.wasm) env.backends.onnx.wasm.wasmPaths = wasmPaths;
  if (!extractorPromise) {
    const loadPipeline = () => pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8",
      progress_callback: (event) => {
        if (event?.status === "progress") onProgress(`Downloading local semantic model: ${Math.round(event.progress || 0)}%`);
        else if (event?.status === "done") onProgress("Local semantic model is ready.");
      },
    });
    let pending = loadPipeline();
    if (env.backends.onnx.wasm.proxy) {
      pending = pending.catch((error) => {
        if (!/worker|blob|content security policy|proxy/i.test(String(error?.message || error))) throw error;
        // Obsidian's Electron CSP may reject the ONNX blob worker on some
        // versions. Fall back to one-thread in-renderer WASM so the feature
        // still starts instead of leaving semantic search permanently broken.
        env.backends.onnx.wasm.proxy = false;
        onProgress("Retrying the local semantic model with the compatible single-thread runtime.");
        return loadPipeline();
      });
    }
    extractorPromise = pending.catch((error) => {
      // A failed download or unavailable WASM runtime must not poison all
      // later retries for this plugin lifetime.
      extractorPromise = undefined;
      throw error;
    });
  }
  const extractor = await extractorPromise;
  const embedBatch = async (texts) => {
    if (!texts.length) return [];
    const input = texts.map((text) => String(text || "").slice(0, 1800));
    const result = await extractor(input, { pooling: "mean", normalize: true });
    const dimension = Number(result.dims?.at(-1)) || Math.floor(result.data.length / input.length);
    return input.map((_, index) => Array.from(result.data.slice(index * dimension, (index + 1) * dimension), Number));
  };
  return { embed: async (text) => (await embedBatch([text]))[0], embedBatch };
}
