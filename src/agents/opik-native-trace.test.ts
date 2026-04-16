import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginOpikTrace,
  recordOpikLlmSpan,
  recordOpikToolSpan,
  flushOpikTrace,
  __testing,
} from "./opik-native-trace.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubEnv("OPIK_URL", "http://localhost:8080");
  vi.stubEnv("OPIK_WORKSPACE", "default");
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  __testing.setFetchForTest(mockFetch);
  __testing.clearAccumulators();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __testing.setFetchForTest(undefined);
  __testing.clearAccumulators();
});

describe("opik-native-trace", () => {
  it("beginOpikTrace creates accumulator", () => {
    beginOpikTrace({
      agentId: "gmail-tagger",
      sessionId: "sess-1",
      runId: "run-1",
      userMessage: "tag my emails",
    });

    const acc = __testing.getAccumulator("run-1");
    expect(acc).toBeDefined();
    expect(acc!.agentId).toBe("gmail-tagger");
    expect(acc!.sessionId).toBe("sess-1");
    expect(acc!.input).toEqual({ user_message: "tag my emails" });
    expect(acc!.spans).toEqual([]);
  });

  it("recordOpikLlmSpan appends LLM span with usage", () => {
    beginOpikTrace({
      agentId: "main",
      sessionId: "sess-1",
      runId: "run-1",
      userMessage: "hello",
    });

    recordOpikLlmSpan({
      runId: "run-1",
      model: "gemini-3-flash-preview",
      provider: "gemini",
      usage: { input: 1000, output: 200, cacheRead: 500, total: 1700 },
      text: "Hi there!",
    });

    const acc = __testing.getAccumulator("run-1");
    expect(acc!.spans).toHaveLength(1);
    expect(acc!.spans[0]).toMatchObject({
      name: "llm-call",
      type: "llm",
      model: "gemini/gemini-3-flash-preview",
      provider: "gemini",
    });
    expect(acc!.spans[0].usage).toMatchObject({
      prompt_tokens: 1000,
      completion_tokens: 200,
    });
    expect(acc!.output).toEqual({ assistant_response: "Hi there!" });
  });

  it("recordOpikToolSpan appends tool span", () => {
    beginOpikTrace({
      agentId: "main",
      sessionId: "sess-1",
      runId: "run-1",
      userMessage: "check shipment",
    });

    recordOpikToolSpan({
      runId: "run-1",
      toolName: "ship-tools__find_shipment",
      input: { query: "BL123" },
      output: '{"found": true}',
      durationMs: 450,
    });

    const acc = __testing.getAccumulator("run-1");
    expect(acc!.spans).toHaveLength(1);
    expect(acc!.spans[0]).toMatchObject({
      name: "tool:ship-tools__find_shipment",
      type: "tool",
      input: { query: "BL123" },
      output: { result: '{"found": true}' },
    });
    expect(acc!.spans[0].durationMs).toBe(450);
  });

  it("flushOpikTrace POSTs trace + spans to Opik API", async () => {
    beginOpikTrace({
      agentId: "gmail-tagger",
      sessionId: "sess-1",
      runId: "run-1",
      userMessage: "tag emails",
    });

    recordOpikLlmSpan({
      runId: "run-1",
      model: "gemini-3-flash-preview",
      provider: "gemini",
      usage: { input: 500, output: 100, total: 600 },
      text: "Done tagging",
    });

    await flushOpikTrace({
      runId: "run-1",
      success: true,
    });

    // Should call fetch twice: once for trace, once for spans batch
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call: POST trace
    const traceCall = mockFetch.mock.calls[0];
    expect(traceCall[0]).toBe("http://localhost:8080/v1/private/traces");
    const traceBody = JSON.parse(traceCall[1].body);
    expect(traceBody.name).toContain("gmail-tagger");
    expect(traceBody.project_name).toBe("gmail-tagger");
    expect(traceBody.input).toEqual({ user_message: "tag emails" });
    expect(traceBody.output).toEqual({ assistant_response: "Done tagging" });

    // Second call: POST spans
    const spansCall = mockFetch.mock.calls[1];
    expect(spansCall[0]).toBe("http://localhost:8080/v1/private/spans/batch");
    const spansBody = JSON.parse(spansCall[1].body);
    expect(spansBody.spans).toHaveLength(1);
    expect(spansBody.spans[0].name).toBe("llm-call");
    expect(spansBody.spans[0].trace_id).toBe(traceBody.id);
  });

  it("flushOpikTrace clears accumulator after flush", async () => {
    beginOpikTrace({
      agentId: "main",
      sessionId: "sess-1",
      runId: "run-1",
      userMessage: "hi",
    });

    await flushOpikTrace({ runId: "run-1", success: true });

    expect(__testing.getAccumulator("run-1")).toBeUndefined();
  });

  it("flushOpikTrace handles Opik down gracefully (no throw)", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    beginOpikTrace({
      agentId: "main",
      sessionId: "sess-1",
      runId: "run-1",
      userMessage: "hi",
    });

    // Should not throw
    await expect(flushOpikTrace({ runId: "run-1", success: true })).resolves.toBeUndefined();

    // Accumulator still cleaned up
    expect(__testing.getAccumulator("run-1")).toBeUndefined();
  });

  it("no OPIK_URL → all functions are no-ops", async () => {
    vi.stubEnv("OPIK_URL", "");

    beginOpikTrace({
      agentId: "main",
      sessionId: "sess-1",
      runId: "run-1",
      userMessage: "hi",
    });

    expect(__testing.getAccumulator("run-1")).toBeUndefined();

    recordOpikLlmSpan({
      runId: "run-1",
      model: "test",
      provider: "test",
      usage: { input: 1, output: 1, total: 2 },
      text: "test",
    });

    await flushOpikTrace({ runId: "run-1", success: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("flushOpikTrace includes error metadata when error provided", async () => {
    beginOpikTrace({
      agentId: "main",
      sessionId: "sess-1",
      runId: "run-1",
      userMessage: "hi",
    });

    await flushOpikTrace({
      runId: "run-1",
      success: false,
      error: "rate limit",
      rawErrorFull: "HTTP 429 RESOURCE_EXHAUSTED model=gemini-2.5-flash",
    });

    const traceCall = mockFetch.mock.calls[0];
    const traceBody = JSON.parse(traceCall[1].body);
    expect(traceBody.metadata.error).toBe("rate limit");
    expect(traceBody.metadata.rawErrorFull).toBe(
      "HTTP 429 RESOURCE_EXHAUSTED model=gemini-2.5-flash",
    );
    expect(traceBody.metadata.success).toBe(false);
  });
});
