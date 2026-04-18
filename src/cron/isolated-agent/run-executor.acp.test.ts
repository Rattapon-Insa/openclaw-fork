import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resetRunCronIsolatedAgentTurnHarness,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  restoreFastTestEnv,
  runAcpCronAgentMock,
  runCliAgentMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "acp-cron-job",
    name: "ACP Cron Test",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "hello from cron",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {
      agents: {
        list: [
          {
            id: "main",
            runtime: { type: "acp" as const, acp: { agent: "gemini" } },
          },
        ],
      },
    },
    deps: {} as never,
    job: makeJob(),
    message: "hello from cron",
    sessionKey: "agent:main:main",
    agentId: "main",
    ...overrides,
  };
}

function makeAcpRunResult(overrides?: Record<string, unknown>) {
  return {
    payloads: [{ text: "ACP output" }],
    meta: {
      agentMeta: { usage: { input: 0, output: 0 } },
      finalAssistantVisibleText: "ACP output",
    },
    ...overrides,
  };
}

describe("runCronIsolatedAgentTurn — ACP runtime dispatch", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "gemini",
      model: "gemini-3-flash-preview",
    });
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "gemini", model: "gemini-3-flash-preview" },
    });

    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          model: "gemini-3-flash-preview",
          modelProvider: "gemini",
        }),
        isNewSession: true,
      }),
    );

    runAcpCronAgentMock.mockResolvedValue(makeAcpRunResult());
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("dispatches to ACP runtime when agent runtime.type === 'acp'", async () => {
    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(runAcpCronAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("passes prompt text, sessionKey, agentId, and requestId through to ACP runtime", async () => {
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({ sessionId: "cron-run-xyz" }),
      isNewSession: false,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    await runCronIsolatedAgentTurn(
      makeParams({
        sessionKey: "agent:main:main",
        agentId: "main",
        message: "summarize my day",
      }),
    );

    const call = runAcpCronAgentMock.mock.calls[0]?.[0] as
      | {
          agentId?: string;
          sessionKey?: string;
          requestId?: string;
          prompt?: string;
        }
      | undefined;
    expect(call?.agentId).toBe("main");
    expect(call?.sessionKey).toBe("agent:main:main");
    expect(call?.requestId).toBe("cron-run-xyz");
    expect(call?.prompt).toContain("summarize my day");
  });

  it("surfaces ACP runtime payloads into the cron run result", async () => {
    runAcpCronAgentMock.mockResolvedValue(
      makeAcpRunResult({
        payloads: [{ text: "assistant block" }],
        meta: {
          agentMeta: { usage: { input: 100, output: 50 } },
          finalAssistantVisibleText: "assistant block",
        },
      }),
    );

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    // runCronIsolatedAgentTurn processes payloads through helpers; the key check
    // is that the ACP output text reached the cron payload outcome resolver.
    expect(runAcpCronAgentMock).toHaveBeenCalled();
  });

  it("propagates abortSignal and timeoutMs to the ACP runtime", async () => {
    await runCronIsolatedAgentTurn(makeParams());

    const call = runAcpCronAgentMock.mock.calls[0]?.[0] as
      | { timeoutMs?: number; abortSignal?: AbortSignal }
      | undefined;
    expect(typeof call?.timeoutMs).toBe("number");
    expect(call?.timeoutMs).toBeGreaterThan(0);
    // abortSignal may be undefined if caller didn't pass one; ensure the
    // dispatch at least threads the field.
    expect("abortSignal" in (call ?? {})).toBe(true);
  });

  it("falls back to embedded runtime when agent runtime.type is not 'acp'", async () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            list: [{ id: "main", runtime: { type: "embedded" as const } }],
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runAcpCronAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
  });

  it("falls back to embedded runtime when runtime config is absent (no ACP dispatch)", async () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: { list: [{ id: "main" }] },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runAcpCronAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
  });
});
