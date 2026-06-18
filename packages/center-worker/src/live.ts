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
  private readonly agentMachines = new Map<LiveSocket, string>();
  private readonly browsers = new Set<LiveSocket>();

  addAgent(socket: LiveSocket, machineId = "machine.local"): void {
    this.agents.add(socket);
    this.agentMachines.set(socket, machineId);
  }

  addBrowser(socket: LiveSocket): void {
    this.browsers.add(socket);
  }

  remove(socket: LiveSocket): void {
    this.agents.delete(socket);
    this.agentMachines.delete(socket);
    this.browsers.delete(socket);
  }

  broadcastToBrowsers(message: BrowserLiveMessage): number {
    return this.sendTo(this.browsers, message);
  }

  sendToAgents(message: AgentControlMessage): number {
    return this.sendTo(this.agents, message);
  }

  sendToMachineAgent(machineId: string, message: AgentControlMessage): number {
    const encoded = JSON.stringify(message);
    for (const socket of this.agents) {
      if (this.agentMachines.get(socket) !== machineId) {
        continue;
      }
      if (this.sendOne(socket, encoded) === 1) {
        return 1;
      }
    }
    return 0;
  }

  sendToAgent(socket: LiveSocket, message: AgentControlMessage): number {
    return this.sendOne(socket, JSON.stringify(message));
  }

  private sendTo(
    sockets: Set<LiveSocket>,
    message: BrowserLiveMessage | AgentControlMessage,
  ): number {
    const encoded = JSON.stringify(message);
    let delivered = 0;

    for (const socket of sockets) {
      delivered += this.sendOne(socket, encoded);
    }

    return delivered;
  }

  private sendOne(socket: LiveSocket, encoded: string): number {
    try {
      socket.send(encoded);
      return 1;
    } catch {
      this.remove(socket);
      return 0;
    }
  }
}

export function restoreLiveSockets(
  live: LiveHub,
  agents: Iterable<LiveSocket>,
  browsers: Iterable<LiveSocket>,
): void {
  for (const socket of agents) {
    live.addAgent(socket, machineIdFromSocket(socket));
  }

  for (const socket of browsers) {
    live.addBrowser(socket);
  }
}

function machineIdFromSocket(socket: LiveSocket): string {
  const maybeSocket = socket as LiveSocket & {
    deserializeAttachment?: () => unknown;
  };
  const attachment = maybeSocket.deserializeAttachment?.();
  if (
    typeof attachment === "object" &&
    attachment !== null &&
    "machineId" in attachment &&
    typeof attachment.machineId === "string" &&
    attachment.machineId.length > 0
  ) {
    return attachment.machineId;
  }

  return "machine.local";
}
