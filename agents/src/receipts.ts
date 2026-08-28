import type { AggregateReceipt, CallRecord } from "./types.ts";

export function emptyAggregate(): AggregateReceipt {
  return { totalCostNanoUsd: 0, incomplete: false, calls: [] };
}

export function recordCall(agg: AggregateReceipt, call: CallRecord): void {
  agg.calls.push(call);
  if (call.costNanoUsd === undefined) agg.incomplete = true;
  else agg.totalCostNanoUsd += call.costNanoUsd;
}

/** Fold a child run's aggregate into the parent's (subagent receipts). */
export function foldAggregate(parent: AggregateReceipt, child: AggregateReceipt): void {
  for (const call of child.calls) parent.calls.push(call);
  parent.totalCostNanoUsd += child.totalCostNanoUsd;
  parent.incomplete = parent.incomplete || child.incomplete;
}
