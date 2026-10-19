/** Schema and identifier validation: every name that enters SQL passes through here; an identifier is never a value parameter. */
import { AppError } from "./errors";

/** Application tables live here when no schema is passed to `createDb`. */
export const DEFAULT_SCHEMA = "public";
/** Lowercase letters, digits and `_`; starts with a letter or `_`, at most 63 bytes. `pg_*` and `information_schema` belong to the system. */
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

export function validateSchema(value: string): string {
  if (typeof value !== "string" || !SCHEMA.test(value) || value.startsWith("pg_") || value === "information_schema") throw new AppError("INVALID_SCHEMA", "invalid schema name");
  return value;
}

const encoder = new TextEncoder();
/** 21 UTF-16 units take at most 63 bytes; short names are not encoded. */
const tooLong = (value: string) => value.length > 21 && encoder.encode(value).length > 63;

export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0") || tooLong(value)) throw new AppError("INVALID_IDENTIFIER", "Invalid PostgreSQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

/** `"schema"."name"`: the schema is validated and both parts are quoted. */
export const qualified = (schema: string, name: string) => `${quoteIdentifier(validateSchema(schema))}.${quoteIdentifier(name)}`;
