import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import type { AcpRuntimeEvent, AcpRuntimeSessionMode } from "../../acp/runtime/types.js";
import type { AgentConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";

export type RunAcpCronAgentParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  requestId: string;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
};

type CronAcpPayload = { text: string } | { text: string; isError: true };

export type RunAcpCronAgentResult = {
  payloads: CronAcpPayload[];
  meta: {
    agentMeta: { usage: { input: number; output: number } };
    finalAssistantVisibleText: string;
    error?: string;
    systemPromptReport?: undefined;
  };
  didSendViaMessagingTool: boolean;
};

type ResolvedAcpAgentConfig = {
  agent: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
};

function resolveAcpAgentConfig(cfg: OpenClawConfig, agentId: string): ResolvedAcpAgentConfig {
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

/**
 * Cron-path ACP dispatch. Bypasses runWithModelFallback because ACP runtimes
 * (Gemini CLI via ACPX, Codex CLI, etc.) own their own model selection — there
 * is no provider/model we can switch at this layer.
 */
export async function runAcpCronAgent(
  params: RunAcpCronAgentParams,
): Promise<RunAcpCronAgentResult> {
  const manager = getAcpSessionManager();
  const resolution = manager.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });

  if (resolution.kind === "stale") {
    return {
      payloads: [{ text: resolution.error.message, isError: true }],
      meta: {
        agentMeta: { usage: { input: 0, output: 0 } },
        finalAssistantVisibleText: "",
        error: `ACP session stale (${resolution.error.code}): ${resolution.error.message}`,
        systemPromptReport: undefined,
      },
      didSendViaMessagingTool: false,
    };
  }

  const agentConfig = resolveAcpAgentConfig(params.cfg, params.agentId);
  const shouldReinitialize = resolution.kind === "none" || agentConfig.mode === "oneshot";
  if (shouldReinitialize) {
    try {
      await manager.initializeSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agent: agentConfig.agent,
        mode: agentConfig.mode,
        ...(agentConfig.cwd ? { cwd: agentConfig.cwd } : {}),
      });
    } catch (err) {
      const message = formatErrorMessage(err);
      return {
        payloads: [{ text: message, isError: true }],
        meta: {
          agentMeta: { usage: { input: 0, output: 0 } },
          finalAssistantVisibleText: "",
          error: `ACP session init failed: ${message}`,
          systemPromptReport: undefined,
        },
        didSendViaMessagingTool: false,
      };
    }
  }

  let outputText = "";
  let errorMessage: string | undefined;

  try {
    await manager.runTurn({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      text: params.prompt,
      mode: "prompt",
      requestId: params.requestId,
      signal: params.abortSignal,
      onEvent: (event: AcpRuntimeEvent) => {
        if (event.type === "text_delta" && event.stream !== "thought") {
          outputText += event.text;
        } else if (event.type === "error" && !errorMessage) {
          errorMessage = event.message;
        }
      },
    });
  } catch (err) {
    errorMessage = formatErrorMessage(err);
  }

  const payloads: CronAcpPayload[] = [];
  if (outputText.trim().length > 0) {
    payloads.push({ text: outputText });
  }
  if (errorMessage) {
    payloads.push({ text: errorMessage, isError: true });
  }

  return {
    payloads,
    meta: {
      agentMeta: { usage: { input: 0, output: 0 } },
      finalAssistantVisibleText: outputText,
      error: errorMessage,
      systemPromptReport: undefined,
    },
    didSendViaMessagingTool: false,
  };
}
