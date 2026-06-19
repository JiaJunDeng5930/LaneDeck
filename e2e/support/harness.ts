import { readFileSync } from "node:fs";

export interface LaneDeckE2EHarness {
  workspaceId?: string;
  agentSourceInputUrl?: string;
  centerHttpUrl?: string;
  shellHttpUrl?: string;
  shellContentBaseUrl?: string;
  shellContentArtifactWriteUrl?: string;
  liveWsUrl?: string;
  agentSpoolObservationUrl?: string;
  readToken?: string;
  aiMutationToken?: string;
  agentToken?: string;
}

export type HarnessCapability = keyof LaneDeckE2EHarness;

export interface HarnessReadiness {
  harness: LaneDeckE2EHarness;
  skip: boolean;
  reason: string;
}

const capabilityLabels: Record<HarnessCapability, string> = {
  workspaceId: "LANEDECK_WORKSPACE_ID",
  agentSourceInputUrl: "LANEDECK_AGENT_SOURCE_INPUT_URL",
  centerHttpUrl: "LANEDECK_CENTER_HTTP_URL",
  shellHttpUrl: "LANEDECK_SHELL_HTTP_URL",
  shellContentBaseUrl: "LANEDECK_SHELL_CONTENT_BASE_URL",
  shellContentArtifactWriteUrl: "LANEDECK_SHELL_CONTENT_ARTIFACT_WRITE_URL",
  liveWsUrl: "LANEDECK_LIVE_WS_URL",
  agentSpoolObservationUrl: "LANEDECK_AGENT_SPOOL_OBSERVATION_URL",
  readToken: "LANEDECK_READ_TOKEN",
  aiMutationToken: "LANEDECK_AI_MUTATION_TOKEN",
  agentToken: "LANEDECK_AGENT_TOKEN",
};

export function readHarnessReadiness(
  required: readonly HarnessCapability[],
): HarnessReadiness {
  const fullE2EEnabled = process.env.LANEDECK_E2E_FULL === "1";

  if (!fullE2EEnabled) {
    return {
      harness: {},
      skip: true,
      reason: "LaneDeck full e2e harness is inactive; set LANEDECK_E2E_FULL=1.",
    };
  }

  const harness = readHarness();
  const missing = required.filter((capability) => !harness[capability]);
  if (missing.length > 0) {
    throw new Error(
      `LaneDeck full e2e harness requires ${missing
        .map((capability) => capabilityLabels[capability])
        .join(", ")}.`,
    );
  }
  if (required.includes("shellContentBaseUrl")) {
    validateShellContentBaseUrl(harness.shellContentBaseUrl);
  }

  return {
    harness,
    skip: false,
    reason: "LaneDeck full e2e harness is ready.",
  };
}

export function apiUrl(baseUrl: string, pathname: string): string {
  return new URL(pathname, withTrailingSlash(baseUrl)).toString();
}

export function urlWithQuery(
  baseUrl: string,
  query: Record<string, string>,
): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function bearerHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function readHarness(): LaneDeckE2EHarness {
  const fixture = readFixtureFile();

  return {
    workspaceId: process.env.LANEDECK_WORKSPACE_ID ?? fixture.workspaceId,
    agentSourceInputUrl:
      process.env.LANEDECK_AGENT_SOURCE_INPUT_URL ??
      fixture.agentSourceInputUrl,
    centerHttpUrl:
      process.env.LANEDECK_CENTER_HTTP_URL ?? fixture.centerHttpUrl,
    shellHttpUrl: process.env.LANEDECK_SHELL_HTTP_URL ?? fixture.shellHttpUrl,
    shellContentBaseUrl:
      process.env.LANEDECK_SHELL_CONTENT_BASE_URL ??
      fixture.shellContentBaseUrl,
    shellContentArtifactWriteUrl:
      process.env.LANEDECK_SHELL_CONTENT_ARTIFACT_WRITE_URL ??
      fixture.shellContentArtifactWriteUrl,
    liveWsUrl: process.env.LANEDECK_LIVE_WS_URL ?? fixture.liveWsUrl,
    agentSpoolObservationUrl:
      process.env.LANEDECK_AGENT_SPOOL_OBSERVATION_URL ??
      fixture.agentSpoolObservationUrl,
    readToken: process.env.LANEDECK_READ_TOKEN ?? fixture.readToken,
    aiMutationToken:
      process.env.LANEDECK_AI_MUTATION_TOKEN ?? fixture.aiMutationToken,
    agentToken: process.env.LANEDECK_AGENT_TOKEN ?? fixture.agentToken,
  };
}

function readFixtureFile(): LaneDeckE2EHarness {
  const fixturePath = process.env.LANEDECK_E2E_FIXTURE;
  if (fixturePath === undefined || fixturePath === "") {
    return {};
  }

  return JSON.parse(readFileSync(fixturePath, "utf8")) as LaneDeckE2EHarness;
}

function withTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function validateShellContentBaseUrl(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  const url = new URL(value);
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname === "lanedeck.localhost"
  ) {
    return;
  }
  throw new Error(
    "LANEDECK_SHELL_CONTENT_BASE_URL must be an http(s) URL on lanedeck.localhost so shell can share center read access with trusted e2e content.",
  );
}
