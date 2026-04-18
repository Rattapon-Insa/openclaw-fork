import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initializeSessionMock = vi.fn();
const runTurnMock = vi.fn();
const resolveSessionMock = vi.fn();

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: resolveSessionMock,
    initializeSession: initializeSessionMock,
    runTurn: runTurnMock,
  }),
}));

const { runAcpCronAgent } = await import("./run-acp.runtime.js");

type CfgShape = {
  agents?: {
    list?: Array<{
      id: string;
      runtime?: {
        type: "acp" | "embedded";
        acp?: { agent?: string; mode?: "persistent" | "oneshot"; cwd?: string };
      };
      tools?: { deny?: string[] };
    }>;
  };
};

function makeParams(cfg: CfgShape) {
  return {
    cfg: cfg as never,
    agentId: "gmail-tagger",
    sessionKey: "agent:gmail-tagger:main",
    requestId: "req-1",
    prompt: "ping",
    timeoutMs: 30_000,
  };
}

describe("runAcpCronAgent — agent.tools.deny pass-through", () => {
  beforeEach(() => {
    initializeSessionMock.mockReset();
    runTurnMock.mockReset();
    resolveSessionMock.mockReset();
    resolveSessionMock.mockReturnValue({
      kind: "none",
      sessionKey: "agent:gmail-tagger:main",
    });
    initializeSessionMock.mockResolvedValue({ handle: {}, metaCleared: false });
    runTurnMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards agent.tools.deny as toolsDeny into initializeSession", async () => {
    const cfg: CfgShape = {
      agents: {
        list: [
          {
            id: "gmail-tagger",
            runtime: { type: "acp" as const, acp: { agent: "gemini", mode: "oneshot" as const } },
            tools: { deny: ["ship-tools__*"] },
          },
        ],
      },
    };

    await runAcpCronAgent(makeParams(cfg));

    expect(initializeSessionMock).toHaveBeenCalledTimes(1);
    const call = initializeSessionMock.mock.calls[0]?.[0] as { toolsDeny?: string[] };
    expect(call.toolsDeny).toEqual(["ship-tools__*"]);
  });

  it("omits toolsDeny when agent has no tools.deny config", async () => {
    const cfg: CfgShape = {
      agents: {
        list: [
          {
            id: "gmail-tagger",
            runtime: { type: "acp" as const, acp: { agent: "gemini" } },
          },
        ],
      },
    };

    await runAcpCronAgent(makeParams(cfg));

    const call = initializeSessionMock.mock.calls[0]?.[0] as { toolsDeny?: string[] };
    expect(call && "toolsDeny" in call).toBe(false);
  });

  it("filters out blank / non-string deny entries", async () => {
    const cfg: CfgShape = {
      agents: {
        list: [
          {
            id: "gmail-tagger",
            runtime: { type: "acp" as const },
            tools: {
              deny: ["  ", "ship-tools__*", "", "other__*"] as never,
            },
          },
        ],
      },
    };

    await runAcpCronAgent(makeParams(cfg));

    const call = initializeSessionMock.mock.calls[0]?.[0] as { toolsDeny?: string[] };
    expect(call.toolsDeny).toEqual(["ship-tools__*", "other__*"]);
  });
});
