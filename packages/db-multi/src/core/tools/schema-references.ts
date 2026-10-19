/** Objects in which a schema name appears as text in the database. `ALTER SCHEMA … RENAME` and `SET SCHEMA` automatically follow definitions
 * bound to the OID (view, default, policy and rule bodies are stored as parsed trees); they never rewrite text. So function bodies and settings
 * are searched as text, and in other definitions only string constants (e.g. `to_regclass('old.table')`); OID constants like
 * `'old.table'::regclass` follow the rename and are not counted. */
import type { Connection } from "../driver";

/** A plain identifier that needs no quoting (for schema and object names). */
export const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SYSTEM_SCHEMAS = ["platform", "public", "information_schema"];
/** A movable/adoptable user schema: a plain identifier; not a system schema (`pg_…`, `information_schema`), `platform` or `public`. */
export const isUserSchema = (value: string) => PLAIN_IDENTIFIER.test(value) && !value.startsWith("pg_") && !SYSTEM_SCHEMAS.includes(value);

/** `source`: function body (raw text); `config`: function settings (`proconfig`); `expression`: parsed definition. */
export type ReferenceMode = "source" | "config" | "expression";
export interface ReferenceCandidate {
  kind: string;
  name: string;
  mode: ReferenceMode;
  text: string;
}
/** An object whose text mentions the name: kind (`function`, `trigger function`, `view` …) and qualified name. */
export type NameReference = Pick<ReferenceCandidate, "kind" | "name">;

const IDENTIFIER_END = "(?![\\w$])";
const IDENTIFIER_START = "(?<![\\w$\"])";
/** `name.` or `"name".`: a qualified name part. Since the schema name is `[a-z0-9_]` no escaping is needed. */
const qualifiedPattern = (schema: string) => new RegExp(`${IDENTIFIER_START}"?${schema}"?\\s*\\.`, "i");
/** A bare name in a settings list (`…=old, public`). */
const wordPattern = (schema: string) => new RegExp(`${IDENTIFIER_START}"?${schema}"?${IDENTIFIER_END}`, "i");
/** A `'…'` constant; if an OID cast such as `::regclass` or `::regproc` follows, the captured group stays empty. */
const LITERALS = /'((?:[^']|'')*)'(::reg\w+)?/g;

/** Contents of string constants (excluding constants with an OID cast). */
function literals(text: string): string[] {
  return [...text.matchAll(LITERALS)].filter((match) => !match[2]).map((match) => (match[1] ?? "").replaceAll("''", "'"));
}

/** Whether the constant contains the name qualified or exactly (`'old.table'`, `'old'`). */
const literalMentions = (value: string, schema: string) => qualifiedPattern(schema).test(value) || value.trim().toLowerCase() === schema;

/** Pure decision: whether the candidate text contains the schema name in a form a rename would not follow. */
export function mentionsSchema(candidate: Pick<ReferenceCandidate, "mode" | "text">, schema: string): boolean {
  if (candidate.mode === "config") return wordPattern(schema).test(candidate.text);
  const inLiterals = literals(candidate.text).some((value) => literalMentions(value, schema));
  return inLiterals || (candidate.mode === "source" && qualifiedPattern(schema).test(candidate.text));
}

/** Candidates: functions outside system schemas (body and settings), view/materialized view, column default, policy, rule.
 * `$1`: JSON array of the names searched for; only texts containing at least one (in lower case) are returned, the final decision is in `mentionsSchema`. */
const CANDIDATES_SQL = `WITH names AS (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb) AS name),
objects AS (
  SELECT CASE WHEN p.prorettype='pg_catalog.trigger'::pg_catalog.regtype THEN 'trigger function' ELSE 'function' END AS kind,
    n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')' AS name, 'source' AS mode, COALESCE(p.prosrc,'') AS text
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  UNION ALL
  SELECT CASE WHEN p.prorettype='pg_catalog.trigger'::pg_catalog.regtype THEN 'trigger function' ELSE 'function' END,
    n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')', 'config', pg_catalog.array_to_string(p.proconfig,' ')
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE p.proconfig IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  UNION ALL
  SELECT CASE c.relkind WHEN 'm' THEN 'materialized view' ELSE 'view' END, n.nspname||'.'||c.relname, 'expression', pg_catalog.pg_get_viewdef(c.oid)
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  UNION ALL
  SELECT 'column default', n.nspname||'.'||c.relname||'.'||a.attname, 'expression', pg_catalog.pg_get_expr(d.adbin,d.adrelid)
  FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid=d.adrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  UNION ALL
  SELECT 'policy', n.nspname||'.'||c.relname||'.'||pol.polname, 'expression',
    COALESCE(pg_catalog.pg_get_expr(pol.polqual,pol.polrelid),'')||' '||COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck,pol.polrelid),'')
  FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid=pol.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'rule', n.nspname||'.'||c.relname||'.'||r.rulename, 'expression', pg_catalog.pg_get_ruledef(r.oid)
  FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE r.rulename<>'_RETURN' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
)
SELECT o.kind, o.name, o.mode, o.text FROM objects o
WHERE EXISTS (SELECT 1 FROM names WHERE pg_catalog.strpos(pg_catalog.lower(o.text), names.name) > 0)
ORDER BY o.kind, o.name`;

/** Objects in this DB in which each name appears as text (one query); a schema that is not mentioned gets an empty array in the list. */
export async function findSchemaReferences(db: Pick<Connection, "query">, schemas: readonly string[]): Promise<Map<string, NameReference[]>> {
  const result = new Map(schemas.map((schema) => [schema, [] as NameReference[]]));
  if (!schemas.length) return result;
  const candidates = await db.query<ReferenceCandidate>(CANDIDATES_SQL, [JSON.stringify(schemas)]);
  for (const schema of schemas)
    for (const candidate of candidates)
      if (mentionsSchema(candidate, schema)) addUnique(result.get(schema) as NameReference[], { kind: candidate.kind, name: candidate.name });
  return result;
}

/** The same function can appear in both the body and the settings: it is listed once. */
function addUnique(list: NameReference[], reference: NameReference) {
  if (!list.some((item) => item.kind === reference.kind && item.name === reference.name)) list.push(reference);
}
