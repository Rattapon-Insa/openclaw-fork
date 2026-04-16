import { describe, expect, test } from "vitest";
import { filterLateBoundToolsByPolicy } from "./pi-tools.policy.js";

type DummyTool = { name: string };

function makeTool(name: string): DummyTool {
  return { name } as DummyTool;
}

function names(tools: DummyTool[]): string[] {
  return tools.map((t) => t.name).toSorted();
}

describe("filterLateBoundToolsByPolicy", () => {
  test("filters MCP tools by agent deny glob", () => {
    const tools = [
      makeTool("ship-tools__check_eta"),
      makeTool("ship-tools__list_shipments"),
      makeTool("gmail-tools__search"),
    ];
    const filtered = filterLateBoundToolsByPolicy({
      tools: tools as any,
      config: {
        agents: {
          list: [{ id: "main", tools: { deny: ["ship-tools__*"] } }],
        },
      } as any,
      agentId: "main",
    });
    expect(names(filtered as any)).toEqual(["gmail-tools__search"]);
  });

  test("filters MCP tools by global deny", () => {
    const tools = [makeTool("ship-tools__a"), makeTool("exec")];
    const filtered = filterLateBoundToolsByPolicy({
      tools: tools as any,
      config: {
        tools: { deny: ["ship-tools__*"] },
      } as any,
    });
    expect(names(filtered as any)).toEqual(["exec"]);
  });

  test("allows all tools when no deny matches", () => {
    const tools = [makeTool("ship-tools__a"), makeTool("gmail-tools__b")];
    const filtered = filterLateBoundToolsByPolicy({
      tools: tools as any,
      config: {
        agents: {
          list: [{ id: "main", tools: { deny: ["other__*"] } }],
        },
      } as any,
      agentId: "main",
    });
    expect(names(filtered as any)).toEqual(["gmail-tools__b", "ship-tools__a"]);
  });

  test("mixed: denies matching tools, keeps non-matching", () => {
    const tools = [
      makeTool("ship-tools__a"),
      makeTool("ship-tools__b"),
      makeTool("gmail-tools__c"),
    ];
    const filtered = filterLateBoundToolsByPolicy({
      tools: tools as any,
      config: {
        agents: {
          list: [{ id: "tagger", tools: { deny: ["ship-tools__*"] } }],
        },
      } as any,
      agentId: "tagger",
    });
    expect(names(filtered as any)).toEqual(["gmail-tools__c"]);
  });

  test("returns empty array unchanged", () => {
    const filtered = filterLateBoundToolsByPolicy({
      tools: [],
      config: {
        agents: {
          list: [{ id: "main", tools: { deny: ["ship-tools__*"] } }],
        },
      } as any,
      agentId: "main",
    });
    expect(filtered).toEqual([]);
  });

  test("no config means no filtering", () => {
    const tools = [makeTool("ship-tools__a")];
    const filtered = filterLateBoundToolsByPolicy({
      tools: tools as any,
    });
    expect(names(filtered as any)).toEqual(["ship-tools__a"]);
  });

  test("combines global and agent deny", () => {
    const tools = [makeTool("ship-tools__a"), makeTool("gateway"), makeTool("exec")];
    const filtered = filterLateBoundToolsByPolicy({
      tools: tools as any,
      config: {
        tools: { deny: ["gateway"] },
        agents: {
          list: [{ id: "main", tools: { deny: ["ship-tools__*"] } }],
        },
      } as any,
      agentId: "main",
    });
    expect(names(filtered as any)).toEqual(["exec"]);
  });
});
