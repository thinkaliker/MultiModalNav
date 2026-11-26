// The upstream request queue for MultiModalNav. One Durable Object instance ("global") sees
// every TomTom and Transitous request from every client, so it can hold them in a
// first-come-first-served queue with a cap on how many run at once. The Pages Functions reach
// it through their GATE binding; it has no public URL.

import { DurableObject } from 'cloudflare:workers';
import { GateCore, type GateJob } from '../../functions/_lib/upstream-common';

export class UpstreamGate extends DurableObject {
  private core = new GateCore();

  async fetch(request: Request): Promise<Response> {
    return this.core.handle((await request.json()) as GateJob);
  }
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
} satisfies ExportedHandler;
