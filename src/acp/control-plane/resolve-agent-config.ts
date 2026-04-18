import type { AgentConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AcpRuntimeSessionMode } from "../runtime/types.js";

export type ResolvedAcpAgentConfig = {
  /** ACP backend agent id (e.g. "gemini", "codex"). */
  agent: string;
  /** Session mode — "persistent" keeps the subprocess alive across turns, "oneshot" spawns fresh each time. */
  mode: AcpRuntimeSessionMode;
  /** Per-agent working directory override for the Gemini CLI (or equivalent) subprocess. */
  cwd?: string;
};

/**
 * Read an openclaw agent's per-agent ACP runtime overrides out of the config,
 * falling back to cfg.acp.defaultAgent / "gemini" / "persistent" / (no cwd).
 *
 * Both the cron dispatch path (`src/cron/isolated-agent/run-acp.runtime.ts`)
 * and the Discord-adhoc dispatch path (`src/auto-reply/reply/dispatch-acp.ts`)
 * must share the same resolution so per-agent isolation (workspace cwd +
 * oneshot re-init) applies uniformly across entrypoints.
 */
export function resolveAcpAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAcpAgentConfig {
  const agents: AgentConfig[] = cfg.agents?.list ?? [];
  const entry = agents.find((a) => a?.id === agentId);
  const acp = entry?.runtime?.type === "acp" ? entry.runtime.acp : undefined;
  const configuredAgent =
    typeof acp?.agent === "string" && acp.agent.trim().length > 0 ? acp.agent.trim() : undefined;
  const configuredCwd =
    typeof acp?.cwd === "string" && acp.cwd.trim().length > 0 ? acp.cwd.trim() : undefined;
  return {
    agent: configuredAgent ?? cfg.acp?.defaultAgent ?? "gemini",
    mode: acp?.mode === "oneshot" ? "oneshot" : "persistent",
    ...(configuredCwd ? { cwd: configuredCwd } : {}),
  };
}
