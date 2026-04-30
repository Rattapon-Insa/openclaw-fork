import { describe, expect, it } from "vitest";
import type { AgentRoleBinding } from "../config/types.agents.js";
import { resolveAgentRoleForCaller, type RoleResolutionCaller } from "./role-resolution.js";

const ANY_DM_CALLER: RoleResolutionCaller = {
  channel: "discord",
  senderUserId: "u-anonymous",
  isDirectMessage: true,
};

describe("resolveAgentRoleForCaller", () => {
  describe("no roleBinding declared", () => {
    it("returns worker (least privilege)", () => {
      expect(resolveAgentRoleForCaller(undefined, ANY_DM_CALLER)).toBe("worker");
    });
  });

  describe("baseline role only", () => {
    it("returns the declared baseline when no override matches", () => {
      const binding: AgentRoleBinding = { role: "tenant-admin" };
      expect(resolveAgentRoleForCaller(binding, ANY_DM_CALLER)).toBe("tenant-admin");
    });

    it("returns worker when baseline is worker", () => {
      const binding: AgentRoleBinding = { role: "worker" };
      expect(resolveAgentRoleForCaller(binding, ANY_DM_CALLER)).toBe("worker");
    });

    it("returns super-admin when baseline is super-admin (no caller overrides needed)", () => {
      const binding: AgentRoleBinding = { role: "super-admin" };
      expect(resolveAgentRoleForCaller(binding, ANY_DM_CALLER)).toBe("super-admin");
    });
  });

  describe("super-admin discord override", () => {
    const binding: AgentRoleBinding = {
      role: "tenant-admin",
      callerOverrides: {
        superAdmin: {
          discord: {
            userIds: ["840875462347849728"],
            requireDm: true,
          },
        },
      },
    };

    it("elevates to super-admin when sender matches and DM gate passes", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "discord",
          senderUserId: "840875462347849728",
          isDirectMessage: true,
        }),
      ).toBe("super-admin");
    });

    it("falls back to baseline when sender matches but channel is not a DM", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "discord",
          senderUserId: "840875462347849728",
          isDirectMessage: false,
        }),
      ).toBe("tenant-admin");
    });

    it("does not elevate when sender does not match the allowlist", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "discord",
          senderUserId: "stranger",
          isDirectMessage: true,
        }),
      ).toBe("tenant-admin");
    });

    it("does not elevate when senderUserId is missing", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "discord",
          isDirectMessage: true,
        }),
      ).toBe("tenant-admin");
    });

    it("ignores discord override for non-discord channels", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "line",
          senderUserId: "840875462347849728",
          isDirectMessage: true,
        }),
      ).toBe("tenant-admin");
    });

    it("requireDm=false allows guild-channel match", () => {
      const guildAllowed: AgentRoleBinding = {
        role: "worker",
        callerOverrides: {
          superAdmin: {
            discord: {
              userIds: ["x"],
              requireDm: false,
            },
          },
        },
      };
      expect(
        resolveAgentRoleForCaller(guildAllowed, {
          channel: "discord",
          senderUserId: "x",
          isDirectMessage: false,
        }),
      ).toBe("super-admin");
    });
  });

  describe("tenant-admin discord override", () => {
    const userOnly: AgentRoleBinding = {
      role: "worker",
      callerOverrides: {
        tenantAdmin: {
          discord: {
            userIds: ["dad"],
          },
        },
      },
    };
    const channelOnly: AgentRoleBinding = {
      role: "worker",
      callerOverrides: {
        tenantAdmin: {
          discord: {
            channelIds: ["family-channel"],
          },
        },
      },
    };

    it("elevates worker → tenant-admin when sender matches userIds", () => {
      expect(
        resolveAgentRoleForCaller(userOnly, {
          channel: "discord",
          senderUserId: "dad",
          isDirectMessage: false,
        }),
      ).toBe("tenant-admin");
    });

    it("elevates worker → tenant-admin when channel matches channelIds", () => {
      expect(
        resolveAgentRoleForCaller(channelOnly, {
          channel: "discord",
          senderUserId: "stranger",
          channelId: "family-channel",
          isDirectMessage: false,
        }),
      ).toBe("tenant-admin");
    });

    it("does not require DM (tenant-admin is broader than super-admin)", () => {
      expect(
        resolveAgentRoleForCaller(userOnly, {
          channel: "discord",
          senderUserId: "dad",
          isDirectMessage: false,
        }),
      ).toBe("tenant-admin");
    });

    it("does not elevate when neither user nor channel matches", () => {
      expect(
        resolveAgentRoleForCaller(channelOnly, {
          channel: "discord",
          senderUserId: "stranger",
          channelId: "other-channel",
          isDirectMessage: false,
        }),
      ).toBe("worker");
    });
  });

  describe("precedence (super > tenant > baseline)", () => {
    const binding: AgentRoleBinding = {
      role: "worker",
      callerOverrides: {
        superAdmin: {
          discord: {
            userIds: ["alice"],
            requireDm: true,
          },
        },
        tenantAdmin: {
          discord: {
            userIds: ["alice", "bob"],
          },
        },
      },
    };

    it("alice in DM → super-admin (super wins over tenant overlap)", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "discord",
          senderUserId: "alice",
          isDirectMessage: true,
        }),
      ).toBe("super-admin");
    });

    it("alice in guild channel → tenant-admin (super gate fails on DM, falls to tenant match)", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "discord",
          senderUserId: "alice",
          isDirectMessage: false,
        }),
      ).toBe("tenant-admin");
    });

    it("bob anywhere → tenant-admin (not in super list)", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "discord",
          senderUserId: "bob",
          isDirectMessage: true,
        }),
      ).toBe("tenant-admin");
    });

    it("anonymous → baseline worker (no overrides match)", () => {
      expect(
        resolveAgentRoleForCaller(binding, {
          channel: "discord",
          senderUserId: "stranger",
          isDirectMessage: true,
        }),
      ).toBe("worker");
    });
  });

  describe("non-discord channels (forward-compat)", () => {
    it("never elevates on line/slack/matrix even with discord overrides set", () => {
      const binding: AgentRoleBinding = {
        role: "worker",
        callerOverrides: {
          superAdmin: { discord: { userIds: ["x"] } },
          tenantAdmin: { discord: { userIds: ["x"], channelIds: ["c"] } },
        },
      };
      for (const channel of ["line", "slack", "matrix", "telegram", "webchat"]) {
        expect(
          resolveAgentRoleForCaller(binding, {
            channel,
            senderUserId: "x",
            channelId: "c",
            isDirectMessage: true,
          }),
        ).toBe("worker");
      }
    });
  });
});
