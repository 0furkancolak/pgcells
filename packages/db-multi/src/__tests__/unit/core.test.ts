import { describe, expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { AppError } from "../../core/errors";
import {
  normalizeTenantId,
  tenantFromHost,
  tenantSchema,
  tenantSchemas,
  validateSchema,
  validateTenantId,
} from "../../core/tenants/model";

describe("configuration and identifiers", () => {
  test("derives database identity from position", () => {
    expect(createConfig(["postgres://runtime"]).nodes).toEqual([
      { id: "db0", url: "postgres://runtime", replicas: [] },
    ]);
  });
  test("accepts explicit database ids in any order and sorts them", () => {
    const config = createConfig("db2=postgres://c, db0=postgres://a,db1=postgres://b", "db2=postgres://r");
    expect(config.nodes.map((node) => [node.id, node.url, node.replicas])).toEqual([
      ["db0", "postgres://a", []],
      ["db1", "postgres://b", []],
      ["db2", "postgres://c", ["postgres://r"]],
    ]);
    expect(createConfig(["db0=postgres://a", "db5=postgres://f"]).nodes.map((node) => node.id)).toEqual(["db0", "db5"]);
    expect(createConfig(["db0=postgres://a?x=y=z"]).nodes[0]?.url).toBe("postgres://a?x=y=z");
  });
  test("rejects mixed, duplicate, platform-less and malformed explicit ids", () => {
    for (const bad of [
      "postgres://a,db1=postgres://b", // mixed forms
      "db0=postgres://a,db0=postgres://b", // duplicate id
      "db1=postgres://a,db2=postgres://b", // no db0
      "db0=postgres://a,db1=postgres://a", // duplicate url
      "db0=postgres://a,db01=postgres://b", // not a database id
      "db0=postgres://a,db100=postgres://b",
      "db0=mysql://a",
    ])
      expect(() => createConfig(bad), bad).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => createConfig("db0=postgres://secret-host")).not.toThrow();
    try {
      createConfig("db1=postgres://secret-host");
    } catch (error) {
      expect(String(error)).not.toContain("secret-host");
    }
  });
  test("rejects malformed configuration", () =>
    expect(() => createConfig("x")).toThrow(AppError));

  test("tenant ids are single lowercase subdomain labels", () => {
    const long = `a${"b".repeat(55)}`;
    for (const id of ["abc", "shop-acme", "mw-1a2b3c4d", "a1b", "a-b-c", long]) expect(validateTenantId(id), id).toBe(id);
    for (const id of [
      "Ab", "ab", "ABC", "1abc", "a_b", "a--b", "abc.def", "-abc", "abc-", "xn--bcher-kva", "acme.com", "bad/id", "", " abc", "bücher",
      `${long}c`,
    ])
      expect(() => validateTenantId(id), id).toThrow(expect.objectContaining({ code: "INVALID_TENANT_ID" }));
    expect(normalizeTenantId("  ABC ")).toBe("abc");
    expect(normalizeTenantId("Shop-Acme")).toBe("shop-acme");
    expect(() => normalizeTenantId("abc.")).toThrow(expect.objectContaining({ code: "INVALID_TENANT_ID" }));
  });

  test("Host header helper strips the port and one trailing dot, lowercases and requires <id>.<root>", () => {
    expect(tenantFromHost("ABC.example.com:443", "example.com")).toBe("abc");
    expect(tenantFromHost("shop-acme.example.com.", "example.com")).toBe("shop-acme");
    expect(tenantFromHost("abc.localhost:3000", ["example.com", "localhost"])).toBe("abc");
    for (const host of [
      null, undefined, "", "example.com", "localhost:3000", "[::1]:3000", "10.0.0.1:80", "x.y.example.com",
      "abc.other.com", "ab.example.com", "a_b.example.com", "abc.example.com:80:80", "abcexample.com",
    ])
      expect(() => tenantFromHost(host, "example.com"), String(host)).toThrow(expect.objectContaining({ code: "INVALID_TENANT_ID" }));
  });

  test("schema names are the kind prefix plus the id with - replaced by _, within 63 bytes", () => {
    expect(tenantSchema("abc")).toBe("tenant_abc");
    expect(tenantSchema("abc-shop")).toBe("tenant_abc_shop");
    expect(tenantSchema("abc-shop", "demo")).toBe("demo_abc_shop");
    expect(tenantSchemas("abc-shop")).toEqual(["tenant_abc_shop", "demo_abc_shop"]);
    const long = `a${"b".repeat(55)}`;
    expect(tenantSchema(long)).toBe(`tenant_${long}`);
    expect(tenantSchema(long).length).toBe(63);
    expect(() => tenantSchema(`${long}c`)).toThrow(expect.objectContaining({ code: "INVALID_TENANT_ID" }));
    for (const id of ["abc", "a-b-c", long]) expect(validateSchema(tenantSchema(id, "demo"))).toBe(tenantSchema(id, "demo"));
    expect(() => tenantSchema("Abc")).toThrow(expect.objectContaining({ code: "INVALID_TENANT_ID" }));
  });

  test("rejects unsafe schemas", () => {
    for (const schema of ["public", "tenant_", "tenant_A", 'tenant_a"b', `tenant_${"a".repeat(57)}`, "platform"])
      expect(() => validateSchema(schema), schema).toThrow();
  });
});
