// `POST /v1/embeddings`: the same receipts and spend ceiling as chat.

import { costCeiling, turnIdentity, withCost } from "./chat.ts";
import { ConiferPortabilityError } from "./errors.ts";
import { readReceipt } from "./receipt.ts";
import type { Transport } from "./transport.ts";
import type { Completion, EmbeddingsRequest, EmbeddingsResponse } from "./types.ts";

/** Reached as `conifer.embeddings.create(...)`, the shape OpenAI clients use. */
export class Embeddings {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * One embeddings call with its settled cost. Vectors are requested as
   * base64 float32 (about a third of the JSON size) and decoded to numbers;
   * pass `encodingFormat: "float"` to receive JSON floats instead.
   */
  async create(request: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    if (Array.isArray(request.input) && request.input.some((item) => typeof item !== "string")) {
      throw new ConiferPortabilityError(
        "input",
        "embeddings input must be text (a string, or an array of strings). Token-id arrays are refused.",
      );
    }
    const { data, response } = await this.transport.request({
      method: "POST",
      path: "/v1/embeddings",
      body: embeddingsBody(request),
      headers: embeddingsHeaders(request, turnIdentity(request)),
      signal: request.signal,
    });
    const payload = (data ?? {}) as Record<string, unknown>;
    const entries = (payload.data ?? []) as Record<string, unknown>[];
    const receipt = readReceipt(response.headers);
    return {
      object: payload.object as string | undefined,
      model: payload.model as string | undefined,
      data: entries.map((entry, position) => ({
        ...entry,
        index: typeof entry.index === "number" ? entry.index : position,
        embedding: decodeVector(entry.embedding),
      })),
      usage: withCost(payload.usage as Completion["usage"], receipt),
      receipt,
      raw: payload,
    };
  }
}

/** The JSON body for `POST /v1/embeddings`. */
export function embeddingsBody(request: EmbeddingsRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.input,
    encoding_format: request.encodingFormat ?? "base64",
  };
  if (request.dimensions !== undefined) body.dimensions = request.dimensions;
  if (request.user !== undefined) body.user = request.user;
  return { ...body, ...(request.extraBody ?? {}) };
}

/** The request headers for one embeddings call. */
export function embeddingsHeaders(request: EmbeddingsRequest, idempotencyKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...(request.headers ?? {}),
    "idempotency-key": idempotencyKey,
  };
  if (request.maxCostNanoUsd !== undefined) headers["x-conifer-max-cost-nanousd"] = costCeiling(request.maxCostNanoUsd);
  if (request.requestId !== undefined) headers["x-request-id"] = request.requestId;
  if (request.client !== undefined) headers["x-conifer-client"] = request.client;
  return headers;
}

/**
 * A vector as numbers from either wire encoding. Base64 is little-endian
 * float32. An unrecognised shape yields an empty vector rather than a guess.
 */
export function decodeVector(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== "string") return [];
  const bytes = base64ToBytes(value);
  if (bytes.length === 0 || bytes.length % 4 !== 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<number>(bytes.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  const buffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (buffer !== undefined) return new Uint8Array(buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
