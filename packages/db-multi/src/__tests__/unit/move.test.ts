import { expect, test } from "bun:test";
import { resumeMove, rollbackMove, startMove } from "../../core/tools/move";

test("moving requires an explicit drained-writers maintenance window before DB access", async () => {
  const app = {} as never;
  for (const attempt of [startMove(app, "tenant", "db"), resumeMove(app, "id"), rollbackMove(app, "id")])
    await expect(attempt).rejects.toMatchObject({ code: "MAINTENANCE_REQUIRED" });
});
