// receipts.ts — receipts for the client you ALREADY use.
//
// THE PROBLEM THIS SOLVES. The exact per-turn cost is the one thing Conifer has
// that other gateways do not, and it arrives on the RESPONSE HEADERS. Every
// mainstream client — `openai`, `@anthropic-ai/sdk`, LangChain, LiteLLM, the
// Vercel AI SDK — parses the JSON body and throws the headers away. So the
// moment someone points their existing client at Conifer (which is the whole
// point of being OpenAI-compatible), the differentiator becomes invisible.
//
// The old answer was "rewrite against @conifer/sdk". That is a bad trade to ask
// for on day one, and it is not even necessary: every one of those clients
// accepts an injected `fetch`. So this module hands them one that reads the
// receipt on the way past and gives it to you, leaving the response otherwise
// untouched.
//
//   const receipts = new ReceiptCollector();
//   const openai = new OpenAI({
//     baseURL: "https://api.conifer.build/v1",
//     apiKey: process.env.CONIFER_API_KEY,
//     fetch: receipts.fetch,
//   });
//   await openai.chat.completions.create({ ... });
//   receipts.total.costNanoUsd;   // exact, integer, itemized
//
// WHY THIS IS SAFE TO WRAP AROUND SOMEONE ELSE'S CLIENT. The wrapper never
// reads, buffers, or clones the response BODY. A `Response` body is a
// single-use stream: consuming it here would break streaming for the caller and
// double memory for everyone else. Headers are already fully materialized when
// the promise resolves, so reading them costs nothing and changes nothing. The
// exact same Response object is handed back.
//
// The gateway CORS-exposes every `x-conifer-*` header, so this works in a
// browser as well as on a server.

import { readReceipt, type Receipt } from "./receipt.ts";
import type { FetchLike } from "./transport.ts";

/** One turn's receipt, plus which door it came from. */
export interface ObservedReceipt extends Receipt {
  /** The URL that was called, so a mixed workload stays attributable. */
  url: string;
  /** When the response arrived, for correlating with your own logs. */
  at: Date;
}

/** A running total across every observed turn. */
export interface ReceiptTotal {
  /** Number of turns that disclosed a cost. */
  turns: number;
  /** Summed settled cost, in integer nanodollars. */
  costNanoUsd: number;
  /** The same number as an exact decimal USD string. */
  costUsd: string;
  /**
   * Summed counterfactual, over ONLY the turns that disclosed one.
   *
   * The gateway omits this header unless the routed predicate holds, so this is
   * a sum over a SUBSET and is not comparable to `costNanoUsd` as a savings
   * figure. `counterfactualTurns` is published beside it so the difference is
   * visible rather than implied.
   */
  counterfactualNanoUsd: number;
  counterfactualTurns: number;
}

/**
 * Collects the receipt from every response that carries one.
 *
 * Deliberately NOT a subclass of anything and not tied to a client: it is a
 * `fetch` in, a `fetch` out, which is the one extension point every HTTP client
 * in this ecosystem agrees on.
 */
export class ReceiptCollector {
  private readonly observed: ObservedReceipt[] = [];
  private readonly onReceipt?: (receipt: ObservedReceipt) => void;
  private readonly limit: number;
  private readonly underlying: FetchLike;

  /** Turns seen, including any dropped from `all` by the retention cap. */
  private seen = 0;
  private summed = 0;
  private summedCounterfactual = 0;
  private counterfactualTurns = 0;

  constructor(
    options: {
      /** Called as each receipt arrives. For metrics, logs, a budget guard. */
      onReceipt?: (receipt: ObservedReceipt) => void;
      /**
       * How many receipts to RETAIN in `all`. Default 1000.
       *
       * A long-lived process makes an unbounded array a slow leak, and the
       * running total is the part that actually matters, so the total is exact
       * forever while the retained list is a bounded tail. Set 0 to retain none
       * and rely on `onReceipt` plus `total`.
       */
      retain?: number;
      /** The fetch to wrap. Defaults to the global. */
      fetch?: FetchLike;
    } = {},
  ) {
    this.onReceipt = options.onReceipt;
    this.limit = options.retain ?? 1000;
    const base = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (base === undefined) {
      throw new Error(
        "ReceiptCollector needs a fetch: this runtime has no global one, so pass `fetch`.",
      );
    }
    this.underlying = base;
  }

  /**
   * The wrapped fetch. Pass this to your existing client.
   *
   * Bound as a property rather than a method so it survives being torn off the
   * instance — `fetch: receipts.fetch` is exactly how these clients take it, and
   * a plain method would lose `this` and fail at the first call.
   */
  readonly fetch: FetchLike = async (url, init) => {
    const response = await this.underlying(url, init);
    // Headers only. The body is a single-use stream and belongs to the caller:
    // reading it here would break their streaming and double everyone's memory.
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
    // Last, and isolated: a throwing callback is the CALLER's bug, and it must
    // not corrupt the total or, worse, fail their inference call. They already
    // paid for that turn.
    try {
      this.onReceipt?.(receipt);
    } catch {
      /* the callback's problem, not the request's */
    }
  }

  /** The retained receipts, oldest first. A bounded tail; see `retain`. */
  get all(): readonly ObservedReceipt[] {
    return this.observed;
  }

  /** The most recent receipt, which is what a one-shot script wants. */
  get last(): ObservedReceipt | undefined {
    return this.observed[this.observed.length - 1];
  }

  /**
   * The running total. EXACT over every turn ever seen, including any the
   * retention cap dropped from `all` — a spend figure that quietly stopped
   * counting would be worse than no figure at all.
   */
  get total(): ReceiptTotal {
    return {
      turns: this.seen,
      costNanoUsd: this.summed,
      costUsd: nanoToUsd(this.summed),
      counterfactualNanoUsd: this.summedCounterfactual,
      counterfactualTurns: this.counterfactualTurns,
    };
  }

  /** Forget the retained receipts AND reset the total. */
  reset(): void {
    this.observed.length = 0;
    this.seen = 0;
    this.summed = 0;
    this.summedCounterfactual = 0;
    this.counterfactualTurns = 0;
  }
}

/**
 * A hard spend ceiling across MANY turns, enforced client-side.
 *
 * `maxCostNanoUsd` is a per-request ceiling the gateway enforces. This is the
 * other question — "this whole job must not cost more than $5" — which no
 * single request can answer.
 *
 * Be precise about what this can and cannot do. It refuses the NEXT request
 * once the budget is spent; it cannot refund the one that crossed the line,
 * because the cost is only known after the turn settles. So the true worst case
 * is `budget + one turn`. Combine it with a per-request `maxCostNanoUsd` and
 * that overshoot is bounded rather than open-ended.
 */
export class SpendBudget {
  private readonly collector: ReceiptCollector;
  private readonly budgetNanoUsd: number;

  constructor(budgetNanoUsd: number, options: { fetch?: FetchLike } = {}) {
    if (!Number.isInteger(budgetNanoUsd) || budgetNanoUsd < 0) {
      throw new Error(
        "a spend budget is a non-negative INTEGER nanodollar amount ($1 = 1e9). Rounding a spend limit is the wrong direction half the time.",
      );
    }
    this.budgetNanoUsd = budgetNanoUsd;
    this.collector = new ReceiptCollector({ fetch: options.fetch, retain: 0 });
  }

  /** Nanodollars spent so far, as observed on real receipts. */
  get spentNanoUsd(): number {
    return this.collector.total.costNanoUsd;
  }

  /** Nanodollars left. Never negative. */
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
        `spend budget exhausted: ${nanoToUsd(this.spentNanoUsd)} USD spent against a ${nanoToUsd(this.budgetNanoUsd)} USD budget. This refusal is CLIENT-SIDE and happened before the request; the gateway was not called.`,
      );
    }
    return this.collector.fetch(url, init);
  };
}

/** Nanodollars -> an exact USD decimal string. Integer math only. */
function nanoToUsd(nano: number): string {
  const negative = nano < 0;
  const abs = Math.abs(nano);
  return `${negative ? "-" : ""}${Math.floor(abs / 1_000_000_000)}.${String(abs % 1_000_000_000).padStart(9, "0")}`;
}
