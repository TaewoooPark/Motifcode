/**
 * Runtime validation of tool arguments.
 *
 * The schemas in `schemas.ts` were, until this module existed, documentation:
 * they shaped the prompt and gave the repair ladder's oracle a set of legal key
 * names, and nothing ever checked an actual call against them. So
 * `{"name":"bash","arguments":{}}` ran an empty command, a `timeout_s` of
 * `"abc"` became `NaN` milliseconds, and a tool name nobody registered reached
 * the dispatcher to be answered with a string.
 *
 * A coding harness cannot treat that as cosmetic. The repair ladder exists to
 * recover malformed output, and the more aggressively it recovers, the more
 * important it is that something downstream asks whether the recovered call
 * *means* anything. Parse success is not the goal; running the command the
 * model intended is.
 *
 * One validator, used by every path that can produce a call — strict parse,
 * repaired parse, server-extracted `tool_calls`, and the normalised actions the
 * object and raw channels build. A second implementation anywhere would be a
 * second set of rules, and the gap between them is where the bad call gets in.
 *
 * Scope is deliberately the JSON Schema subset `schemas.ts` actually uses:
 * objects with typed primitive properties, string arrays, enums, `required`,
 * and `additionalProperties: false`. Anything outside that subset is rejected
 * as an unsupported schema rather than waved through — a schema the validator
 * does not understand must not become a call it cannot check.
 */

import { unwrapTool, type JsonSchema, type Tool } from "./types.js";

export interface ValidationError {
  /** Dotted path to the offending value, e.g. `arguments.timeout_s`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: ValidationError[] };

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkPrimitive(schema: JsonSchema, value: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        errors.push({ path, message: `expected a string, got ${typeName(value)}` });
      }
      break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        // `NaN` and `Infinity` are the interesting cases: JSON cannot carry
        // them, but a coercion upstream can invent them, and a NaN timeout is a
        // command that never gets killed.
        errors.push({ path, message: `expected a finite number, got ${typeName(value)}` });
      } else if (schema.type === "integer" && !Number.isInteger(value)) {
        errors.push({ path, message: `expected an integer, got ${value}` });
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push({ path, message: `expected a boolean, got ${typeName(value)}` });
      }
      break;
    case "array": {
      if (!Array.isArray(value)) {
        errors.push({ path, message: `expected an array, got ${typeName(value)}` });
        break;
      }
      const items = schema.items;
      if (items) {
        value.forEach((item, i) => errors.push(...checkPrimitive(items, item, `${path}[${i}]`)));
      }
      break;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push({ path, message: `expected an object, got ${typeName(value)}` });
      }
      break;
    }
    default:
      errors.push({ path, message: `unsupported schema type ${String(schema.type)}` });
  }
  if (errors.length === 0 && schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `must be one of ${schema.enum.map(String).join(", ")}` });
  }
  return errors;
}

export class ToolValidator {
  private readonly byName = new Map<string, JsonSchema>();

  constructor(tools: readonly Tool[]) {
    for (const t of tools) {
      const fn = unwrapTool(t);
      this.byName.set(fn.name, fn.parameters ?? { type: "object" });
    }
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  validate(name: string, args: unknown): ValidationResult {
    const schema = this.byName.get(name);
    if (!schema) {
      return {
        ok: false,
        errors: [
          {
            path: "name",
            message: `unknown tool "${name}"; registered: ${this.names.join(", ")}`,
          },
        ],
      };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return { ok: false, errors: [{ path: "arguments", message: `expected an object, got ${typeName(args)}` }] };
    }

    const value = args as Record<string, unknown>;
    const props = schema.properties ?? {};
    const errors: ValidationError[] = [];

    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) {
        errors.push({ path: `arguments.${key}`, message: "required" });
      }
    }

    for (const [key, raw] of Object.entries(value)) {
      const propSchema = props[key];
      if (!propSchema) {
        if (schema.additionalProperties === false) {
          errors.push({ path: `arguments.${key}`, message: "not declared by this tool" });
        }
        continue;
      }
      if (raw === undefined) continue;
      errors.push(...checkPrimitive(propSchema, raw, `arguments.${key}`));
    }

    return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
  }
}

export function formatErrors(errors: readonly ValidationError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("; ");
}
