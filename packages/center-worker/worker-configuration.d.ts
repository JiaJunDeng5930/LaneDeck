interface Env {
  WORKSPACE_COORDINATOR: DurableObjectNamespace<
    import("./src/index").WorkspaceCoordinator
  >;
  LANEDECK_DB: D1Database;
  LANEDECK_BUCKET: R2Bucket;
}
