import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { waitForAgentRun } from "../run-wait.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import { extractAssistantText, stripToolMessages } from "./chat-history-text.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { isAnnounceSkip, isReplySkip } from "./sessions-send-tokens.js";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 1800;
// chat.history can be slow when many parent agents are concurrent; we've
// observed the default 10s overriding our request and bucketing most workers
// as `gateway timeout`. Give it a generous but bounded budget so fan-out
// doesn't starve itself.
const HISTORY_READ_TIMEOUT_MS = 30_000;

const SessionsRunAndWaitToolSchema = Type.Object({
  task: Type.String({
    description: "Task description sent to the child agent as its user message.",
  }),
  agentId: Type.Optional(
    Type.String({
      description:
        "Target agent id. Required unless the caller wants to spawn the same agent as itself.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description: "Optional extra context prepended to the task before delivery.",
    }),
  ),
  label: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: MAX_TIMEOUT_SECONDS,
      description: `Hard-capped at ${MAX_TIMEOUT_SECONDS} seconds.`,
    }),
  ),
});

async function readChildFinalAssistantText(sessionKey: string): Promise<string | undefined> {
  const history = await callGateway<{ messages: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey, limit: 100 },
    timeoutMs: HISTORY_READ_TIMEOUT_MS,
  });
  const messages = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractAssistantText(messages[i]);
    if (!text) {
      continue;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      continue;
    }
    if (isAnnounceSkip(trimmed) || isReplySkip(trimmed)) {
      continue;
    }
    return trimmed;
  }
  return undefined;
}

function clampTimeoutSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_SECONDS);
}

function composeTask(task: string, context: string | undefined): string {
  const trimmedContext = context?.trim();
  if (!trimmedContext) {
    return task;
  }
  return `${trimmedContext}\n\n---\n\n${task}`;
}

export function createSessionsRunAndWaitTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_run_and_wait",
    displaySummary:
      "Spawn a sub-agent, block until it finishes, and return its final output as tool result.",
    description:
      "Delegate a task to another agent and wait for completion. Unlike sessions_spawn (fire-and-forget with async announce), this tool blocks inside the tool call and returns the child's final assistant message as a structured tool result you can reason over in the same turn. Use for master→worker pipelines, parallel map/aggregate, and any case where the caller needs the child's output before continuing. Timeout is hard-capped at 1800s.",
    parameters: SessionsRunAndWaitToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const agentId = readStringParam(params, "agentId");
      const context = readStringParam(params, "context");
      const label = readStringParam(params, "label") ?? "";
      const modelOverride = readStringParam(params, "model");
      const thinkingOverride = readStringParam(params, "thinking");
      const timeoutSecondsRaw =
        typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : undefined;
      const effectiveTimeoutSec = clampTimeoutSeconds(timeoutSecondsRaw);
      const effectiveTimeoutMs = effectiveTimeoutSec * 1000;
      const composedTask = composeTask(task, context);

      const startMs = Date.now();

      const spawn = await spawnSubagentDirect(
        {
          task: composedTask,
          label: label || undefined,
          agentId,
          model: modelOverride,
          thinking: thinkingOverride,
          runTimeoutSeconds: effectiveTimeoutSec,
          expectsCompletionMessage: true,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
        },
      );

      if (spawn.status !== "accepted" || !spawn.runId || !spawn.childSessionKey) {
        return jsonResult({
          status: "error",
          error: spawn.error ?? spawn.note ?? `spawn failed with status=${spawn.status}`,
          runId: spawn.runId ?? "",
          childSessionKey: spawn.childSessionKey ?? "",
          durationMs: Date.now() - startMs,
        });
      }

      const wait = await waitForAgentRun({
        runId: spawn.runId,
        timeoutMs: effectiveTimeoutMs,
      });

      let output: string | undefined;
      try {
        output = await readChildFinalAssistantText(spawn.childSessionKey);
      } catch (err) {
        output = undefined;
        const readError = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: wait.status === "ok" ? "error" : wait.status,
          output: undefined,
          error: wait.error ?? `failed to read child output: ${readError}`,
          runId: spawn.runId,
          childSessionKey: spawn.childSessionKey,
          durationMs: Date.now() - startMs,
        });
      }

      const status: "ok" | "error" | "timeout" =
        wait.status === "ok" ? "ok" : wait.status === "timeout" ? "timeout" : "error";

      return jsonResult({
        status,
        output,
        error: wait.error,
        runId: spawn.runId,
        childSessionKey: spawn.childSessionKey,
        durationMs: Date.now() - startMs,
      });
    },
  };
}
