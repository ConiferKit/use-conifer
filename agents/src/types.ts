import type { Completion, Message } from "conifer-sdk";

export type NanoUsd = number;

/** The native tool contract. MCP tools are adapted into this shape. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /** Where this tool came from, for ToolLimitError attribution. */
  source?: string; // "native" | "plugin:<name>" | "subagent"
}

export interface ToolContext {
  signal?: AbortSignal;
  agentName: string;
  /** Fold a child run's aggregate into the current run's (subagent tools). */
  fold?: (child: AggregateReceipt) => void;
  /** The current run's event sink, so nested runs surface their events. */
  onEvent?: (e: RunEvent) => void;
}

export type RunEvent =
  | { type: "turn_start"; agent: string; turn: number }
  | { type: "model_response"; agent: string; turn: number; completion: Completion }
  | { type: "tool_call"; agent: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; agent: string; tool: string; result: string; isError: boolean }
  | { type: "subagent_start"; agent: string; subagent: string }
  | { type: "subagent_end"; agent: string; subagent: string; costNanoUsd: NanoUsd }
  | { type: "budget_warning"; agent: string; spentNanoUsd: NanoUsd; budgetNanoUsd: NanoUsd }
  | { type: "tool_surface_warning"; agent: string; count: number; cap: number }
  | { type: "run_end"; agent: string; turns: number; costNanoUsd: NanoUsd };

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

export interface RunResult {
  output: string;
  receipt: AggregateReceipt;
  turns: number;
  messages: Message[];
}

/** One gateway call's observed cost, in the tree. */
export interface CallRecord {
  agent: string;
  model: string;
  costNanoUsd?: NanoUsd;
  requestId?: string;
}

export interface AggregateReceipt {
  /** Sum of every settled call in this run's tree. */
  totalCostNanoUsd: NanoUsd;
  /** True when any call's cost was unknown (receipt missing). Total is then a floor. */
  incomplete: boolean;
  calls: CallRecord[];
}
