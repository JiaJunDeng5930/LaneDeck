import { DurableObject } from "cloudflare:workers";
import { protocolPackage } from "@lanedeck/protocol";

export class WorkspaceCoordinator extends DurableObject<Env> {
  async ping(): Promise<{ ok: true; protocol: string }> {
    return { ok: true, protocol: protocolPackage };
  }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: "lanedeck-center" });
  },
} satisfies ExportedHandler<Env>;
