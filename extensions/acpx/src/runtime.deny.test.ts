import { describe, expect, it, vi } from "vitest";

type DelegateSpy = {
  ensureSession: ReturnType<typeof vi.fn>;
  runTurn: ReturnType<typeof vi.fn>;
  getCapabilities: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setConfigOption: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isHealthy: ReturnType<typeof vi.fn>;
  probeAvailability: ReturnType<typeof vi.fn>;
  doctor: ReturnType<typeof vi.fn>;
};

const delegateSpy: DelegateSpy = {
  ensureSession: vi.fn(),
  runTurn: vi.fn(),
  getCapabilities: vi.fn(),
  getStatus: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  isHealthy: vi.fn(),
  probeAvailability: vi.fn(),
  doctor: vi.fn(),
};

vi.mock("acpx/runtime", async () => {
  const actual = await vi.importActual<typeof import("acpx/runtime")>("acpx/runtime");
  class MockBaseAcpxRuntime {
    ensureSession = delegateSpy.ensureSession;
    runTurn = delegateSpy.runTurn;
    getCapabilities = delegateSpy.getCapabilities;
    getStatus = delegateSpy.getStatus;
    setMode = delegateSpy.setMode;
    setConfigOption = delegateSpy.setConfigOption;
    cancel = delegateSpy.cancel;
    close = delegateSpy.close;
    isHealthy = delegateSpy.isHealthy;
    probeAvailability = delegateSpy.probeAvailability;
    doctor = delegateSpy.doctor;
  }
  return {
    ...actual,
    AcpxRuntime: MockBaseAcpxRuntime,
  };
});

const { AcpxRuntime } = await import("./runtime.js");

function makeMcpServer(name: string): { name: string; command: string } {
  return { name, command: `${name}-cmd` };
}

function makeOptions(servers: Array<{ name: string; command: string }>) {
  return {
    cwd: "/workspace",
    mcpServers: servers as never,
    permissionMode: "approve-reads" as const,
    sessionStore: {
      load: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    },
    agentRegistry: {
      resolve: vi.fn().mockReturnValue("codex --acp"),
      list: vi.fn().mockReturnValue(["codex"]),
    },
  };
}

describe("AcpxRuntime wrapper — per-session MCP deny filtering", () => {
  it("filters mcpServers list by denylist glob and forwards to delegate", async () => {
    delegateSpy.ensureSession.mockResolvedValue({
      sessionKey: "k",
      backend: "acpx",
      runtimeSessionName: "",
    });
    const servers = [makeMcpServer("gog"), makeMcpServer("ship-tools")];
    const runtime = new AcpxRuntime(makeOptions(servers) as never);

    await runtime.ensureSession({
      sessionKey: "k",
      agent: "gemini",
      mode: "oneshot",
      toolsDeny: ["ship-tools__*"],
    });

    expect(delegateSpy.ensureSession).toHaveBeenCalledTimes(1);
    const call = delegateSpy.ensureSession.mock.calls[0][0];
    expect(call.mcpServers).toEqual([{ name: "gog", command: "gog-cmd" }]);
    expect(call.toolsDeny).toEqual(["ship-tools__*"]);
  });

  it("passes through without mcpServers field when toolsDeny is empty or missing", async () => {
    delegateSpy.ensureSession.mockResolvedValue({
      sessionKey: "k",
      backend: "acpx",
      runtimeSessionName: "",
    });
    const servers = [makeMcpServer("gog"), makeMcpServer("ship-tools")];
    const runtime = new AcpxRuntime(makeOptions(servers) as never);

    await runtime.ensureSession({
      sessionKey: "k",
      agent: "gemini",
      mode: "oneshot",
    });

    const call = delegateSpy.ensureSession.mock.calls.at(-1)?.[0];
    expect(call && "mcpServers" in call).toBe(false);
  });

  it("ignores deny patterns without the __ MCP tool separator", async () => {
    delegateSpy.ensureSession.mockResolvedValue({
      sessionKey: "k",
      backend: "acpx",
      runtimeSessionName: "",
    });
    const servers = [makeMcpServer("gog"), makeMcpServer("ship-tools")];
    const runtime = new AcpxRuntime(makeOptions(servers) as never);

    await runtime.ensureSession({
      sessionKey: "k",
      agent: "gemini",
      mode: "oneshot",
      toolsDeny: ["Bash", "ship-tools"],
    });

    const call = delegateSpy.ensureSession.mock.calls.at(-1)?.[0];
    // Neither pattern targets an MCP server (no "__*" suffix), so no filter applied.
    expect(call && "mcpServers" in call).toBe(false);
  });

  it("supports denying multiple MCP servers via separate glob patterns", async () => {
    delegateSpy.ensureSession.mockResolvedValue({
      sessionKey: "k",
      backend: "acpx",
      runtimeSessionName: "",
    });
    const servers = [makeMcpServer("gog"), makeMcpServer("ship-tools"), makeMcpServer("other")];
    const runtime = new AcpxRuntime(makeOptions(servers) as never);

    await runtime.ensureSession({
      sessionKey: "k",
      agent: "gemini",
      mode: "oneshot",
      toolsDeny: ["ship-tools__*", "other__*"],
    });

    const call = delegateSpy.ensureSession.mock.calls.at(-1)?.[0];
    expect(call.mcpServers).toEqual([{ name: "gog", command: "gog-cmd" }]);
  });
});
