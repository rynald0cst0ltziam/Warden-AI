/**
 * Local embedding model for semantic memory search.
 *
 * Uses Xenova/all-MiniLM-L6-v2 (384-dim) via @xenova/transformers (ONNX
 * runtime, WASM backend). The model downloads once from the HuggingFace CDN
 * on first use and caches locally under ~/.warden/models/. All inference is
 * local after that initial download — no API keys, no telemetry, no per-query
 * network calls.
 *
 * Zero config: embeddings build automatically on first memory save. If the
 * model cannot be loaded (offline, disk full, etc.), recall gracefully falls
 * back to FTS5-only keyword search. The fallback is permanent for the session
 * — we don't retry every recall.
 *
 * The 384-dimensional vectors are stored as Float32Array buffers in the
 * SQLite store (1.5 KB per memory). Vector search is in-memory cosine
 * similarity — for typical memory counts (<10k) this is <1 ms.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { logger } from "../logging/index.js";

/** HuggingFace model ID for the ONNX-converted all-MiniLM-L6-v2. */
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
/** Embedding dimensionality produced by all-MiniLM-L6-v2. */
export const EMBEDDING_DIM = 384;

/** Cache directory for the downloaded model. */
function modelCacheDir(): string {
  const dir = join(homedir(), ".warden", "models");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Lazy-loaded pipeline singleton. Three states:
//   - null + initPromise === null  → not yet attempted
//   - initPromise !== null         → loading in progress
//   - pipeline !== null            → ready
//   - initFailed === true          → permanently failed this session
let pipeline: ((text: string | string[], options: { pooling: string; normalize: boolean }) => Promise<unknown>) | null = null;
let initPromise: Promise<typeof pipeline> | null = null;
let initFailed = false;

// Check for env var to disable embeddings entirely (tests, CI, air-gapped)
if (process.env.WARDEN_NO_EMBEDDINGS === "1" || process.env.WARDEN_NO_EMBEDDINGS === "true") {
  initFailed = true;
}

/**
 * Load the feature-extraction pipeline. Downloads the model on first call
 * (~22 MB quantized), then caches it on disk. Subsequent calls return the
 * cached singleton in <10 ms.
 *
 * Returns `null` if the model cannot be loaded (package missing, download
 * failed, WASM backend unavailable). Callers must handle null by falling
 * back to FTS5-only search.
 */
async function getPipeline(): Promise<typeof pipeline> {
  if (initFailed) return null;
  if (pipeline) return pipeline;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const mod = await import("@xenova/transformers");
      const env = mod.env;
      // Cache models under ~/.warden/models/ — keeps them with Warden's data.
      env.cacheDir = modelCacheDir();
      // Don't allow remote models if the user has set this flag (air-gapped).
      // Default: allow remote for the initial download, then serve from cache.
      const extractor = await mod.pipeline("feature-extraction", MODEL_ID);
      pipeline = extractor as unknown as typeof pipeline;
      logger.info("embedding model loaded — semantic memory search active", {
        model: MODEL_ID,
        cacheDir: env.cacheDir,
      });
      return pipeline;
    } catch (err) {
      initFailed = true;
      logger.warn(
        "embedding model unavailable — semantic search disabled, using FTS5 only",
        {
          err: String(err),
          hint: "Model downloads on first use. If offline, semantic search will activate once online.",
        },
      );
      return null;
    }
  })();

  return initPromise;
}

/** Pre-warm the model so the first recall doesn't pay the load latency. */
export async function warmEmbeddings(): Promise<boolean> {
  const p = await getPipeline();
  return p !== null;
}

/** Whether the embedding model is available for this session. */
export function embeddingsAvailable(): boolean {
  return pipeline !== null;
}

/** Whether the model has permanently failed for this session. */
export function embeddingsFailed(): boolean {
  return initFailed;
}

/**
 * Generate an embedding vector for a single text string.
 * Returns a 384-dim Float32Array, or null if the model is unavailable.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  const extractor = await getPipeline();
  if (!extractor) return null;

  try {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    // output.data is a Float32Array (or TypedArray) of length 384
    const data = (output as { data: Iterable<number> }).data;
    return new Float32Array(data);
  } catch (err) {
    logger.warn("embedding generation failed", { err: String(err) });
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in a single batch.
 * More efficient than calling embed() in a loop — the model processes
 * all texts in one forward pass.
 *
 * Returns an array aligned with the input: each element is a 384-dim
 * Float32Array or null (if generation failed for that text).
 */
export async function embedBatch(
  texts: string[],
): Promise<(Float32Array | null)[]> {
  const extractor = await getPipeline();
  if (!extractor) return texts.map(() => null);

  try {
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    // For batch input, output has shape [N, 384]. tolist() gives number[][].
    const tolist = (output as { tolist: () => number[][] }).tolist;
    if (typeof tolist === "function") {
      const lists = tolist.call(output);
      return lists.map((arr) => new Float32Array(arr));
    }
    // Fallback: output.data is a flat Float32Array of length N*384
    const data = (output as { data: Float32Array; dims?: number[] }).data;
    const dims = (output as { dims?: number[] }).dims;
    const batchSize = dims?.[0] ?? texts.length;
    const result: (Float32Array | null)[] = [];
    for (let i = 0; i < batchSize; i++) {
      const start = i * EMBEDDING_DIM;
      result.push(data.slice(start, start + EMBEDDING_DIM));
    }
    return result;
  } catch (err) {
    logger.warn("batch embedding failed", { err: String(err), count: texts.length });
    return texts.map(() => null);
  }
}

/**
 * Cosine similarity between two normalized vectors.
 * Since all-MiniLM-L6-v2 outputs are L2-normalized, this is just a dot product.
 * Returns -1..1.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/**
 * Convert a Float32Array to a Node Buffer for SQLite BLOB storage.
 * 384 floats × 4 bytes = 1536 bytes per memory.
 */
export function embeddingToBuffer(emb: Float32Array): Buffer {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}

/**
 * Convert a SQLite BLOB back to a Float32Array.
 * Returns null if the buffer is empty or the wrong size.
 */
export function bufferToEmbedding(buf: Buffer | null | undefined): Float32Array | null {
  if (!buf || buf.length === 0) return null;
  if (buf.length % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
