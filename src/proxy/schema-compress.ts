/**
 * JSON-Schema compression for MCP tool inputSchemas.
 *
 * Strips cosmetic/documentation fields that add tokens without affecting
 * validation semantics. The model uses inputSchemas to construct valid tool
 * calls — we must never remove fields that constrain valid inputs.
 *
 * SAFE TO REMOVE (no validation impact):
 *   - title          (human-readable label, redundant with property name)
 *   - default        (upstream server applies defaults; model doesn't need it)
 *   - examples       (not used for validation)
 *   - example        (singular form, same)
 *   - $schema        (meta-reference to JSON Schema standard)
 *   - $comment       (author comment)
 *   - readOnly       (not relevant for tool calls)
 *   - writeOnly      (not relevant for tool calls)
 *   - $defs          (only if not referenced by any $ref in the schema)
 *   - definitions    (same, older keyword)
 *
 * COMPRESSED (not removed — model needs parameter guidance):
 *   - description    (run through Warden's prose compression engine)
 *
 * NEVER TOUCHED (validation constraints):
 *   - type, required, enum, const, items, properties, additionalProperties,
 *     oneOf, anyOf, allOf, not, minimum, maximum, exclusiveMinimum,
 *     exclusiveMaximum, minLength, maxLength, pattern, format, minItems,
 *     maxItems, uniqueItems, minProperties, maxProperties, $ref, deprecated,
 *     contentEncoding, contentMediaType
 */

import { compressFile, type CompressLevel } from "../compress/index.js";

/** Fields that are safe to strip entirely (no validation impact). */
const STRIPPABLE_FIELDS = new Set([
  "title",
  "default",
  "examples",
  "example",
  "$schema",
  "$comment",
  "readOnly",
  "writeOnly",
]);

/** Fields that define validation constraints — must never be touched. */
const CONSTRAINED_FIELDS = new Set([
  "type",
  "required",
  "enum",
  "const",
  "items",
  "properties",
  "additionalProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "$ref",
  "deprecated",
  "contentEncoding",
  "contentMediaType",
  "description", // handled specially: compressed, not removed
]);

export interface SchemaCompressResult {
  /** The compressed schema (or original if no reduction). */
  schema: unknown;
  /** Whether any compression was applied. */
  reduced: boolean;
  /** Bytes before compression. */
  bytesBefore: number;
  /** Bytes after compression. */
  bytesAfter: number;
  /** Number of description strings compressed. */
  descriptionsCompressed: number;
  /** Number of fields stripped. */
  fieldsStripped: number;
}

/** Check if a $ref target exists in the schema's $defs/definitions. */
function refExistsInDefs(schema: unknown, ref: string): boolean {
  if (!ref.startsWith("#/")) return false;
  const parts = ref.slice(2).split("/");
  let current: unknown = schema;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return false;
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return false;
  }
  return true;
}

/** Scan the schema for any $ref references to $defs or definitions. */
function hasRefsToDefs(schema: unknown, defKey: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (Array.isArray(schema)) {
    return schema.some((item) => hasRefsToDefs(item, defKey));
  }
  const obj = schema as Record<string, unknown>;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith(`#/${defKey}/`)) {
    return true;
  }
  for (const value of Object.values(obj)) {
    if (hasRefsToDefs(value, defKey)) return true;
  }
  return false;
}

/**
 * Compress a JSON-Schema object by stripping cosmetic fields and compressing
 * description strings. Recurses into nested objects and arrays.
 *
 * The schema is never rewritten in a way that changes validation semantics.
 * If compression fails or produces no reduction, the original is returned.
 */
export function compressInputSchema(
  schema: unknown,
  level: CompressLevel = "full",
): SchemaCompressResult {
  const beforeJson = JSON.stringify(schema);
  const bytesBefore = Buffer.byteLength(beforeJson ?? "", "utf8");

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { schema, reduced: false, bytesBefore, bytesAfter: bytesBefore, descriptionsCompressed: 0, fieldsStripped: 0 };
  }

  let descriptionsCompressed = 0;
  let fieldsStripped = 0;

  function compressValue(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(compressValue);
    }

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    // Check if $defs/definitions are referenced before stripping them
    const hasDefsRef = hasRefsToDefs(obj, "$defs");
    const hasDefinitionsRef = hasRefsToDefs(obj, "definitions");

    for (const [key, val] of Object.entries(obj)) {
      // Strip cosmetic fields
      if (STRIPPABLE_FIELDS.has(key)) {
        fieldsStripped++;
        continue;
      }

      // Strip $defs only if not referenced
      if (key === "$defs" && !hasDefsRef) {
        fieldsStripped++;
        continue;
      }
      // Strip definitions only if not referenced
      if (key === "definitions" && !hasDefinitionsRef) {
        fieldsStripped++;
        continue;
      }

      // Compress description strings
      if (key === "description" && typeof val === "string" && val.length > 0) {
        const compressed = compressFile(val, level);
        if (compressed.validationOk && compressed.compressed.length < val.length) {
          descriptionsCompressed++;
          result[key] = compressed.compressed.trim();
          continue;
        }
        result[key] = val;
        continue;
      }

      // Recurse into nested structures
      if (CONSTRAINED_FIELDS.has(key) || !STRIPPABLE_FIELDS.has(key)) {
        result[key] = compressValue(val);
      }
    }

    return result;
  }

  const compressed = compressValue(schema);
  const afterJson = JSON.stringify(compressed);
  const bytesAfter = Buffer.byteLength(afterJson ?? "", "utf8");

  const reduced = fieldsStripped > 0 || descriptionsCompressed > 0;

  return {
    schema: compressed,
    reduced,
    bytesBefore,
    bytesAfter,
    descriptionsCompressed,
    fieldsStripped,
  };
}
