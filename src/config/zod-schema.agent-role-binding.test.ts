import { describe, expect, it } from "vitest";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("AgentEntrySchema.roleBinding", () => {
  function withRoleBinding(roleBinding: unknown): unknown {
    return {
      id: "main",
      roleBinding,
    };
  }

  it("is optional and defaults to undefined when omitted", () => {
    const parsed = AgentEntrySchema.parse({ id: "main" });
    expect(parsed.roleBinding).toBeUndefined();
  });

  it("accepts the three baseline roles", () => {
    for (const role of ["super-admin", "tenant-admin", "worker"] as const) {
      const parsed = AgentEntrySchema.parse(withRoleBinding({ role }));
      expect(parsed.roleBinding?.role).toBe(role);
    }
  });

  it("rejects unknown roles", () => {
    expect(() => AgentEntrySchema.parse(withRoleBinding({ role: "owner" }))).toThrow();
  });

  it("rejects extra fields on roleBinding (strict mode)", () => {
    expect(() =>
      AgentEntrySchema.parse(
        withRoleBinding({
          role: "tenant-admin",
          extra: true,
        }),
      ),
    ).toThrow();
  });

  it("accepts callerOverrides with discord superAdmin allowlist + requireDm", () => {
    const parsed = AgentEntrySchema.parse(
      withRoleBinding({
        role: "tenant-admin",
        callerOverrides: {
          superAdmin: {
            discord: {
              userIds: ["840875462347849728"],
              requireDm: true,
            },
          },
        },
      }),
    );
    expect(parsed.roleBinding?.callerOverrides?.superAdmin?.discord).toEqual({
      userIds: ["840875462347849728"],
      requireDm: true,
    });
  });

  it("accepts callerOverrides with discord tenantAdmin channel allowlist", () => {
    const parsed = AgentEntrySchema.parse(
      withRoleBinding({
        role: "worker",
        callerOverrides: {
          tenantAdmin: {
            discord: {
              channelIds: ["1499465577863970886"],
            },
          },
        },
      }),
    );
    expect(parsed.roleBinding?.callerOverrides?.tenantAdmin?.discord?.channelIds).toEqual([
      "1499465577863970886",
    ]);
  });

  it("rejects superAdmin discord override without userIds (mandatory)", () => {
    expect(() =>
      AgentEntrySchema.parse(
        withRoleBinding({
          role: "tenant-admin",
          callerOverrides: {
            superAdmin: {
              discord: {
                requireDm: true,
              },
            },
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects extra fields on callerOverrides.superAdmin.discord (strict)", () => {
    expect(() =>
      AgentEntrySchema.parse(
        withRoleBinding({
          role: "tenant-admin",
          callerOverrides: {
            superAdmin: {
              discord: {
                userIds: ["x"],
                slackUserIds: ["y"], // not yet schema'd
              },
            },
          },
        }),
      ),
    ).toThrow();
  });

  it("round-trips: parsed.roleBinding equals input", () => {
    const input = {
      role: "tenant-admin",
      callerOverrides: {
        superAdmin: {
          discord: {
            userIds: ["a", "b"],
            requireDm: true,
          },
        },
        tenantAdmin: {
          discord: {
            userIds: ["c"],
            channelIds: ["d"],
          },
        },
      },
    } as const;
    const parsed = AgentEntrySchema.parse(withRoleBinding(input));
    expect(parsed.roleBinding).toEqual(input);
  });
});
