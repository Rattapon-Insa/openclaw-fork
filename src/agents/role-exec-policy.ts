import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentRole } from "../config/types.agents.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Compiled regex patterns the exec tool uses to reject a `command` string
 * before spawning the underlying subprocess. Each pattern is matched against
 * the full command (the value sent in the `command` field of the exec tool's
 * arguments), case-sensitively. A single match is enough to deny the call.
 *
 * Patterns are intentionally **anchored** with `^\s*` so they match commands
 * the agent submits at the top level. Embedded uses inside e.g.
 * `bash -c '... openclaw config set ...'` are not caught by this layer —
 * those are defense-in-depth concerns that belong to a sandbox boundary.
 *
 * Per role:
 *
 * - `worker`: cannot mutate tenant config or schedule via the openclaw CLI.
 *   `openclaw config set/patch/delete` and `openclaw cron add/rm/remove/delete`
 *   are denied outright.
 * - `tenant-admin`: can manage skill files and use `openclaw cron *` (that's
 *   the whole point of admin), but cannot use `openclaw config set` /
 *   `openclaw config patch` for tenant runtime config paths
 *   (`agents.list`, `channels`, `plugins.entries`, `models.providers`,
 *   `runtime`, `roleBinding`). Those changes are tenant.yaml-domain and must
 *   go through PR / dev review.
 * - `super-admin`: no exec deny patterns from this layer.
 *
 * `tenant-admin` is allowed to set values under `defaults.*` and other paths
 * not enumerated as denied; the goal is to block the model-swap class of
 * incidents (see Phase A spike where `openclaw config set agents.list[2].model`
 * triggered an unintended gateway reload), not to ban the CLI entirely.
 */
export type AgentRoleExecCommandDeny = {
  pattern: RegExp;
  /** Short human-readable reason emitted in the structured tool result. */
  reason: string;
};

const TENANT_ADMIN_PROTECTED_CONFIG_PATHS = [
  "agents\\.list",
  "channels",
  "plugins\\.entries",
  "models\\.providers",
  "runtime",
  "roleBinding",
];

const TENANT_ADMIN_DENY: readonly AgentRoleExecCommandDeny[] = [
  {
    // Block `openclaw config set 'agents.list[...].model' '...'` and friends.
    pattern: new RegExp(
      `^\\s*openclaw\\s+config\\s+(set|patch|delete)\\s+['"]?(${TENANT_ADMIN_PROTECTED_CONFIG_PATHS.join(
        "|",
      )})\\b`,
    ),
    reason:
      "tenant-admin role cannot mutate openclaw runtime config (agents/channels/plugins/models/runtime/roleBinding). Use a tenant.yaml PR or escalate to super-admin.",
  },
];

const WORKER_DENY: readonly AgentRoleExecCommandDeny[] = [
  {
    // Workers should not edit any openclaw config or cron via CLI.
    pattern: /^\s*openclaw\s+config\s+(set|patch|delete)\b/,
    reason:
      "worker role cannot run `openclaw config set/patch/delete`. Escalate to tenant-admin or open a dev ticket.",
  },
  {
    pattern: /^\s*openclaw\s+cron\s+(add|rm|remove|delete)\b/,
    reason: "worker role cannot manage cron jobs. The tenant-admin agent owns cron lifecycle.",
  },
];

const SUPER_ADMIN_DENY: readonly AgentRoleExecCommandDeny[] = [];

export function getDenyPatternsForRole(
  role: AgentRole | undefined,
): readonly AgentRoleExecCommandDeny[] {
  switch (role) {
    case "super-admin":
      return SUPER_ADMIN_DENY;
    case "tenant-admin":
      return TENANT_ADMIN_DENY;
    case "worker":
      return WORKER_DENY;
    default:
      // No declared role → least privilege, matches `worker` deny set.
      return WORKER_DENY;
  }
}

/**
 * Returns the first matching deny entry for the given command, or undefined
 * if no deny applies. Caller is responsible for surfacing the structured
 * denial to the agent in the tool result.
 */
export function findExecCommandDenyMatch(
  command: string,
  denyList: readonly AgentRoleExecCommandDeny[],
): AgentRoleExecCommandDeny | undefined {
  for (const entry of denyList) {
    if (entry.pattern.test(command)) {
      return entry;
    }
  }
  return undefined;
}

function extractCommandString(args: unknown): string {
  if (args === null || typeof args !== "object") {
    return "";
  }
  const value = (args as { command?: unknown }).command;
  return typeof value === "string" ? value : "";
}

function buildDenyToolResult(
  match: AgentRoleExecCommandDeny,
  role: AgentRole | undefined,
): AgentToolResult<unknown> {
  const roleLabel = role ?? "worker (default)";
  const text = [
    `exec denied by role policy (role=${roleLabel}): ${match.reason}`,
    "If this is in scope, ask the user to escalate or open a dev ticket.",
  ].join("\n");
  return {
    isError: true,
    content: [{ type: "text", text }],
  } as unknown as AgentToolResult<unknown>;
}

/**
 * Wraps an exec tool with a pre-execution role-based command denylist. When
 * the agent submits a `command` that matches any pattern in the role's deny
 * list, the wrapper short-circuits with a structured `isError: true` tool
 * result and the underlying subprocess is never spawned.
 *
 * `super-admin` (and any role with an empty deny list) bypasses the wrap and
 * the original tool is returned unchanged.
 */
export function wrapExecToolWithRoleDeny(
  baseTool: AnyAgentTool,
  options: { resolvedAgentRole?: AgentRole },
): AnyAgentTool {
  const denyList = getDenyPatternsForRole(options.resolvedAgentRole);
  if (denyList.length === 0) {
    return baseTool;
  }
  return {
    ...baseTool,
    execute: async (toolCallId, params, signal) => {
      const command = extractCommandString(params);
      const match = findExecCommandDenyMatch(command, denyList);
      if (match) {
        return buildDenyToolResult(match, options.resolvedAgentRole);
      }
      return baseTool.execute(toolCallId, params, signal);
    },
  } as AnyAgentTool;
}
