import { emptyAggregate } from "./receipts.ts";
import type { AggregateReceipt, NanoUsd } from "./types.ts";

export class AgentError extends Error {
  readonly receipt: AggregateReceipt;
  constructor(message: string, receipt?: AggregateReceipt) {
    super(message);
    this.name = new.target.name;
    this.receipt = receipt ?? emptyAggregate();
  }
}

export class BudgetExceededError extends AgentError {
  readonly budgetNanoUsd: NanoUsd;
  constructor(o: { budgetNanoUsd: NanoUsd; receipt: AggregateReceipt; agent: string }) {
    super(
      `agent "${o.agent}" exhausted its budget of ${o.budgetNanoUsd} nanoUSD ` +
      `(spent ${o.receipt.totalCostNanoUsd}${o.receipt.incomplete ? "+, some calls unsettled" : ""})`,
      o.receipt,
    );
    this.budgetNanoUsd = o.budgetNanoUsd;
  }
}

export class MaxTurnsError extends AgentError {
  readonly maxTurns: number;
  constructor(o: { maxTurns: number; receipt: AggregateReceipt; agent: string }) {
    super(`agent "${o.agent}" hit maxTurns (${o.maxTurns}) without a final answer`, o.receipt);
    this.maxTurns = o.maxTurns;
  }
}

export interface ToolSourceCount { source: string; count: number }

export class ToolLimitError extends AgentError {
  readonly count: number;
  readonly cap: number;
  readonly sources: ToolSourceCount[];
  constructor(o: { agent: string; count: number; cap: number; sources: ToolSourceCount[] }) {
    const breakdown = o.sources.map((s) => `${s.source}: ${s.count}`).join(", ");
    super(
      `agent "${o.agent}" has ${o.count} tools but the cap is ${o.cap} (${breakdown}). ` +
      `Scope plugins per-agent or set a toolAllowlist to shrink the surface.`,
    );
    this.count = o.count; this.cap = o.cap; this.sources = o.sources;
  }
}

export class PluginValidationError extends AgentError {
  /** JSON-pointer-ish paths into the manifest. */
  readonly problems: string[];
  constructor(o: { plugin: string; problems: string[] }) {
    super(`plugin "${o.plugin}" manifest invalid:\n  ${o.problems.join("\n  ")}`);
    this.problems = o.problems;
  }
}

export class McpConnectionError extends AgentError {
  constructor(o: { server: string; transport: string; cause: unknown }) {
    super(`MCP server "${o.server}" (${o.transport}) failed to connect: ${String(o.cause)}`);
    this.cause = o.cause;
  }
}
