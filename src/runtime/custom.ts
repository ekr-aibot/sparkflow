import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";

export class CustomAdapter implements RuntimeAdapter {
  async run(_ctx: RuntimeContext): Promise<RuntimeResult> {
    throw new Error("Custom runtime adapter is not yet implemented");
  }
}
