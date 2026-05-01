import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  findExecCommandDenyMatch,
  getDenyPatternsForRole,
  wrapExecToolWithRoleDeny,
} from "./role-exec-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

function createMockExecTool(): { tool: AnyAgentTool; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    return {
      isError: false,
      content: [{ type: "text", text: "exec-ran" }],
    } as unknown as AgentToolResult<unknown>;
  });
  const tool = {
    name: "exec",
    label: "exec",
    description: "exec",
    parameters: {} as never,
    execute,
  } as unknown as AnyAgentTool;
  return { tool, execute };
}

describe("getDenyPatternsForRole", () => {
  it("returns no deny entries for super-admin", () => {
    expect(getDenyPatternsForRole("super-admin")).toHaveLength(0);
  });

  it("returns worker deny set for undefined role (least privilege default)", () => {
    expect(getDenyPatternsForRole(undefined)).toEqual(getDenyPatternsForRole("worker"));
  });
});

describe("tenant-admin deny rules", () => {
  const deny = getDenyPatternsForRole("tenant-admin");

  it("blocks model swap via openclaw config set agents.list[*].model", () => {
    expect(
      findExecCommandDenyMatch(
        "openclaw config set 'agents.list[2].model' '\"anthropic/claude-opus-4-7\"' --strict-json",
        deny,
      ),
    ).toBeDefined();
  });

  it("blocks openclaw config set channels.*", () => {
    expect(
      findExecCommandDenyMatch("openclaw config set channels.discord.token NEW", deny),
    ).toBeDefined();
  });

  it("blocks openclaw config set plugins.entries.* (gateway reload trigger)", () => {
    expect(
      findExecCommandDenyMatch("openclaw config set 'plugins.entries.google.config' '{}'", deny),
    ).toBeDefined();
  });

  it("blocks openclaw config set models.providers.*", () => {
    expect(
      findExecCommandDenyMatch("openclaw config set models.providers.anthropic.apiKey x", deny),
    ).toBeDefined();
  });

  it("blocks openclaw config set runtime", () => {
    expect(
      findExecCommandDenyMatch(`openclaw config set 'runtime.acp.cwd' "/tmp"`, deny),
    ).toBeDefined();
  });

  it("blocks openclaw config set roleBinding (would let agent escalate itself)", () => {
    expect(
      findExecCommandDenyMatch(`openclaw config set 'roleBinding.role' '"super-admin"'`, deny),
    ).toBeDefined();
  });

  it("blocks the patch and delete variants too", () => {
    expect(findExecCommandDenyMatch("openclaw config patch agents.list ...", deny)).toBeDefined();
    expect(findExecCommandDenyMatch("openclaw config delete agents.list", deny)).toBeDefined();
  });

  it("ALLOWS openclaw config set on defaults.* (admin tenant tweaks are intentional)", () => {
    expect(
      findExecCommandDenyMatch("openclaw config set defaults.thinkingDefault medium", deny),
    ).toBeUndefined();
    expect(
      findExecCommandDenyMatch("openclaw config set 'defaults.subagents.maxConcurrent' 4", deny),
    ).toBeUndefined();
  });

  it("ALLOWS the cron CLI (tenant-admin owns cron lifecycle)", () => {
    expect(findExecCommandDenyMatch("openclaw cron add --name X ...", deny)).toBeUndefined();
    expect(findExecCommandDenyMatch("openclaw cron rm abc", deny)).toBeUndefined();
    expect(findExecCommandDenyMatch("openclaw cron list", deny)).toBeUndefined();
  });

  it("ALLOWS unrelated commands", () => {
    expect(findExecCommandDenyMatch("ls /var/lib/openclaw/tenants/shipping", deny)).toBeUndefined();
    expect(findExecCommandDenyMatch("git diff", deny)).toBeUndefined();
    expect(findExecCommandDenyMatch("grep foo bar.txt", deny)).toBeUndefined();
  });
});

describe("worker deny rules", () => {
  const deny = getDenyPatternsForRole("worker");

  it("blocks ALL openclaw config set/patch/delete (worker should never mutate config)", () => {
    expect(
      findExecCommandDenyMatch("openclaw config set defaults.thinkingDefault low", deny),
    ).toBeDefined();
    expect(findExecCommandDenyMatch("openclaw config patch defaults ...", deny)).toBeDefined();
    expect(
      findExecCommandDenyMatch("openclaw config delete defaults.subagents", deny),
    ).toBeDefined();
  });

  it("blocks openclaw cron add/rm/remove/delete (workers cannot manage cron)", () => {
    expect(findExecCommandDenyMatch("openclaw cron add --name X", deny)).toBeDefined();
    expect(findExecCommandDenyMatch("openclaw cron rm abc", deny)).toBeDefined();
    expect(findExecCommandDenyMatch("openclaw cron remove abc", deny)).toBeDefined();
    expect(findExecCommandDenyMatch("openclaw cron delete abc", deny)).toBeDefined();
  });

  it("ALLOWS openclaw cron list (read-only is fine)", () => {
    expect(findExecCommandDenyMatch("openclaw cron list", deny)).toBeUndefined();
    expect(findExecCommandDenyMatch("openclaw cron show abc", deny)).toBeUndefined();
  });

  it("ALLOWS unrelated commands", () => {
    expect(findExecCommandDenyMatch("ls", deny)).toBeUndefined();
    expect(findExecCommandDenyMatch("python script.py", deny)).toBeUndefined();
  });
});

describe("wrapExecToolWithRoleDeny", () => {
  it("returns the base tool unchanged for super-admin (no deny entries)", () => {
    const { tool } = createMockExecTool();
    const wrapped = wrapExecToolWithRoleDeny(tool, { resolvedAgentRole: "super-admin" });
    expect(wrapped).toBe(tool);
  });

  it("delegates to the base tool when no deny pattern matches (tenant-admin)", async () => {
    const { tool, execute } = createMockExecTool();
    const wrapped = wrapExecToolWithRoleDeny(tool, { resolvedAgentRole: "tenant-admin" });
    const result = await wrapped.execute("call-1", { command: "ls /tmp" }, undefined);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });

  it("short-circuits with isError before spawning subprocess (tenant-admin model swap)", async () => {
    const { tool, execute } = createMockExecTool();
    const wrapped = wrapExecToolWithRoleDeny(tool, { resolvedAgentRole: "tenant-admin" });
    const result = await wrapped.execute(
      "call-2",
      { command: "openclaw config set 'agents.list[2].model' '\"x\"'" },
      undefined,
    );
    expect(execute).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("denied by role policy");
    expect(text).toContain("tenant-admin");
  });

  it("denies worker on `openclaw config set defaults.*` (broader worker scope)", async () => {
    const { tool, execute } = createMockExecTool();
    const wrapped = wrapExecToolWithRoleDeny(tool, { resolvedAgentRole: "worker" });
    const result = await wrapped.execute(
      "call-3",
      { command: "openclaw config set defaults.thinkingDefault medium" },
      undefined,
    );
    expect(execute).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("treats undefined role as worker (least privilege default)", async () => {
    const { tool, execute } = createMockExecTool();
    const wrapped = wrapExecToolWithRoleDeny(tool, { resolvedAgentRole: undefined });
    const result = await wrapped.execute("call-4", { command: "openclaw cron rm abc" }, undefined);
    expect(execute).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("worker (default)");
  });

  it("survives non-string params.command without throwing", async () => {
    const { tool, execute } = createMockExecTool();
    const wrapped = wrapExecToolWithRoleDeny(tool, { resolvedAgentRole: "tenant-admin" });
    // Empty/non-string command: cannot match deny patterns → falls through to base tool.
    const result = await wrapped.execute("call-5", { command: 42 }, undefined);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });
});

describe("anchoring + leading whitespace", () => {
  const deny = getDenyPatternsForRole("tenant-admin");

  it("matches with leading whitespace", () => {
    expect(findExecCommandDenyMatch("   openclaw config set agents.list ...", deny)).toBeDefined();
  });

  it("does not match when openclaw is embedded mid-command (e.g. inside bash -c)", () => {
    // Anchored to start; embedded uses are sandbox-boundary concerns, not this layer.
    expect(
      findExecCommandDenyMatch(`bash -c "openclaw config set agents.list[0].model x"`, deny),
    ).toBeUndefined();
  });
});
