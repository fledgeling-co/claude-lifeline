/**
 * Infer a JSON-schema (with defaults) for a workflow's `args` from one concrete value.
 *
 * Deep research found no off-the-shelf tool for the full "diff instances → promote
 * literals to typed, defaulted parameters" loop; the typing half is simple recursive
 * inference (jtd-infer style), and the defaults are the observed literals themselves —
 * which is exactly Prefect's deployment model (parameter defaults + an OpenAPI schema).
 */

export interface InferredSchema {
  type?: string;
  items?: InferredSchema;
  properties?: Record<string, InferredSchema>;
  required?: string[];
  default?: unknown;
  /** Present when an array mixes element types — recorded honestly, not averaged. */
  anyOf?: InferredSchema[];
  nullable?: boolean;
}

export function inferSchema(value: unknown): InferredSchema {
  if (value === null || value === undefined) {
    return { nullable: true, default: null };
  }
  if (Array.isArray(value)) {
    const elementSchemas = dedupeSchemas(value.map(inferSchema));
    const base: InferredSchema = { type: "array", default: value };
    if (elementSchemas.length === 1 && elementSchemas[0] !== undefined) base.items = stripDefault(elementSchemas[0]);
    else if (elementSchemas.length > 1) base.anyOf = elementSchemas.map(stripDefault);
    return base;
  }
  switch (typeof value) {
    case "string":
      return { type: "string", default: value };
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number", default: value };
    case "boolean":
      return { type: "boolean", default: value };
    case "object": {
      const properties: Record<string, InferredSchema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        properties[k] = inferSchema(v);
        if (v !== undefined && v !== null) required.push(k);
      }
      return { type: "object", properties, required, default: value };
    }
    default:
      return { default: value };
  }
}

function stripDefault(s: InferredSchema): InferredSchema {
  const { default: _d, ...rest } = s;
  return rest;
}

function dedupeSchemas(schemas: InferredSchema[]): InferredSchema[] {
  const seen = new Map<string, InferredSchema>();
  for (const s of schemas) {
    const key = JSON.stringify(stripDefault(s));
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()];
}

/**
 * Validate a value against an inferred schema. Deliberately shallow-strict: type
 * mismatches and missing required keys fail; extra keys pass (Temporal's advice —
 * a single growable object argument).
 */
export function validateAgainst(schema: InferredSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (value === null || value === undefined) {
    if (!schema.nullable) errors.push(`${path}: is ${String(value)} but schema is not nullable`);
    return errors;
  }
  if (schema.type === undefined) return errors;
  const actual = Array.isArray(value) ? "array" : typeof value;
  const expected = schema.type === "integer" ? "number" : schema.type;
  if (schema.type === "integer" && typeof value === "number" && !Number.isInteger(value)) {
    errors.push(`${path}: expected integer, got ${value}`);
  }
  if (actual !== expected) {
    errors.push(`${path}: expected ${schema.type}, got ${actual}`);
    return errors;
  }
  if (schema.type === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required key missing`);
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in obj) errors.push(...validateAgainst(sub, obj[k], `${path}.${k}`));
    }
  }
  if (schema.type === "array" && schema.items) {
    (value as unknown[]).forEach((v, i) => errors.push(...validateAgainst(schema.items!, v, `${path}[${i}]`)));
  }
  return errors;
}
