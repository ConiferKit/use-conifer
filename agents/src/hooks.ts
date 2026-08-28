// hooks.ts — lifecycle hooks for Agent runs. A HookSet observes or shapes a
// run: sessionStart before turn 1, preToolCall/postToolCall around every
// dispatched tool, sessionEnd just before the RunResult returns.
// preToolCall may rewrite arguments or block the call outright.

import type { RunResult } from "./types.ts";

/** What a preToolCall hook may return: block the call, or rewrite its args. */
export interface PreToolCallResult {
  /** When set, the tool does not execute; the result becomes `Blocked by hook: <reason>` with isError. */
  block?: string;
  /** When set, replaces the arguments passed to the tool (and later hooks). */
  args?: Record<string, unknown>;
}

export interface HookSet {
  preToolCall?: (h: { agent: string; tool: string; args: Record<string, unknown> })
    => Promise<PreToolCallResult | void> | (PreToolCallResult | void);
  postToolCall?: (h: {
    agent: string; tool: string; args: Record<string, unknown>; result: string; isError: boolean;
  }) => Promise<void> | void;
  sessionStart?: (h: { agent: string; input: string }) => Promise<void> | void;
  sessionEnd?: (h: { agent: string; result: RunResult }) => Promise<void> | void;
}

/**
 * Fold multiple HookSets into one, running each in order. For preToolCall the
 * first block wins and stops the chain; args rewrites accumulate, so later
 * hooks see earlier rewrites. Other hooks simply run in sequence.
 */
export function mergeHooks(sets: HookSet[]): HookSet {
  return {
    preToolCall: async (h) => {
      let args = h.args;
      let rewritten = false;
      for (const set of sets) {
        if (!set.preToolCall) continue;
        const out = await set.preToolCall({ ...h, args });
        if (out?.block !== undefined) return { block: out.block, ...(rewritten || out.args ? { args: out.args ?? args } : {}) };
        if (out?.args) { args = out.args; rewritten = true; }
      }
      return rewritten ? { args } : undefined;
    },
    postToolCall: async (h) => {
      for (const set of sets) await set.postToolCall?.(h);
    },
    sessionStart: async (h) => {
      for (const set of sets) await set.sessionStart?.(h);
    },
    sessionEnd: async (h) => {
      for (const set of sets) await set.sessionEnd?.(h);
    },
  };
}
