/**
 * MCP tool description compression.
 *
 * MCP tool descriptions are sent to the agent as part of the tool schema.
 * These descriptions are prose that sits in the agent's context for the
 * entire session. Compressing them saves input tokens on every turn.
 *
 * This is Warden's equivalent of caveman-shrink — but applied to our own
 * tool descriptions before they're registered with the MCP server.
 *
 * The compression is deterministic and preserves:
 * - Tool names (warden_grep, warden_file_read, etc.)
 * - Parameter names
 * - Technical terms
 * - Code examples
 *
 * It strips:
 * - Filler words
 * - Redundant phrasing
 * - Verbose explanations
 */
import { compressFile } from "../compress/index.js";

/**
 * Compress a tool description string using Warden's deterministic compressor.
 * Falls back to the original if compression fails validation or produces
 * no savings.
 */
export function compressDescription(description: string): string {
  const result = compressFile(description, "full");
  if (!result.validationOk || result.reductionPct <= 0) {
    return description;
  }
  return result.compressed.trim();
}

/**
 * Compress all tool descriptions in a batch.
 * Returns the total tokens saved.
 */
export function compressDescriptions(descriptions: string[]): {
  compressed: string[];
  tokensSaved: number;
} {
  let tokensSaved = 0;
  const compressed = descriptions.map((desc) => {
    const result = compressFile(desc, "full");
    if (result.validationOk && result.reductionPct > 0) {
      tokensSaved += result.tokensBefore - result.tokensAfter;
      return result.compressed.trim();
    }
    return desc;
  });
  return { compressed, tokensSaved };
}
