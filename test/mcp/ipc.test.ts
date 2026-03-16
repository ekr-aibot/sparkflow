import { describe, it, expect, afterEach } from "vitest";
import { IpcServer, IpcClient, type IpcMessage } from "../../src/mcp/ipc.js";

describe("IPC", () => {
  let server: IpcServer | null = null;
  let client: IpcClient | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    await server?.close();
    server = null;
  });

  it("round-trips a request and response", async () => {
    server = new IpcServer();
    server.onRequest(async (msg) => ({
      type: "response",
      id: msg.id,
      payload: { echo: msg.payload.data },
    }));
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const response = await client.request({
      type: "test",
      id: "req-1",
      payload: { data: "hello" },
    });

    expect(response.type).toBe("response");
    expect(response.id).toBe("req-1");
    expect(response.payload.echo).toBe("hello");
  });

  it("handles multiple sequential requests", async () => {
    server = new IpcServer();
    let count = 0;
    server.onRequest(async (msg) => {
      count++;
      return {
        type: "response",
        id: msg.id,
        payload: { count },
      };
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const r1 = await client.request({
      type: "test",
      id: "req-1",
      payload: {},
    });
    const r2 = await client.request({
      type: "test",
      id: "req-2",
      payload: {},
    });

    expect(r1.payload.count).toBe(1);
    expect(r2.payload.count).toBe(2);
  });

  it("handles concurrent requests from multiple clients", async () => {
    server = new IpcServer();
    server.onRequest(async (msg) => {
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      return {
        type: "response",
        id: msg.id,
        payload: { from: msg.payload.from },
      };
    });
    await server.listen();

    const client1 = new IpcClient(server.path);
    const client2 = new IpcClient(server.path);
    await Promise.all([client1.connect(), client2.connect()]);

    const [r1, r2] = await Promise.all([
      client1.request({ type: "test", id: "c1", payload: { from: "client1" } }),
      client2.request({ type: "test", id: "c2", payload: { from: "client2" } }),
    ]);

    expect(r1.payload.from).toBe("client1");
    expect(r2.payload.from).toBe("client2");

    client1.close();
    client2.close();
  });

  it("returns error for handler exceptions", async () => {
    server = new IpcServer();
    server.onRequest(async () => {
      throw new Error("handler exploded");
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const response = await client.request({
      type: "test",
      id: "req-err",
      payload: {},
    });

    expect(response.type).toBe("error");
    expect(response.payload.error).toBe("handler exploded");
  });
});
