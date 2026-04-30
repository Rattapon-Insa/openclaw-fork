import type { AgentRole, AgentRoleBinding } from "../config/types.agents.js";

/**
 * Caller identity input used to resolve an agent's effective role for a single
 * inbound turn. Every channel adapter (Discord, LINE, Slack, Matrix, ...) is
 * expected to map its native sender shape into this generic envelope so the
 * core resolver stays channel-agnostic.
 *
 * `channel` is an open string. Override matching keys off it (e.g. only the
 * `discord` block in `callerOverrides.{superAdmin,tenantAdmin}` is consulted
 * when `channel === "discord"`). Unknown channels never elevate the role.
 *
 * `isDirectMessage` is required because the `superAdmin.discord.requireDm`
 * gate must distinguish a DM conversation from a guild channel; channels
 * without a meaningful DM concept should pass `false`.
 *
 * `channelId` is the persistent channel/group identifier (Discord channelId,
 * LINE groupId, Slack channelId, ...) used when an override is keyed by
 * channel allowlist rather than by user.
 */
export type RoleResolutionCaller = {
  channel: string;
  senderUserId?: string;
  isDirectMessage: boolean;
  channelId?: string;
};

/**
 * Pure resolver: given an agent's declared `roleBinding` and a caller envelope,
 * return the role the agent should assume for this turn.
 *
 * Precedence (highest first):
 * 1. `super-admin` override match
 * 2. `tenant-admin` override match
 * 3. baseline `roleBinding.role`
 * 4. `worker` (when no `roleBinding` is declared at all)
 *
 * The resolver is intentionally side-effect-free and synchronous so it can be
 * called from any layer (preflight, tool policy, audit log) without coupling
 * to channel runtime state.
 */
export function resolveAgentRoleForCaller(
  binding: AgentRoleBinding | undefined,
  caller: RoleResolutionCaller,
): AgentRole {
  if (!binding) {
    return "worker";
  }
  if (matchesSuperAdminOverride(binding, caller)) {
    return "super-admin";
  }
  if (matchesTenantAdminOverride(binding, caller)) {
    return "tenant-admin";
  }
  return binding.role;
}

function matchesSuperAdminOverride(
  binding: AgentRoleBinding,
  caller: RoleResolutionCaller,
): boolean {
  const override = binding.callerOverrides?.superAdmin;
  if (!override) {
    return false;
  }
  if (caller.channel === "discord") {
    const discord = override.discord;
    if (!discord) {
      return false;
    }
    if (discord.requireDm && !caller.isDirectMessage) {
      return false;
    }
    if (!caller.senderUserId) {
      return false;
    }
    return discord.userIds.includes(caller.senderUserId);
  }
  // Other channels do not yet have a super-admin override shape; never elevate.
  return false;
}

function matchesTenantAdminOverride(
  binding: AgentRoleBinding,
  caller: RoleResolutionCaller,
): boolean {
  const override = binding.callerOverrides?.tenantAdmin;
  if (!override) {
    return false;
  }
  if (caller.channel === "discord") {
    const discord = override.discord;
    if (!discord) {
      return false;
    }
    const userMatch = caller.senderUserId
      ? (discord.userIds?.includes(caller.senderUserId) ?? false)
      : false;
    const channelMatch = caller.channelId
      ? (discord.channelIds?.includes(caller.channelId) ?? false)
      : false;
    return userMatch || channelMatch;
  }
  // Other channels do not yet have a tenant-admin override shape; never elevate.
  return false;
}
