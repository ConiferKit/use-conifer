// `POST /v1/route`: the router's decision for a query, without a completion.

import type { RouteDecision, RoutePolicy, RouteRequest } from "./types.ts";

/** The JSON body for `POST /v1/route`. */
export function routeBody(request: RouteRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { query: request.query };
  if (request.policy !== undefined) body.policy = request.policy;
  if (request.candidates !== undefined) body.candidates = request.candidates;
  if (request.tools !== undefined) body.tools = request.tools;
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  return body;
}

/** The decision: a pick, its fallbacks, the policy, and the router version. */
export function toRouteDecision(data: Record<string, unknown>): RouteDecision {
  const fallbacks = Array.isArray(data.fallbacks)
    ? (data.fallbacks as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  return {
    model: String(data.model ?? ""),
    fallbacks,
    policy: (data.policy as RoutePolicy) ?? "balanced",
    routerVersion: String(data.router_version ?? ""),
    raw: data,
  };
}
