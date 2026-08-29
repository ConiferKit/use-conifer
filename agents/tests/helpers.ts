// helpers.ts — shared test doubles. fakeClient scripts a sequence of chat
// replies (text or tool calls) and records every request it receives.

export type Reply = { text?: string; toolCalls?: { name: string; args: unknown }[]; costNanoUsd?: number };

export function fakeClient(replies: Reply[]) {
  let i = 0;
  const requests: any[] = [];
  return {
    requests,
    async chat(req: any) {
      requests.push(req);
      const r = replies[Math.min(i++, replies.length - 1)]!;
      const message: any = { role: "assistant", content: r.text ?? null };
      if (r.toolCalls) message.tool_calls = r.toolCalls.map((tc, j) => ({
        id: `call_${i}_${j}`, type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
      return {
        id: "resp_x", model: req.model, object: "chat.completion",
        choices: [{ index: 0, finish_reason: r.toolCalls ? "tool_calls" : "stop", message }],
        receipt: { costNanoUsd: r.costNanoUsd ?? 1_000_000 },
      };
    },
  } as any;
}
