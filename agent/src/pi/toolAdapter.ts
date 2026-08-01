/**
 * Adapts paperagent's existing JSON-Schema tool definitions into Pi
 * `ToolDefinition`s. The 53 domain tools keep their hand-written schemas and
 * handlers; this file only translates the schema shape into TypeBox (what Pi
 * expects) and wraps the existing `executeTool` dispatch so none of the tool
 * implementations have to be rewritten.
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JSONSchemaProperty>;
    required: string[];
  };
}

function propToTypeBox(p: JSONSchemaProperty): TSchema {
  const opts = p.description ? { description: p.description } : {};
  switch (p.type) {
    case "string":
      return p.enum && p.enum.length
        ? Type.Union(p.enum.map((v) => Type.Literal(v)), opts)
        : Type.String(opts);
    case "number":
      return Type.Number(opts);
    case "integer":
      return Type.Integer(opts);
    case "boolean":
      return Type.Boolean(opts);
    case "array":
      return Type.Array(p.items ? propToTypeBox(p.items) : Type.Any(), opts);
    case "object":
      return objectToTypeBox(p.properties ?? {}, p.required ?? [], opts);
    default:
      return Type.Any(opts);
  }
}

function objectToTypeBox(
  properties: Record<string, JSONSchemaProperty>,
  required: string[],
  opts: Record<string, unknown> = {},
): TSchema {
  const fields: Record<string, TSchema> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const schema = propToTypeBox(prop);
    fields[key] = required.includes(key) ? schema : Type.Optional(schema);
  }
  return Type.Object(fields, opts);
}

export function jsonSchemaToTypeBox(schema: ToolSchema["parameters"]): TSchema {
  return objectToTypeBox(schema.properties, schema.required);
}

/** Executes a domain tool by name and returns its string result, throwing on failure. */
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<string>;

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Wrap each JSON-Schema tool as a Pi custom tool backed by `exec`. */
export function toPiTools(schemas: ToolSchema[], exec: ToolExecutor): ToolDefinition[] {
  return schemas.map((schema) =>
    defineTool({
      name: schema.name,
      label: humanize(schema.name),
      description: schema.description,
      parameters: jsonSchemaToTypeBox(schema.parameters),
      async execute(_toolCallId, params) {
        // Throw on failure so Pi marks the result as an error (the previous
        // engine returned a "Tool error:" string instead).
        const text = await exec(schema.name, (params ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
  );
}
