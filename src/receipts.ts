// Receipts for the client you already use. Every mainstream client accepts an
// injected `fetch`; this one reads the `x-conifer-*` headers on the way past
// and hands the response back untouched. The body is never read here.
//
//   const receipts = new ReceiptCollector();
//   const openai = new OpenAI({ baseURL, apiKey, fetch: receipts.fetch });
//   await openai.chat.completions.create({ ... });
//   receipts.total.costNanoUsd;

import { nanoUsdToUsdString, readReceipt, type Receipt } from "./receipt.ts";
import type { FetchLike } from "./transport.ts";

export interface ObservedReceipt extends Receipt {
  /** The URL that was called. */
  url: string;
  /** When the response arrived. */
  at: Date;
}

export interface ReceiptTotal {
  /** Turns that disclosed a cost. */
  turns: number;
  /** Summed settled cost, in integer nanodollars. */
  costNanoUsd: number;
  /** The same as an exact decimal USD string. */
  costUsd: string;
  /** Summed counterfactual over the turns that disclosed one; a subset, not a savings figure. */
  counterfactualNanoUsd: number;
  counterfactualTurns: number;
}

/** Collects the receipt from every response that carries one. */
export class ReceiptCollector {
  private readonly observed: ObservedReceipt[] = [];
  private readonly onReceipt?: (receipt: ObservedReceipt) => void;
  private readonly limit: number;
  private readonly underlying: FetchLike;
  private seen = 0;
  private summed = 0;
  private summedCounterfactual = 0;
  private counterfactualTurns = 0;

  constructor(
    options: {
      /** Called as each receipt arrives. */
      onReceipt?: (receipt: ObservedReceipt) => void;
      /** How many receipts to keep in `all`. Default 1000; 0 keeps none. The total is exact regardless. */
      retain?: number;
      /** The fetch to wrap. Defaults to the global. */
      fetch?: FetchLike;
    } = {},
  ) {
    this.onReceipt = options.onReceipt;
    this.limit = options.retain ?? 1000;
    const base = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (base === undefined) {
      throw new Error("ReceiptCollector needs a fetch: this runtime has no global one, so pass `fetch`.");
    }
    this.underlying = base;
  }

  /** The wrapped fetch. A property, not a method, so `fetch: receipts.fetch` keeps `this`. */
  readonly fetch: FetchLike = async (url, init) => {
    const response = await this.underlying(url, init);
    const receipt = readReceipt(response.headers);
    if (receipt.costNanoUsd !== undefined || receipt.effectiveModel !== undefined) {
      this.record({ ...receipt, url: String(url), at: new Date() });
    }
    return response;
  };

  private record(receipt: ObservedReceipt): void {
    this.seen += 1;
    if (receipt.costNanoUsd !== undefined) this.summed += receipt.costNanoUsd;
    if (receipt.counterfactualNanoUsd !== undefined) {
      this.summedCounterfactual += receipt.counterfactualNanoUsd;
      this.counterfactualTurns += 1;
    }
    if (this.limit > 0) {
      this.observed.push(receipt);
      if (this.observed.length > this.limit) this.observed.shift();
    }
    // A throwing callback must not fail a turn the caller already paid for.
    try {
      this.onReceipt?.(receipt);
    } catch {
      /* the callback's problem */
    }
  }

  /** The retained receipts, oldest first. */
  get all(): readonly ObservedReceipt[] {
    return this.observed;
  }

  get last(): ObservedReceipt | undefined {
    return this.observed[this.observed.length - 1];
  }

  /** The running total over every turn seen, including any dropped from `all`. */
  get total(): ReceiptTotal {
    return {
      turns: this.seen,
      costNanoUsd: this.summed,
      costUsd: nanoUsdToUsdString(this.summed),
      counterfactualNanoUsd: this.summedCounterfactual,
      counterfactualTurns: this.counterfactualTurns,
    };
  }

  /** Forget the retained receipts and reset the total. */
  reset(): void {
    this.observed.length = 0;
    this.seen = 0;
    this.summed = 0;
    this.summedCounterfactual = 0;
    this.counterfactualTurns = 0;
  }
}

/**
 * A spend ceiling across many turns, enforced client-side. It refuses the
 * next request once the budget is spent; the worst case is budget plus one
 * turn, which a per-request `maxCostNanoUsd` bounds.
 */
export class SpendBudget {
  private readonly collector: ReceiptCollector;
  private readonly budgetNanoUsd: number;

  constructor(budgetNanoUsd: number, options: { fetch?: FetchLike } = {}) {
    if (!Number.isInteger(budgetNanoUsd) || budgetNanoUsd < 0) {
      throw new Error("a spend budget is a non-negative INTEGER nanodollar amount ($1 = 1e9).");
    }
    this.budgetNanoUsd = budgetNanoUsd;
    this.collector = new ReceiptCollector({ fetch: options.fetch, retain: 0 });
  }

  get spentNanoUsd(): number {
    return this.collector.total.costNanoUsd;
  }

  /** Never negative. */
  get remainingNanoUsd(): number {
    return Math.max(0, this.budgetNanoUsd - this.spentNanoUsd);
  }

  get exhausted(): boolean {
    return this.spentNanoUsd >= this.budgetNanoUsd;
  }

  /** The wrapped fetch: refuses once the budget is gone, then observes. */
  readonly fetch: FetchLike = async (url, init) => {
    if (this.exhausted) {
      throw new Error(
        `spend budget exhausted: ${nanoUsdToUsdString(this.spentNanoUsd)} USD spent against a ${nanoUsdToUsdString(this.budgetNanoUsd)} USD budget. This refusal is CLIENT-SIDE; the gateway was not called.`,
      );
    }
    return this.collector.fetch(url, init);
  };
}
