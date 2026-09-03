// Bring-your-own-key custody: your provider keys, held by the gateway.

import type { Transport } from "./transport.ts";

export class KeysApi {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** `GET /v1/keys`: metadata only, never the key material. */
  async list(): Promise<unknown> {
    const { data } = await this.transport.request({ method: "GET", path: "/v1/keys" });
    return data;
  }

  /** `PUT /v1/keys/{provider}`: store or replace a provider key. */
  async put(provider: string, apiKey: string, baseUrl?: string): Promise<unknown> {
    const { data } = await this.transport.request({
      method: "PUT",
      path: `/v1/keys/${encodeURIComponent(provider)}`,
      body: baseUrl === undefined ? { api_key: apiKey } : { api_key: apiKey, base_url: baseUrl },
    });
    return data;
  }

  /** `DELETE /v1/keys/{provider}`. */
  async remove(provider: string): Promise<unknown> {
    const { data } = await this.transport.request({
      method: "DELETE",
      path: `/v1/keys/${encodeURIComponent(provider)}`,
    });
    return data;
  }
}
