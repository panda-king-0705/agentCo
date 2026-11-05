/**
 * Minimal JSON-Schema argument validation for tool calls: object, required,
 * string/number/integer/boolean/array/object types, enum, min/maxLength,
 * minimum/maximum. Returns an error message or null.
 */
type Schema = Record<string, unknown>;

export function validateArgs(schema: Schema, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be a JSON object";
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const record = args as Record<string, unknown>;
  for (const key of (schema.required ?? []) as string[]) {
    if (record[key] === undefined || record[key] === null || record[key] === "") return `missing required argument "${key}"`;
  }
  for (const [key, value] of Object.entries(record)) {
    const property = properties[key];
    if (!property || value === undefined || value === null) continue;
    const error = validateValue(property, value, key);
    if (error) return error;
  }
  return null;
}

function validateValue(schema: Schema, value: unknown, path: string): string | null {
  const type = schema.type as string | undefined;
  if (type === "string") {
    if (typeof value !== "string") return `"${path}" must be a string`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `"${path}" exceeds ${schema.maxLength} characters`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `"${path}" is too short`;
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `"${path}" must be a number`;
    if (type === "integer" && !Number.isInteger(value)) return `"${path}" must be an integer`;
    if (typeof schema.minimum === "number" && value < schema.minimum) return `"${path}" must be ≥ ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `"${path}" must be ≤ ${schema.maximum}`;
  } else if (type === "boolean" && typeof value !== "boolean") return `"${path}" must be a boolean`;
  else if (type === "array") {
    if (!Array.isArray(value)) return `"${path}" must be an array`;
    const items = schema.items as Schema | undefined;
    if (items) for (const [i, item] of value.entries()) {
      const error = validateValue(items, item, `${path}[${i}]`);
      if (error) return error;
    }
  } else if (type === "object" && (typeof value !== "object" || Array.isArray(value))) return `"${path}" must be an object`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `"${path}" must be one of ${schema.enum.join(", ")}`;
  return null;
}
