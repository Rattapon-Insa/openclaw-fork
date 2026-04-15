import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const waitForAgentRunMock = vi.fn();
  const callGatewayMock = vi.fn();
  return {
    spawnSubagentDirectMock,
    waitForAgentRunMock,
    callGatewayMock,
  };
});

vi.mock("../subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: (...args: unknown[]) => hoisted.waitForAgentRunMock(...args),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => hoisted.callGatewayMock(...args),
}));

type ToolResult = { details?: Record<string, unknown> };

let createSessionsRunAndWaitTool: typeof import("./sessions-run-and-wait-tool.js").createSessionsRunAndWaitTool;

function assistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

describe("sessions_run_and_wait tool", () => {
  beforeAll(async () => {
    ({ createSessionsRunAndWaitTool } = await import("./sessions-run-and-wait-tool.js"));
  });

  beforeEach(() => {
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-1",
    });
    hoisted.waitForAgentRunMock.mockReset().mockResolvedValue({ status: "ok" });
    hoisted.callGatewayMock.mockReset();
  });

  it("blocks until child finishes and returns last assistant text", async () => {
    hoisted.callGatewayMock.mockResolvedValue({
      messages: [assistantMessage("step 1"), assistantMessage("final answer: 42")],
    });

    const tool = createSessionsRunAndWaitTool({ agentSessionKey: "agent:main:main" });
    const result = (await tool.execute("call-1", {
      task: "compute",
      agentId: "worker",
    })) as ToolResult;

    expect(result.details).toMatchObject({
      status: "ok",
      output: "final answer: 42",
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
    });
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ task: "compute", agentId: "worker", runTimeoutSeconds: 300 }),
      expect.any(Object),
    );
    expect(hoisted.waitForAgentRunMock).toHaveBeenCalledWith({
      runId: "run-1",
      timeoutMs: 300_000,
    });
  });

  it("skips ANNOUNCE_SKIP and REPLY_SKIP silent tokens when selecting output", async () => {
    hoisted.callGatewayMock.mockResolvedValue({
      messages: [
        assistantMessage("real result line"),
        assistantMessage("ANNOUNCE_SKIP"),
        assistantMessage("REPLY_SKIP"),
      ],
    });

    const tool = createSessionsRunAndWaitTool();
    const result = (await tool.execute("call-2", { task: "x" })) as ToolResult;

    expect(result.details).toMatchObject({ status: "ok", output: "real result line" });
  });

  it("propagates spawn failure as error status", async () => {
    hoisted.spawnSubagentDirectMock.mockResolvedValue({
      status: "error",
      error: "agent not found",
    });

    const tool = createSessionsRunAndWaitTool();
    const result = (await tool.execute("call-3", { task: "x", agentId: "ghost" })) as ToolResult;

    expect(result.details).toMatchObject({ status: "error", error: "agent not found" });
    expect(hoisted.waitForAgentRunMock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns timeout status when child exceeds timeout", async () => {
    hoisted.waitForAgentRunMock.mockResolvedValue({ status: "timeout" });
    hoisted.callGatewayMock.mockResolvedValue({ messages: [] });

    const tool = createSessionsRunAndWaitTool();
    const result = (await tool.execute("call-4", {
      task: "slow",
      timeoutSeconds: 10,
    })) as ToolResult;

    expect(result.details).toMatchObject({ status: "timeout", runId: "run-1" });
    expect(hoisted.waitForAgentRunMock).toHaveBeenCalledWith({
      runId: "run-1",
      timeoutMs: 10_000,
    });
  });

  it("hard-caps timeoutSeconds at 1800", async () => {
    hoisted.callGatewayMock.mockResolvedValue({ messages: [assistantMessage("done")] });
    const tool = createSessionsRunAndWaitTool();
    await tool.execute("call-5", { task: "x", timeoutSeconds: 99999 });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ runTimeoutSeconds: 1800 }),
      expect.any(Object),
    );
    expect(hoisted.waitForAgentRunMock).toHaveBeenCalledWith({
      runId: "run-1",
      timeoutMs: 1_800_000,
    });
  });

  it("passes explicit timeoutMs to callGateway so chat.history doesn't fall back to the 10s default", async () => {
    hoisted.callGatewayMock.mockResolvedValue({ messages: [assistantMessage("ok")] });
    const tool = createSessionsRunAndWaitTool();
    await tool.execute("call-7", { task: "x" });

    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.history",
        timeoutMs: expect.any(Number),
      }),
    );
    const call = hoisted.callGatewayMock.mock.calls.find(
      (c) => (c[0] as { method?: string })?.method === "chat.history",
    );
    expect((call?.[0] as { timeoutMs?: number })?.timeoutMs ?? 0).toBeGreaterThanOrEqual(30_000);
  });

  it("composes context before task when context is provided", async () => {
    hoisted.callGatewayMock.mockResolvedValue({ messages: [assistantMessage("ok")] });
    const tool = createSessionsRunAndWaitTool();
    await tool.execute("call-6", {
      task: "classify",
      context: "prior data: abc",
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "prior data: abc\n\n---\n\nclassify",
      }),
      expect.any(Object),
    );
  });
});
