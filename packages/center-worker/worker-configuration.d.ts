interface Env {
  WORKSPACE_COORDINATOR: import("./src/runtime-types").WorkspaceCoordinatorNamespace;
  LANEDECK_DB: D1Database;
  LANEDECK_BUCKET: R2Bucket;
}
