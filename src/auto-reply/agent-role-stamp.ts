import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveAgentRoleForCaller, type RoleResolutionCaller } from "../agents/role-resolution.js";
import type { AgentRole } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MsgContext } from "./templating.js";

/** Subset of MsgContext fields the role stamper depends on. */
type CallerInfoSource = Pick<
  MsgContext,
  "Surface" | "Provider" | "SenderId" | "ChatType" | "NativeChannelId"
>;

/**
 * Map an inbound MsgContext into the channel-agnostic envelope expected by
 * the role resolver. `Surface` is preferred over `Provider` because the former
 * is the per-account channel id (e.g. "discord", "line") used elsewhere in
 * the runtime; `Provider` is a coarser fallback retained for older surfaces.
 *
 * `ChatType === "direct"` is the canonical DM marker across providers
 * (see `src/auto-reply/templating.ts`).
 */
export function buildRoleResolutionCaller(ctx: CallerInfoSource): RoleResolutionCaller {
  const channel = (ctx.Surface ?? ctx.Provider ?? "").trim().toLowerCase();
  return {
    channel,
    senderUserId: ctx.SenderId,
    isDirectMessage: ctx.ChatType === "direct",
    channelId: ctx.NativeChannelId,
  };
}

/**
 * Resolve the effective role for a single inbound turn given the OpenClaw
 * config, the agent that will handle the message, and the inbound context.
 *
 * Returns `worker` (least privilege) when the agent has no `roleBinding`
 * declared or cannot be located in config — never throws.
 */
export function resolveAgentRoleForRunContext(params: {
  cfg: OpenClawConfig | undefined;
  agentId: string;
  ctx: CallerInfoSource;
}): AgentRole {
  const agentConfig = params.cfg ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  return resolveAgentRoleForCaller(agentConfig?.roleBinding, buildRoleResolutionCaller(params.ctx));
}

/**
 * Mutates `ctx` in place to stamp the resolved role onto `ctx.ResolvedAgentRole`.
 * Preferred over returning a copy because the caller (runPreparedReply) already
 * receives `ctx` by reference and many downstream branches rely on identity-equal
 * context objects for cache keys.
 */
export function stampResolvedAgentRole(params: {
  cfg: OpenClawConfig | undefined;
  agentId: string;
  ctx: MsgContext;
}): AgentRole {
  const role = resolveAgentRoleForRunContext({
    cfg: params.cfg,
    agentId: params.agentId,
    ctx: params.ctx,
  });
  params.ctx.ResolvedAgentRole = role;
  return role;
}
