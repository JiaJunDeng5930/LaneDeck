import type { AgentControlMessage, JsonObject } from "@lanedeck/protocol";

export interface LiveSocket {
  send(message: string): void;
  close?(code?: number, reason?: string): void;
}

export type BrowserLiveMessage =
  | {
      type: "ingest_committed";
      workspaceId: string;
      batchId: string;
      acceptedFrameCount: number;
    }
  | {
      type: "content_changed";
      workspaceId: string;
      mutationId: string;
      contentRevision: string;
    }
  | {
      type: "lane_settings_changed";
      workspaceId: string;
      mutationId: string;
      laneId: string;
      laneRevision: string;
    }
  | {
      type: "workspace_alarm";
      workspaceId: string;
      state: JsonObject;
    };

export class LiveHub {
  private readonly agents = new Set<LiveSocket>();
  private readonly browsers = new Set<LiveSocket>();

  addAgent(socket: LiveSocket): void {
    this.agents.add(socket);
  }

  addBrowser(socket: LiveSocket): void {
    this.browsers.add(socket);
  }

  remove(socket: LiveSocket): void {
    this.agents.delete(socket);
    this.browsers.delete(socket);
  }

  broadcastToBrowsers(message: BrowserLiveMessage): number {
    return this.sendTo(this.browsers, message);
  }

  sendToAgents(message: AgentControlMessage): number {
    return this.sendTo(this.agents, message);
  }

  private sendTo(
    sockets: Set<LiveSocket>,
    message: BrowserLiveMessage | AgentControlMessage,
  ): number {
    const encoded = JSON.stringify(message);
    let delivered = 0;

    for (const socket of sockets) {
      try {
        socket.send(encoded);
        delivered += 1;
      } catch {
        sockets.delete(socket);
      }
    }

    return delivered;
  }
}

export function restoreLiveSockets(
  live: LiveHub,
  agents: Iterable<LiveSocket>,
  browsers: Iterable<LiveSocket>,
): void {
  for (const socket of agents) {
    live.addAgent(socket);
  }

  for (const socket of browsers) {
    live.addBrowser(socket);
  }
}
