/**
 * Narrow public seam for agent role resolution.
 *
 * Channel adapters (Discord, LINE, Slack, ...) import `resolveAgentRoleForCaller`
 * to compute the role an agent should assume for a single inbound turn given
 * the caller's identity envelope. Tool-layer enforcement reads the resolved
 * role from the per-turn context populated by those adapters.
 *
 * Schema definitions live in `src/config/types.agents.ts`; this subpath
 * exposes only the runtime contract — types + the pure resolver function —
 * so consumers do not need to import the broader config surface.
 */
export type { AgentRole, AgentRoleBinding } from "../config/types.agents.js";
export { resolveAgentRoleForCaller, type RoleResolutionCaller } from "../agents/role-resolution.js";
