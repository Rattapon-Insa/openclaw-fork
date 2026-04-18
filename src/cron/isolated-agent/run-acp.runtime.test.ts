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
    }>;
  };
  acp?: { defaultAgent?: string };
};

function makeCfg(overrides?: CfgShape): CfgShape {
  return {
    agents: {
      list: [
        {
          id: "gmail-tagger",
          runtime: {
            type: "acp" as const,
            acp: { agent: "gemini", mode: "oneshot" as const, cwd: "/opt/gmail-tagger" },
          },
        },
      ],
    },
    ...overrides,
  };
}

function makeParams(cfg: CfgShape) {
  return {
    // OpenClawConfig type is loose; cast through unknown.
    cfg: cfg as never,
    agentId: "gmail-tagger",
    sessionKey: "agent:gmail-tagger:main",
    requestId: "req-1",
    prompt: "ping",
    timeoutMs: 30_000,
  };
}

describe("runAcpCronAgent — acp agent config resolution", () => {
  beforeEach(() => {
    initializeSessionMock.mockReset();
    runTurnMock.mockReset();
    resolveSessionMock.mockReset();
    resolveSessionMock.mockReturnValue({
      kind: "none",
      sessionKey: "agent:gmail-tagger:main",
    });
    initializeSessionMock.mockResolvedValue({
      handle: {},
      metaCleared: false,
    });
    runTurnMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes agent + mode + cwd from runtime.acp config into initializeSession on cold start", async () => {
    await runAcpCronAgent(makeParams(makeCfg()));

    expect(initializeSessionMock).toHaveBeenCalledTimes(1);
    const call = initializeSessionMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      sessionKey: "agent:gmail-tagger:main",
      agent: "gemini",
      mode: "oneshot",
      cwd: "/opt/gmail-tagger",
    });
  });

  it("defaults mode to 'persistent' when runtime.acp.mode is absent", async () => {
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

    const call = initializeSessionMock.mock.calls[0]?.[0];
    expect(call?.mode).toBe("persistent");
  });

  it("omits cwd from initializeSession when runtime.acp.cwd is not set", async () => {
    const cfg: CfgShape = {
      agents: {
        list: [
          {
            id: "gmail-tagger",
            runtime: { type: "acp" as const, acp: { agent: "gemini", mode: "oneshot" as const } },
          },
        ],
      },
    };

    await runAcpCronAgent(makeParams(cfg));

    const call = initializeSessionMock.mock.calls[0]?.[0];
    expect(call && "cwd" in call).toBe(false);
  });

  it("falls back to cfg.acp.defaultAgent then 'gemini' when runtime.acp.agent is missing", async () => {
    const cfg: CfgShape = {
      agents: {
        list: [{ id: "gmail-tagger", runtime: { type: "acp" as const } }],
      },
      acp: { defaultAgent: "codex" },
    };

    await runAcpCronAgent(makeParams(cfg));

    expect(initializeSessionMock.mock.calls[0]?.[0]?.agent).toBe("codex");
  });

  it("still calls initializeSession on 'ready' for oneshot agents so toolsDeny re-applies", async () => {
    resolveSessionMock.mockReturnValue({
      kind: "ready",
      sessionKey: "agent:gmail-tagger:main",
      meta: { agent: "gemini" },
    });

    await runAcpCronAgent(makeParams(makeCfg()));

    // oneshot = fresh session every fire; toolsDeny must re-apply per fire.
    expect(initializeSessionMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });

  it("skips initializeSession on 'ready' for persistent agents", async () => {
    resolveSessionMock.mockReturnValue({
      kind: "ready",
      sessionKey: "agent:main:main",
      meta: { agent: "gemini" },
    });
    const cfg: CfgShape = {
      agents: {
        list: [
          {
            id: "gmail-tagger",
            runtime: {
              type: "acp" as const,
              acp: { agent: "gemini", mode: "persistent" as const },
            },
          },
        ],
      },
    };

    await runAcpCronAgent(makeParams(cfg));

    expect(initializeSessionMock).not.toHaveBeenCalled();
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });

  it("returns error payload without calling runTurn when resolve is 'stale'", async () => {
    resolveSessionMock.mockReturnValue({
      kind: "stale",
      sessionKey: "agent:gmail-tagger:main",
      error: { code: "ACP_SESSION_STALE", message: "stale session" },
    });

    const result = await runAcpCronAgent(makeParams(makeCfg()));

    expect(initializeSessionMock).not.toHaveBeenCalled();
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(result.meta.error).toContain("ACP_SESSION_STALE");
    expect(result.payloads[0]).toMatchObject({ isError: true });
  });
});
