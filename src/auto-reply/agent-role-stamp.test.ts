import { describe, expect, it } from "vitest";
import type { AgentRoleBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  buildRoleResolutionCaller,
  resolveAgentRoleForRunContext,
  stampResolvedAgentRole,
} from "./agent-role-stamp.js";
import type { MsgContext } from "./templating.js";

function makeConfig(roleBinding?: AgentRoleBinding): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "main",
          ...(roleBinding ? { roleBinding } : {}),
        },
        {
          id: "worker-bot",
        },
      ],
    },
  } as unknown as OpenClawConfig;
}

describe("buildRoleResolutionCaller", () => {
  it("prefers Surface over Provider", () => {
    expect(
      buildRoleResolutionCaller({
        Surface: "discord",
        Provider: "telegram",
        SenderId: "u",
        ChatType: "direct",
        NativeChannelId: "c",
      }),
    ).toEqual({
      channel: "discord",
      senderUserId: "u",
      isDirectMessage: true,
      channelId: "c",
    });
  });

  it("falls back to Provider when Surface is missing", () => {
    expect(
      buildRoleResolutionCaller({
        Provider: "LINE",
        SenderId: "u",
        ChatType: "group",
      }),
    ).toEqual({
      channel: "line",
      senderUserId: "u",
      isDirectMessage: false,
      channelId: undefined,
    });
  });

  it("treats only ChatType=direct as a DM (not group/channel)", () => {
    for (const chatType of ["group", "channel", undefined, "" as unknown as string]) {
      expect(
        buildRoleResolutionCaller({
          Surface: "discord",
          ChatType: chatType,
        }).isDirectMessage,
      ).toBe(false);
    }
    expect(buildRoleResolutionCaller({ ChatType: "direct" }).isDirectMessage).toBe(true);
  });

  it("normalizes channel to lowercase + trims whitespace", () => {
    expect(buildRoleResolutionCaller({ Surface: "  Discord  " }).channel).toBe("discord");
  });

  it("returns empty channel when neither Surface nor Provider is set", () => {
    expect(buildRoleResolutionCaller({}).channel).toBe("");
  });
});

describe("resolveAgentRoleForRunContext", () => {
  const dmCtx: Pick<MsgContext, "Surface" | "SenderId" | "ChatType" | "NativeChannelId"> = {
    Surface: "discord",
    SenderId: "operator",
    ChatType: "direct",
  };

  it("returns worker when cfg is undefined", () => {
    expect(
      resolveAgentRoleForRunContext({
        cfg: undefined,
        agentId: "main",
        ctx: dmCtx,
      }),
    ).toBe("worker");
  });

  it("returns worker when the agent is not in cfg", () => {
    expect(
      resolveAgentRoleForRunContext({
        cfg: makeConfig(),
        agentId: "ghost",
        ctx: dmCtx,
      }),
    ).toBe("worker");
  });

  it("returns worker when the agent has no roleBinding", () => {
    expect(
      resolveAgentRoleForRunContext({
        cfg: makeConfig(),
        agentId: "worker-bot",
        ctx: dmCtx,
      }),
    ).toBe("worker");
  });

  it("returns the agent's baseline role when no override matches", () => {
    expect(
      resolveAgentRoleForRunContext({
        cfg: makeConfig({ role: "tenant-admin" }),
        agentId: "main",
        ctx: dmCtx,
      }),
    ).toBe("tenant-admin");
  });

  it("elevates to super-admin when caller matches the discord override + DM gate", () => {
    expect(
      resolveAgentRoleForRunContext({
        cfg: makeConfig({
          role: "tenant-admin",
          callerOverrides: {
            superAdmin: { discord: { userIds: ["operator"], requireDm: true } },
          },
        }),
        agentId: "main",
        ctx: dmCtx,
      }),
    ).toBe("super-admin");
  });

  it("ignores Provider as a discord-override channel match (uses Surface)", () => {
    // Caller has Provider=discord but Surface=line — overrides should not fire
    // because the Surface is what runtime uses to identify channel adapters.
    expect(
      resolveAgentRoleForRunContext({
        cfg: makeConfig({
          role: "tenant-admin",
          callerOverrides: {
            superAdmin: { discord: { userIds: ["operator"] } },
          },
        }),
        agentId: "main",
        ctx: {
          Surface: "line",
          Provider: "discord",
          SenderId: "operator",
          ChatType: "direct",
        },
      }),
    ).toBe("tenant-admin");
  });
});

describe("stampResolvedAgentRole", () => {
  it("mutates ctx.ResolvedAgentRole and returns the role", () => {
    const ctx: MsgContext = {
      Surface: "discord",
      SenderId: "operator",
      ChatType: "direct",
    };
    const role = stampResolvedAgentRole({
      cfg: makeConfig({ role: "tenant-admin" }),
      agentId: "main",
      ctx,
    });
    expect(role).toBe("tenant-admin");
    expect(ctx.ResolvedAgentRole).toBe("tenant-admin");
  });

  it("stamps `worker` when the agent has no roleBinding (least privilege default)", () => {
    const ctx: MsgContext = { Surface: "discord", SenderId: "operator", ChatType: "direct" };
    const role = stampResolvedAgentRole({ cfg: makeConfig(), agentId: "worker-bot", ctx });
    expect(role).toBe("worker");
    expect(ctx.ResolvedAgentRole).toBe("worker");
  });

  it("is idempotent — re-stamping the same caller yields the same role", () => {
    const ctx: MsgContext = { Surface: "discord", SenderId: "operator", ChatType: "direct" };
    const cfg = makeConfig({ role: "tenant-admin" });
    stampResolvedAgentRole({ cfg, agentId: "main", ctx });
    const second = stampResolvedAgentRole({ cfg, agentId: "main", ctx });
    expect(second).toBe("tenant-admin");
    expect(ctx.ResolvedAgentRole).toBe("tenant-admin");
  });
});
