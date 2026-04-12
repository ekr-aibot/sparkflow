import type { SandboxBackend } from "./types.js";
import { LocalBackend } from "./local.js";
import { DockerBackend } from "./docker.js";

export * from "./types.js";
export { LocalBackend } from "./local.js";
export { DockerBackend } from "./docker.js";

export function defaultSandboxBackends(): Map<string, SandboxBackend> {
  return new Map<string, SandboxBackend>([
    ["local", new LocalBackend()],
    ["docker", new DockerBackend()],
  ]);
}
