import { readFileSync } from "node:fs";

const fullE2EEnabled = process.env.LANEDECK_E2E_FULL === "1";

if (!fullE2EEnabled) {
  process.exit(0);
}

const fixture = readFixture();
const capabilities = {
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
const required = requiredCapabilities(process.argv.slice(2));

const missing = required
  .filter(
    (fixtureName) =>
      !process.env[capabilities[fixtureName]] && !fixture[fixtureName],
  )
  .map((fixtureName) => capabilities[fixtureName]);

if (missing.length > 0) {
  console.error(`LaneDeck full e2e harness requires ${missing.join(", ")}.`);
  process.exit(1);
}

if (required.includes("shellContentBaseUrl")) {
  validateShellContentBaseUrl(
    process.env.LANEDECK_SHELL_CONTENT_BASE_URL ?? fixture.shellContentBaseUrl,
  );
}

function readFixture() {
  const fixturePath = process.env.LANEDECK_E2E_FIXTURE;
  if (fixturePath === undefined || fixturePath === "") {
    return {};
  }

  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function requiredCapabilities(args) {
  const selectedSpecs = args.filter(isSpecSelector);
  if (selectedSpecs.length === 0) {
    return Object.keys(capabilities);
  }

  const required = new Set();
  for (const spec of selectedSpecs) {
    if (spec.includes("agent-to-center-flow")) {
      required.add("workspaceId");
      required.add("agentSourceInputUrl");
      required.add("centerHttpUrl");
      required.add("shellHttpUrl");
      required.add("shellContentBaseUrl");
      required.add("shellContentArtifactWriteUrl");
      required.add("liveWsUrl");
      required.add("agentSpoolObservationUrl");
      required.add("readToken");
      required.add("aiMutationToken");
      required.add("agentToken");
    }

    if (spec.includes("content-mutation-flow")) {
      required.add("workspaceId");
      required.add("centerHttpUrl");
      required.add("shellHttpUrl");
      required.add("shellContentBaseUrl");
      required.add("shellContentArtifactWriteUrl");
      required.add("aiMutationToken");
      required.add("agentToken");
    }
  }

  return required.size > 0 ? [...required] : Object.keys(capabilities);
}

function validateShellContentBaseUrl(value) {
  const url = new URL(value);
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname === "lanedeck.localhost"
  ) {
    return;
  }
  console.error(
    "LANEDECK_SHELL_CONTENT_BASE_URL must be an http(s) URL on lanedeck.localhost so shell can share center read access with trusted e2e content.",
  );
  process.exit(1);
}

function isSpecSelector(arg) {
  return (
    !arg.startsWith("-") &&
    (arg.includes("e2e/specs/") ||
      arg.includes("agent-to-center-flow") ||
      arg.includes("content-mutation-flow") ||
      arg.endsWith(".spec.ts"))
  );
}
