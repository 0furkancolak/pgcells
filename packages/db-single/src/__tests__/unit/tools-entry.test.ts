import { expect, test } from "bun:test";
import { commandNames } from "../../core/cli";
import * as tools from "../../tools";

test("the tools entry exposes the backup, doctor, pull, replica and Neon helpers the CLI wraps", () => {
  expect(Object.keys(tools).sort()).toEqual([
    "backupSchema", "doctor", "exportAt", "exportSchema", "neonApi", "pruneBackups", "pullSchema", "replicaReport", "restoreSchema", "safetyPoint", "stageCopy", "supabaseSafetyPoint",
  ]);
});

test("the CLI knows every documented operation", () => {
  expect(commandNames().sort()).toEqual([
    "auth generate", "backup", "backup prune", "doctor", "export", "migrate", "migrate-down", "migration baseline", "migration create", "migration-status",
    "neon export", "neon stage-copy", "pull", "replicas", "restore", "seed", "seed create",
  ]);
});
