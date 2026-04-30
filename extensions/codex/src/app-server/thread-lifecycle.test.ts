import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  type EmbeddedRunAttemptParams,
  type WorkspaceBootstrapFile,
} from "openclaw/plugin-sdk/agent-harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing } from "./thread-lifecycle.js";

const { buildDeveloperInstructions, formatWorkspaceContextSection } = __testing;

function makeFile(name: string, content: string | undefined): WorkspaceBootstrapFile {
  if (content === undefined) {
    return {
      name: name as WorkspaceBootstrapFile["name"],
      path: `/fake/${name}`,
      missing: true,
    };
  }
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/fake/${name}`,
    content,
    missing: false,
  };
}

function createParams(workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: path.join(workspaceDir, "session.jsonl"),
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4",
    model: {
      id: "gpt-5.4",
      name: "gpt-5.4",
      provider: "codex",
      api: "openai-codex-responses",
      input: ["text"],
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_000,
    } as Model<Api>,
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

describe("formatWorkspaceContextSection", () => {
  it("returns undefined when no included files have content", () => {
    expect(formatWorkspaceContextSection([], "/ws")).toBeUndefined();
    expect(
      formatWorkspaceContextSection(
        [makeFile("AGENTS.md", "ignored — agents.md is auto-injected by codex")],
        "/ws",
      ),
    ).toBeUndefined();
    expect(formatWorkspaceContextSection([makeFile("SOUL.md", "   ")], "/ws")).toBeUndefined();
    expect(formatWorkspaceContextSection([makeFile("SOUL.md", undefined)], "/ws")).toBeUndefined();
  });

  it("formats included workspace files into a labelled section", () => {
    const out = formatWorkspaceContextSection(
      [
        makeFile("AGENTS.md", "agents content (should be excluded)"),
        makeFile("SOUL.md", "Be helpful, not performative."),
        makeFile("IDENTITY.md", "Name: น้องกุ้ง"),
        makeFile("USER.md", "User: shipping family"),
        makeFile("BOOTSTRAP.md", "first run notes (should be excluded)"),
      ],
      "/var/lib/openclaw/tenants/shipping/workspaces/main",
    );
    expect(out).toBeDefined();
    expect(out).toContain("## Workspace Persona Context");
    expect(out).toContain("`/var/lib/openclaw/tenants/shipping/workspaces/main`");
    expect(out).toContain("### SOUL.md");
    expect(out).toContain("Be helpful, not performative.");
    expect(out).toContain("### IDENTITY.md");
    expect(out).toContain("Name: น้องกุ้ง");
    expect(out).toContain("### USER.md");
    expect(out).toContain("User: shipping family");
    expect(out).not.toContain("agents content (should be excluded)");
    expect(out).not.toContain("first run notes (should be excluded)");
  });

  it("preserves loader-determined file order for prompt-prefix cache stability", () => {
    const fixed = [
      makeFile("SOUL.md", "soul"),
      makeFile("TOOLS.md", "tools"),
      makeFile("IDENTITY.md", "identity"),
      makeFile("USER.md", "user"),
    ];
    const a = formatWorkspaceContextSection(fixed, "/ws");
    const b = formatWorkspaceContextSection(fixed, "/ws");
    expect(a).toBe(b);
    expect(a).toBeDefined();
    // Section order should follow the order in which the loader returned the files.
    const soulIdx = a!.indexOf("### SOUL.md");
    const toolsIdx = a!.indexOf("### TOOLS.md");
    const identityIdx = a!.indexOf("### IDENTITY.md");
    const userIdx = a!.indexOf("### USER.md");
    expect(soulIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(identityIdx);
    expect(identityIdx).toBeLessThan(userIdx);
  });
});

describe("buildDeveloperInstructions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-thread-lifecycle-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("includes workspace persona files when present in workspaceDir", async () => {
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "Agents text", "utf8");
    await fs.writeFile(path.join(tempDir, "SOUL.md"), "Soul text", "utf8");
    await fs.writeFile(path.join(tempDir, "IDENTITY.md"), "Identity text", "utf8");
    await fs.writeFile(path.join(tempDir, "USER.md"), "User text", "utf8");
    await fs.writeFile(path.join(tempDir, "TOOLS.md"), "Tools text", "utf8");

    const out = await buildDeveloperInstructions(createParams(tempDir));

    expect(out).toContain("You are running inside OpenClaw");
    expect(out).toContain("## Workspace Persona Context");
    expect(out).toContain("Soul text");
    expect(out).toContain("Identity text");
    expect(out).toContain("User text");
    expect(out).toContain("Tools text");
    // AGENTS.md handled separately by codex from cwd.
    expect(out).not.toContain("Agents text");
  });

  it("omits the Workspace Persona Context section when no included files have content", async () => {
    // Only AGENTS.md in workspace — codex auto-injects that, so dev instructions stay clean.
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "Agents text", "utf8");

    const out = await buildDeveloperInstructions(createParams(tempDir));

    expect(out).toContain("You are running inside OpenClaw");
    expect(out).not.toContain("## Workspace Persona Context");
    expect(out).not.toContain("Agents text");
  });

  it("does not throw when workspaceDir does not exist (logs and continues)", async () => {
    const missing = path.join(tempDir, "does-not-exist");
    const out = await buildDeveloperInstructions(createParams(missing));
    // Should still emit the static intro sections and return a string.
    expect(typeof out).toBe("string");
    expect(out).toContain("You are running inside OpenClaw");
  });
});
