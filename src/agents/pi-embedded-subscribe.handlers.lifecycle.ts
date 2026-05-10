import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { beginOpikTrace, flushOpikTrace, recordOpikLlmSpan } from "./opik-native-trace.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
  sanitizeForConsole,
} from "./pi-embedded-error-observation.js";
import { classifyFailoverReason, formatAssistantErrorText } from "./pi-embedded-helpers.js";
import { isIncompleteTerminalAssistantTurn } from "./pi-embedded-runner/run/incomplete-turn.js";
import {
  consumePendingToolMediaReply,
  hasAssistantVisibleReply,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isPromiseLike } from "./pi-embedded-subscribe.promise.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

export {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  // DEBUG: visibility for trace flow diagnostic (openclaw#17). Revert when done.
  console.error(
    `[opik-debug] handleAgentStart fired runId=${ctx.params.runId} agentId=${ctx.params.agentId ?? "unknown"}`,
  );
  beginOpikTrace({
    agentId: ctx.params.agentId ?? "unknown",
    sessionId: ctx.params.sessionId ?? ctx.params.runId,
    runId: ctx.params.runId,
    userMessage: "",
  });
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
}

export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext): void | Promise<void> {
  // DEBUG: visibility for trace flow diagnostic (openclaw#17). Revert when done.
  console.error(`[opik-debug] handleAgentEnd fired runId=${ctx.params.runId}`);
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  let lifecycleErrorText: string | undefined;
  const hasAssistantVisibleText =
    Array.isArray(ctx.state.assistantTexts) &&
    ctx.state.assistantTexts.some((text) => hasAssistantVisibleReply({ text }));
  const hadDeterministicSideEffect =
    ctx.state.hadDeterministicSideEffect === true ||
    (ctx.state.messagingToolSentTexts?.length ?? 0) > 0 ||
    (ctx.state.messagingToolSentMediaUrls?.length ?? 0) > 0 ||
    (ctx.state.successfulCronAdds ?? 0) > 0;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText,
    lastAssistant: isAssistantMessage(lastAssistant) ? lastAssistant : null,
  });
  const replayInvalid =
    ctx.state.replayState.replayInvalid || incompleteTerminalAssistant ? true : undefined;
  const derivedWorkingTerminalState = isError
    ? "blocked"
    : replayInvalid && !hasAssistantVisibleText && !hadDeterministicSideEffect
      ? "abandoned"
      : ctx.state.livenessState;
  const livenessState =
    ctx.state.livenessState === "working" ? derivedWorkingTerminalState : ctx.state.livenessState;

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    const rawError = lastAssistant.errorMessage?.trim();
    const failoverReason = classifyFailoverReason(rawError ?? "", {
      provider: lastAssistant.provider,
    });
    const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
    const observedError = buildApiErrorObservationFields(rawError, {
      provider: lastAssistant.provider,
    });
    const safeErrorText =
      buildTextObservationFields(errorText, {
        provider: lastAssistant.provider,
      }).textPreview ?? "LLM request failed.";
    lifecycleErrorText = safeErrorText;
    const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
    const safeModel = sanitizeForConsole(lastAssistant.model) ?? "unknown";
    const safeProvider = sanitizeForConsole(lastAssistant.provider) ?? "unknown";
    const safeRawErrorPreview = sanitizeForConsole(observedError.rawErrorPreview);
    const rawErrorConsoleSuffix = safeRawErrorPreview ? ` rawError=${safeRawErrorPreview}` : "";
    ctx.log.warn("embedded run agent end", {
      event: "embedded_run_agent_end",
      tags: ["error_handling", "lifecycle", "agent_end", "assistant_error"],
      runId: ctx.params.runId,
      isError: true,
      error: safeErrorText,
      failoverReason,
      model: lastAssistant.model,
      provider: lastAssistant.provider,
      ...observedError,
      consoleMessage: `embedded run agent end: runId=${safeRunId} isError=true model=${safeModel} provider=${safeProvider} error=${safeErrorText}${rawErrorConsoleSuffix}`,
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
  }

  // Native Opik trace: record LLM span from last assistant + flush trace.
  if (isAssistantMessage(lastAssistant) && lastAssistant.stopReason !== undefined) {
    const assistantAny = lastAssistant as unknown as Record<string, unknown>;
    const usage = assistantAny.usage as Record<string, number> | undefined;
    const model = (assistantAny.model as string) ?? "unknown";
    const provider = (assistantAny.provider as string) ?? "unknown";
    const assistantText = Array.isArray(ctx.state.assistantTexts)
      ? ctx.state.assistantTexts.join("\n").slice(0, 500)
      : "";
    recordOpikLlmSpan({
      runId: ctx.params.runId,
      model,
      provider,
      usage: usage
        ? {
            input: usage.input ?? usage.prompt_tokens ?? 0,
            output: usage.output ?? usage.completion_tokens ?? 0,
            cacheRead: usage.cacheRead as number | undefined,
            total: usage.totalTokens ?? usage.total ?? 0,
            cost: usage.cost as { total?: number } | undefined,
          }
        : undefined,
      text: assistantText,
    });
    const rawErrorForOpik = isError ? (assistantAny.errorMessage as string)?.trim() : undefined;
    const observedErrorForOpik = rawErrorForOpik
      ? buildApiErrorObservationFields(rawErrorForOpik, { provider })
      : undefined;
    void flushOpikTrace({
      runId: ctx.params.runId,
      success: !isError,
      error: lifecycleErrorText,
      rawErrorFull: observedErrorForOpik?.rawErrorFull,
    });
  } else {
    void flushOpikTrace({
      runId: ctx.params.runId,
      success: !isError,
      error: lifecycleErrorText,
    });
  }

  const emitLifecycleTerminal = () => {
    if (isError) {
      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          error: lifecycleErrorText ?? "LLM request failed.",
          ...(livenessState ? { livenessState } : {}),
          ...(replayInvalid ? { replayInvalid } : {}),
          endedAt: Date.now(),
        },
      });
      void ctx.params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "error",
          error: lifecycleErrorText ?? "LLM request failed.",
          ...(livenessState ? { livenessState } : {}),
          ...(replayInvalid ? { replayInvalid } : {}),
        },
      });
      return;
    }
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        ...(livenessState ? { livenessState } : {}),
        ...(replayInvalid ? { replayInvalid } : {}),
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "end",
        ...(livenessState ? { livenessState } : {}),
        ...(replayInvalid ? { replayInvalid } : {}),
      },
    });
  };

  const finalizeAgentEnd = () => {
    ctx.state.blockState.thinking = false;
    ctx.state.blockState.final = false;
    ctx.state.blockState.inlineCode = createInlineCodeState();

    if (ctx.state.pendingCompactionRetry > 0) {
      ctx.resolveCompactionRetry();
    } else {
      ctx.maybeResolveCompactionWait();
    }
  };

  const flushPendingMediaAndChannel = () => {
    const pendingToolMediaReply = consumePendingToolMediaReply(ctx.state);
    if (pendingToolMediaReply && hasAssistantVisibleReply(pendingToolMediaReply)) {
      ctx.emitBlockReply(pendingToolMediaReply);
    }

    const postMediaFlushResult = ctx.flushBlockReplyBuffer();
    if (isPromiseLike<void>(postMediaFlushResult)) {
      return postMediaFlushResult.then(() => {
        const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
        if (isPromiseLike<void>(onBlockReplyFlushResult)) {
          return onBlockReplyFlushResult;
        }
        return undefined;
      });
    }

    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult;
    }
    return undefined;
  };

  let lifecycleTerminalEmitted = false;
  const emitLifecycleTerminalOnce = () => {
    if (lifecycleTerminalEmitted) {
      return;
    }
    lifecycleTerminalEmitted = true;
    emitLifecycleTerminal();
  };

  try {
    const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
    finalizeAgentEnd();
    const flushPendingMediaAndChannelResult = isPromiseLike<void>(flushBlockReplyBufferResult)
      ? Promise.resolve(flushBlockReplyBufferResult).then(() => flushPendingMediaAndChannel())
      : flushPendingMediaAndChannel();

    if (isPromiseLike<void>(flushPendingMediaAndChannelResult)) {
      return Promise.resolve(flushPendingMediaAndChannelResult).finally(() => {
        emitLifecycleTerminalOnce();
      });
    }
  } catch (error) {
    emitLifecycleTerminalOnce();
    throw error;
  }

  emitLifecycleTerminalOnce();
  return undefined;
}
