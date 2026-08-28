import test from "node:test";
import assert from "node:assert/strict";
import { BudgetExceededError, MaxTurnsError, ToolLimitError } from "../src/errors.ts";
import { emptyAggregate } from "../src/receipts.ts";

test("BudgetExceededError carries the aggregate receipt and names the budget", () => {
  const agg = emptyAggregate();
  agg.totalCostNanoUsd = 4_000_000;
  const err = new BudgetExceededError({ budgetNanoUsd: 5_000_000, receipt: agg, agent: "researcher" });
  assert.equal(err.name, "BudgetExceededError");
  assert.equal(err.receipt.totalCostNanoUsd, 4_000_000);
  assert.match(err.message, /5000000/);
  assert.match(err.message, /researcher/);
});

test("ToolLimitError names agent, count, cap, and per-source attribution", () => {
  const err = new ToolLimitError({
    agent: "orchestrator", count: 173, cap: 128,
    sources: [{ source: "plugin:github", count: 92 }, { source: "native", count: 81 }],
  });
  assert.match(err.message, /orchestrator/);
  assert.match(err.message, /173/);
  assert.match(err.message, /128/);
  assert.match(err.message, /plugin:github: 92/);
});

test("MaxTurnsError carries turns and receipt", () => {
  const err = new MaxTurnsError({ maxTurns: 12, receipt: emptyAggregate(), agent: "a" });
  assert.match(err.message, /12/);
});
