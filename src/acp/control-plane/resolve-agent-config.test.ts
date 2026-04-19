import { describe, expect, it } from "vitest";
import { resolveAcpAgentConfig } from "./resolve-agent-config.js";

/**
 * Shared helper — both cron dispatch (`run-acp.runtime.ts`) and Discord-adhoc
 * dispatch (`dispatch-acp.ts`) resolve agent config through this function,
 * so per-agent isolation (workspace cwd + oneshot re-init) must behave
 * identically regardless of entrypoint. These standalone tests lock that
 * contract before any refactor touches the helper.
 */

type CfgShape = {
  agents?: {
    list?: Array<{
      id: string;
      runtime?: {
        type: "acp" | "embedded";
        acp?: {
          agent?: string;
          mode?: "persistent" | "oneshot";
          cwd?: string;
        };
      };
    }>;
  };
  acp?: { defaultAgent?: string; allowedAgents?: string[] };
};

function cfg(overrides?: CfgShape): CfgShape {
  return {
    agents: {
      list: [
        {
          id: "gmail-tagger",
          runtime: {
            type: "acp",
            acp: { agent: "gemini", mode: "oneshot", cwd: "/opt/gmail" },
          },
        },
        {
          id: "main",
          runtime: {
            type: "acp",
            acp: { agent: "gemini", mode: "persistent", cwd: "/opt/main" },
          },
        },
        {
          id: "eta-checker",
          runtime: { type: "embedded" },
        },
      ],
    },
    ...overrides,
  };
}

describe("resolveAcpAgentConfig", () => {
  it("resolves a configured ACP agent with full runtime overrides", () => {
    const got = resolveAcpAgentConfig(cfg() as never, "gmail-tagger");
    expect(got).toEqual({
      agent: "gemini",
      mode: "oneshot",
      cwd: "/opt/gmail",
    });
  });

  it("resolves a second agent independently", () => {
    const got = resolveAcpAgentConfig(cfg() as never, "main");
    expect(got).toEqual({
      agent: "gemini",
      mode: "persistent",
      cwd: "/opt/main",
    });
  });

  it("defaults mode to 'persistent' when runtime.acp.mode is absent", () => {
    const c: CfgShape = {
      agents: {
        list: [{ id: "x", runtime: { type: "acp", acp: { agent: "gemini" } } }],
      },
    };
    expect(resolveAcpAgentConfig(c as never, "x").mode).toBe("persistent");
  });

  it("defaults mode to 'persistent' for any non-'oneshot' value", () => {
    const c: CfgShape = {
      agents: {
        list: [
          {
            id: "x",
            runtime: { type: "acp", acp: { agent: "gemini", mode: "persistent" } },
          },
        ],
      },
    };
    expect(resolveAcpAgentConfig(c as never, "x").mode).toBe("persistent");
  });

  it("preserves mode 'oneshot' when explicitly set", () => {
    const c: CfgShape = {
      agents: {
        list: [{ id: "x", runtime: { type: "acp", acp: { agent: "gemini", mode: "oneshot" } } }],
      },
    };
    expect(resolveAcpAgentConfig(c as never, "x").mode).toBe("oneshot");
  });

  it("omits cwd when runtime.acp.cwd is missing", () => {
    const c: CfgShape = {
      agents: {
        list: [{ id: "x", runtime: { type: "acp", acp: { agent: "gemini" } } }],
      },
    };
    const got = resolveAcpAgentConfig(c as never, "x");
    expect("cwd" in got).toBe(false);
  });

  it("omits cwd when runtime.acp.cwd is whitespace-only", () => {
    const c: CfgShape = {
      agents: {
        list: [{ id: "x", runtime: { type: "acp", acp: { agent: "gemini", cwd: "   " } } }],
      },
    };
    expect("cwd" in resolveAcpAgentConfig(c as never, "x")).toBe(false);
  });

  it("trims whitespace around cwd when set", () => {
    const c: CfgShape = {
      agents: {
        list: [
          {
            id: "x",
            runtime: { type: "acp", acp: { agent: "gemini", cwd: "  /tmp/ws  " } },
          },
        ],
      },
    };
    expect(resolveAcpAgentConfig(c as never, "x").cwd).toBe("/tmp/ws");
  });

  it("trims whitespace around agent when set", () => {
    const c: CfgShape = {
      agents: {
        list: [{ id: "x", runtime: { type: "acp", acp: { agent: "  gemini  " } } }],
      },
    };
    expect(resolveAcpAgentConfig(c as never, "x").agent).toBe("gemini");
  });

  describe("agent fallback chain", () => {
    it("falls back to cfg.acp.defaultAgent when runtime.acp.agent is missing", () => {
      const c: CfgShape = {
        agents: { list: [{ id: "x", runtime: { type: "acp" } }] },
        acp: { defaultAgent: "codex" },
      };
      expect(resolveAcpAgentConfig(c as never, "x").agent).toBe("codex");
    });

    it("falls back to 'gemini' when neither runtime nor cfg.acp.defaultAgent is set", () => {
      const c: CfgShape = {
        agents: { list: [{ id: "x", runtime: { type: "acp" } }] },
      };
      expect(resolveAcpAgentConfig(c as never, "x").agent).toBe("gemini");
    });

    it("treats an empty runtime.acp.agent as missing and falls through", () => {
      const c: CfgShape = {
        agents: {
          list: [{ id: "x", runtime: { type: "acp", acp: { agent: "" } } }],
        },
        acp: { defaultAgent: "codex" },
      };
      expect(resolveAcpAgentConfig(c as never, "x").agent).toBe("codex");
    });

    it("treats a whitespace-only runtime.acp.agent as missing and falls through", () => {
      const c: CfgShape = {
        agents: {
          list: [{ id: "x", runtime: { type: "acp", acp: { agent: "   " } } }],
        },
      };
      expect(resolveAcpAgentConfig(c as never, "x").agent).toBe("gemini");
    });
  });

  describe("unknown / missing agent id", () => {
    it("returns default shape when agentId is not in cfg.agents.list", () => {
      const got = resolveAcpAgentConfig(cfg() as never, "does-not-exist");
      // Unknown id still returns a usable default (doesn't throw) —
      // callers use this for legacy `/acp spawn <raw-backend-name>`.
      expect(got).toEqual({ agent: "gemini", mode: "persistent" });
    });

    it("uses cfg.acp.defaultAgent for unknown ids", () => {
      const c: CfgShape = {
        agents: { list: [] },
        acp: { defaultAgent: "codex" },
      };
      expect(resolveAcpAgentConfig(c as never, "unknown").agent).toBe("codex");
    });
  });

  describe("embedded / non-acp runtime", () => {
    it("ignores runtime.acp when runtime.type !== 'acp' (falls back to defaults)", () => {
      const got = resolveAcpAgentConfig(cfg() as never, "eta-checker");
      expect(got).toEqual({ agent: "gemini", mode: "persistent" });
    });
  });

  describe("malformed config tolerance", () => {
    it("does not throw when cfg.agents is missing", () => {
      const c: CfgShape = {};
      expect(() => resolveAcpAgentConfig(c as never, "x")).not.toThrow();
      expect(resolveAcpAgentConfig(c as never, "x")).toEqual({
        agent: "gemini",
        mode: "persistent",
      });
    });

    it("does not throw when cfg.agents.list is undefined", () => {
      const c: CfgShape = { agents: {} };
      expect(resolveAcpAgentConfig(c as never, "x").agent).toBe("gemini");
    });

    it("does not throw on a null entry in the list", () => {
      const c = {
        agents: { list: [null, { id: "x", runtime: { type: "acp", acp: { agent: "a" } } }] },
      } as unknown;
      expect(() => resolveAcpAgentConfig(c as never, "x")).not.toThrow();
      expect(resolveAcpAgentConfig(c as never, "x").agent).toBe("a");
    });

    it("does not throw when runtime is missing on a matched entry", () => {
      const c: CfgShape = { agents: { list: [{ id: "x" }] } };
      expect(resolveAcpAgentConfig(c as never, "x")).toEqual({
        agent: "gemini",
        mode: "persistent",
      });
    });
  });
});
