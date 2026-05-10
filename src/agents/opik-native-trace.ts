/**
 * Native Opik trace integration — posts traces synchronously to Opik API
 * as agent events happen, replacing the external Python JSONL forwarder.
 *
 * Enabled when OPIK_URL env var is set (e.g. "http://localhost:8080").
 * All functions are no-ops when OPIK_URL is empty/unset.
 */
import { randomBytes } from "node:crypto";

/** Generate a UUIDv7 (timestamp-based) as required by Opik API. */
function uuidv7(): string {
  const now = Date.now();
  const bytes = randomBytes(16);
  // 48-bit timestamp in ms (big-endian)
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // version 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // variant 10xx
  bytes[7] = (bytes[7] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface OpikSpan {
  name: string;
  type: "llm" | "tool" | "general";
  model?: string;
  provider?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  totalCost?: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  durationMs?: number;
  startTime: Date;
}

interface OpikTraceAccumulator {
  traceId: string;
  agentId: string;
  sessionId: string;
  startTime: Date;
  input?: { user_message: string };
  output?: { assistant_response: string };
  metadata: Record<string, unknown>;
  spans: OpikSpan[];
}

const accumulators = new Map<string, OpikTraceAccumulator>();

type FetchFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
let fetchOverride: FetchFn | undefined;

function getOpikUrl(): string {
  return (process.env.OPIK_URL ?? "").trim();
}

function getOpikWorkspace(): string {
  return (process.env.OPIK_WORKSPACE ?? "default").trim();
}

function isEnabled(): boolean {
  return getOpikUrl().length > 0;
}

function getFetch(): FetchFn {
  return fetchOverride ?? (globalThis.fetch as FetchFn);
}

export function beginOpikTrace(params: {
  agentId: string;
  sessionId: string;
  runId: string;
  userMessage: string;
}): void {
  // DEBUG: temporary visibility for trace flow diagnostic. Revert to silent
  // once root cause is identified (track via openclaw#17).
  console.error(
    `[opik-debug] beginOpikTrace enabled=${isEnabled()} url=${getOpikUrl()} runId=${params.runId} agentId=${params.agentId}`,
  );
  if (!isEnabled()) {
    return;
  }
  accumulators.set(params.runId, {
    traceId: uuidv7(),
    agentId: params.agentId,
    sessionId: params.sessionId,
    startTime: new Date(),
    input: { user_message: params.userMessage },
    metadata: {
      sessionId: params.sessionId,
    },
    spans: [],
  });
}

export function recordOpikLlmSpan(params: {
  runId: string;
  model: string;
  provider: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    cost?: { total?: number };
  };
  text: string;
}): void {
  if (!isEnabled()) {
    return;
  }
  const acc = accumulators.get(params.runId);
  if (!acc) {
    return;
  }
  const modelKey = params.provider ? `${params.provider}/${params.model}` : params.model;
  acc.metadata.model = modelKey;
  acc.metadata.provider = params.provider;
  acc.output = { assistant_response: params.text };

  const promptTokens = params.usage?.input ?? 0;
  const completionTokens = params.usage?.output ?? 0;
  const totalTokens = params.usage?.total ?? promptTokens + completionTokens;

  acc.spans.push({
    name: "llm-call",
    type: "llm",
    model: modelKey,
    provider: params.provider,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
    totalCost: params.usage?.cost?.total,
    startTime: new Date(),
  });
}

export function recordOpikToolSpan(params: {
  runId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: string;
  durationMs?: number;
}): void {
  if (!isEnabled()) {
    return;
  }
  const acc = accumulators.get(params.runId);
  if (!acc) {
    return;
  }
  acc.spans.push({
    name: `tool:${params.toolName}`,
    type: "tool",
    input: params.input,
    output: params.output ? { result: params.output } : undefined,
    durationMs: params.durationMs,
    startTime: new Date(),
  });
}

export async function flushOpikTrace(params: {
  runId: string;
  success: boolean;
  error?: string;
  rawErrorFull?: string;
}): Promise<void> {
  const acc = accumulators.get(params.runId);
  accumulators.delete(params.runId);

  if (!isEnabled() || !acc) {
    return;
  }

  const opikUrl = getOpikUrl();
  const workspace = getOpikWorkspace();
  const now = new Date();
  const headers = {
    "Content-Type": "application/json",
    "Comet-Workspace": workspace,
  };

  const tracePayload = {
    id: acc.traceId,
    name: acc.agentId,
    project_name: acc.agentId,
    start_time: acc.startTime.toISOString(),
    end_time: now.toISOString(),
    input: acc.input ?? {},
    output: acc.output ?? {},
    metadata: {
      ...acc.metadata,
      success: params.success,
      ...(params.error ? { error: params.error } : {}),
      ...(params.rawErrorFull ? { rawErrorFull: params.rawErrorFull } : {}),
    },
  };

  const spanPayloads = acc.spans.map((span) => ({
    id: uuidv7(),
    trace_id: acc.traceId,
    name: span.name,
    type: span.type,
    start_time: span.startTime.toISOString(),
    end_time: now.toISOString(),
    ...(span.model ? { model: span.model, provider: span.provider } : {}),
    ...(span.usage ? { usage: span.usage } : {}),
    ...(span.totalCost != null ? { total_estimated_cost: span.totalCost } : {}),
    ...(span.input ? { input: span.input } : {}),
    ...(span.output ? { output: span.output } : {}),
    metadata: span.durationMs != null ? { durationMs: span.durationMs } : {},
  }));

  // DEBUG: temporary visibility for trace flow diagnostic (openclaw#17).
  console.error(
    `[opik-debug] flushOpikTrace url=${opikUrl} traceId=${acc.traceId} spans=${spanPayloads.length} runId=${params.runId}`,
  );
  try {
    const fetchFn = getFetch();
    const traceRes = await fetchFn(`${opikUrl}/v1/private/traces`, {
      method: "POST",
      headers,
      body: JSON.stringify(tracePayload),
    });
    console.error(
      `[opik-debug] trace POST status=${traceRes.status} ok=${traceRes.ok}`,
    );
    if (spanPayloads.length > 0) {
      const spanRes = await fetchFn(`${opikUrl}/v1/private/spans/batch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ spans: spanPayloads }),
      });
      console.error(
        `[opik-debug] spans POST status=${spanRes.status} ok=${spanRes.ok}`,
      );
    }
  } catch (err) {
    // Fire-and-forget: log but don't throw.
    // Agent execution must not be blocked by Opik failures.
    console.error(`[opik-debug] flush failed:`, err);
  }
}

export const __testing = {
  setFetchForTest(fn: FetchFn | undefined) {
    fetchOverride = fn;
  },
  clearAccumulators() {
    accumulators.clear();
  },
  getAccumulator(runId: string) {
    return accumulators.get(runId);
  },
};
