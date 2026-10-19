import { expect, test } from "bun:test";
import { type AdoptionFacts, classifyAdoption, normalizeRows } from "../../core/tools/adopt";
import { mentionsSchema } from "../../core/tools/schema-references";

const facts = (overrides: Partial<AdoptionFacts> = {}): AdoptionFacts => ({
  databaseIds: ["db0", "db1"],
  reserved: new Set(),
  tenants: new Map(),
  placementOwners: new Map(),
  schemas: new Map([
    ["db0", new Set(["chitchat", "kadikoy"])],
    ["db1", new Set(["moda"])],
  ]),
  populated: new Map(),
  references: new Map(),
  ...overrides,
});
const row = (tenantId: string, schema: string, databaseId = "db0", extra: object = {}) => ({ tenantId, schema, databaseId, ...extra });
const plan = (rows: object[], input = facts(), options = {}) => classifyAdoption(normalizeRows(rows), input, options);
const codes = (rows: object[], input = facts()) => plan(rows, input).map((r) => [r.status, ...r.problems.map((p) => p.code)]);

test("rows get defaults; malformed rows are USAGE with their position", () => {
  expect(normalizeRows([row("chitchat", "chitchat")])).toEqual([{ tenantId: "chitchat", schema: "chitchat", databaseId: "db0", kind: "tenant", size: 1, line: 1 }]);
  for (const bad of [{ tenantId: "a", schema: "b" }, { ...row("abc", "abc"), size: 0 }, { ...row("abc", "abc"), kind: "shop" }, { ...row("abc", "abc"), extra: 1 }])
    expect(() => normalizeRows([row("ok", "ok"), bad])).toThrow(expect.objectContaining({ code: "USAGE", message: expect.stringContaining("row 2") }));
});

test("a legacy schema with a valid, free tenant id is ready and targets tenant_/demo_ names", () => {
  const [ready, demo] = plan([row("chitchat", "chitchat"), row("moda", "moda", "db1", { kind: "demo", size: 20 })]);
  expect(ready).toMatchObject({ status: "ready", from: "chitchat", to: "tenant_chitchat", problems: [] });
  expect(demo).toMatchObject({ status: "ready", to: "demo_moda", kind: "demo", size: 20 });
});

test("input problems: tenant id rule, duplicates, source identifier, database and reserved ids", () => {
  const input = facts({ reserved: new Set(["admin"]), placementOwners: new Map([["tenant_other", "other"]]) });
  expect(
    codes(
      [
        row("Chit_Chat", "chitchat"),
        row("dup", "kadikoy"),
        row("dup", "moda", "db1"),
        row("pub", "public"),
        row("sys", "pg_toast"),
        row("quoted", "Chit-Chat"),
        row("steal", "tenant_other"),
        row("far", "chitchat", "db9"),
        row("admin", "admin_legacy"),
      ],
      input,
    ),
  ).toEqual([
    ["blocked", "INVALID_TENANT_ID"],
    ["blocked", "DUPLICATE_TENANT_ID"],
    ["blocked", "DUPLICATE_TENANT_ID"],
    ["blocked", "INVALID_SOURCE_SCHEMA"],
    ["blocked", "INVALID_SOURCE_SCHEMA"],
    ["blocked", "INVALID_SOURCE_SCHEMA"],
    ["blocked", "INVALID_SOURCE_SCHEMA"],
    ["blocked", "DATABASE_NOT_CONFIGURED"],
    ["blocked", "TENANT_RESERVED"],
  ]);
  expect(codes([row("abc", "chitchat"), row("xyz", "chitchat")])).toEqual([
    ["blocked", "DUPLICATE_SOURCE_SCHEMA"],
    ["blocked", "DUPLICATE_SOURCE_SCHEMA"],
  ]);
});

test("state problems: missing source, target on any database, existing tenant and text references", () => {
  const schemas = new Map([
    ["db0", new Set(["chitchat", "kadikoy", "moda", "legacy_taken", "tenant_kadikoy"])],
    ["db1", new Set(["demo_moda"])],
  ]);
  const input = facts({
    schemas,
    tenants: new Map([["taken", { placement: { databaseId: "db1", schemaName: "tenant_taken", status: "active" } }]]),
    references: new Map([["db0/chitchat", [{ kind: "function", name: "chitchat.count_students()" }]]]),
  });
  expect(codes([row("gone", "nothing"), row("kadikoy", "kadikoy"), row("moda", "moda"), row("taken", "legacy_taken")], input)).toEqual([
    ["blocked", "SOURCE_SCHEMA_MISSING"],
    ["blocked", "TARGET_SCHEMA_EXISTS"],
    ["blocked", "TARGET_SCHEMA_EXISTS"],
    ["blocked", "TENANT_EXISTS"],
  ]);
  const [referenced] = plan([row("chitchat", "chitchat")], input);
  expect(referenced?.problems).toEqual([expect.objectContaining({ code: "SCHEMA_REFERENCED_BY_NAME", objects: [{ kind: "function", name: "chitchat.count_students()" }] })]);
});

test("reruns: adopted rows are alreadyAdopted, a claimed but unrenamed row is ready, a legacy tenant_ schema needs no rename", () => {
  const placement = (status: "active" | "provisioning") => ({ placement: { databaseId: "db0", schemaName: "tenant_chitchat", status } });
  const renamed = facts({ schemas: new Map([["db0", new Set(["tenant_chitchat"])], ["db1", new Set()]]), tenants: new Map([["chitchat", placement("active")]]) });
  expect(plan([row("chitchat", "chitchat")], renamed)[0]).toMatchObject({ status: "alreadyAdopted", placementStatus: "active" });
  const claimed = facts({ tenants: new Map([["chitchat", placement("provisioning")]]) });
  expect(plan([row("chitchat", "chitchat")], claimed)[0]).toMatchObject({ status: "ready", placementStatus: "provisioning" });
  const both = facts({ schemas: new Map([["db0", new Set(["chitchat", "tenant_chitchat"])], ["db1", new Set()]]), tenants: new Map([["chitchat", placement("provisioning")]]) });
  expect(codes([row("chitchat", "chitchat")], both)).toEqual([["blocked", "TARGET_SCHEMA_EXISTS"]]);
  const sameName = facts({ schemas: new Map([["db0", new Set(["tenant_chitchat"])], ["db1", new Set()]]) });
  expect(plan([row("chitchat", "tenant_chitchat")], sameName)[0]).toMatchObject({ status: "ready", from: "tenant_chitchat", to: "tenant_chitchat" });
});

test("a schema that already has tables needs a baseline unless the tenant is already active", () => {
  const populated = new Map([["db0", new Set(["chitchat", "tenant_kadikoy"])]]);
  const input = facts({ populated, schemas: new Map([["db0", new Set(["chitchat", "tenant_kadikoy", "moda"])], ["db1", new Set()]]) });
  const placement = (status: "active" | "provisioning") => new Map([["kadikoy", { placement: { databaseId: "db0", schemaName: "tenant_kadikoy", status } }]]);
  expect(codes([row("chitchat", "chitchat"), row("moda", "moda")], input)).toEqual([["blocked", "BASELINE_REQUIRED"], ["ready"]]);
  expect(plan([row("chitchat", "chitchat")], input, { baseline: "20260901083015_initial" })[0]?.status).toBe("ready");
  // An unfinished adoption (renamed, not active) also needs a baseline; an active one is complete.
  expect(codes([row("kadikoy", "kadikoy")], facts({ ...input, tenants: placement("provisioning") }))).toEqual([["blocked", "BASELINE_REQUIRED"]]);
  expect(codes([row("kadikoy", "kadikoy")], facts({ ...input, tenants: placement("active") }))).toEqual([["alreadyAdopted"]]);
});

test("text references: function bodies and settings count; OID-bound deparsed names and regclass literals do not", () => {
  const source = (text: string) => mentionsSchema({ mode: "source", text }, "chitchat");
  const expression = (text: string) => mentionsSchema({ mode: "expression", text }, "chitchat");
  expect(source("SELECT count(*) FROM chitchat.students")).toBe(true);
  expect(source('SELECT 1 FROM "chitchat"."students"')).toBe(true);
  expect(source("SELECT 1 FROM CHITCHAT . students")).toBe(true);
  expect(source("SELECT 1 FROM xchitchat.students, chitchat_old.students")).toBe(false);
  expect(source("PERFORM set_config('app.schema', 'chitchat', true)")).toBe(true);
  expect(expression(" SELECT students.id FROM chitchat.students;")).toBe(false);
  expect(expression("nextval('chitchat.students_id_seq'::regclass)")).toBe(false);
  expect(expression("to_regclass('chitchat.students'::text)")).toBe(true);
  expect(mentionsSchema({ mode: "config", text: "search_path=chitchat, public" }, "chitchat")).toBe(true);
  expect(mentionsSchema({ mode: "config", text: "search_path=chitchat_old" }, "chitchat")).toBe(false);
});
