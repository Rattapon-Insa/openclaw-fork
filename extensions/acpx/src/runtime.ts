import {
  ACPX_BACKEND_ID,
  AcpxRuntime as BaseAcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
  type AcpAgentRegistry,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
} from "acpx/runtime";
import type { AcpRuntime } from "../runtime-api.js";

type AcpSessionStore = AcpRuntimeOptions["sessionStore"];
type AcpSessionRecord = Parameters<AcpSessionStore["save"]>[0];
type AcpLoadedSessionRecord = Awaited<ReturnType<AcpSessionStore["load"]>>;

type ResetAwareSessionStore = AcpSessionStore & {
  markFresh: (sessionKey: string) => void;
};

function readSessionRecordName(record: AcpSessionRecord): string {
  if (typeof record !== "object" || record === null) {
    return "";
  }
  const { name } = record as { name?: unknown };
  return typeof name === "string" ? name.trim() : "";
}

function createResetAwareSessionStore(baseStore: AcpSessionStore): ResetAwareSessionStore {
  const freshSessionKeys = new Set<string>();

  return {
    async load(sessionId: string): Promise<AcpLoadedSessionRecord> {
      const normalized = sessionId.trim();
      if (normalized && freshSessionKeys.has(normalized)) {
        return undefined;
      }
      return await baseStore.load(sessionId);
    },
    async save(record: AcpSessionRecord): Promise<void> {
      await baseStore.save(record);
      const sessionName = readSessionRecordName(record);
      if (sessionName) {
        freshSessionKeys.delete(sessionName);
      }
    },
    markFresh(sessionKey: string): void {
      const normalized = sessionKey.trim();
      if (normalized) {
        freshSessionKeys.add(normalized);
      }
    },
  };
}

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor(): Promise<AcpRuntimeDoctorReport>;
};

type RuntimeMcpServer = { name: string; [key: string]: unknown };

/**
 * Extract denied MCP server names from agent-level tool deny globs. A deny
 * pattern like "ship-tools__*" denies the entire MCP server named
 * "ship-tools". Patterns without the "__" separator (which targets the MCP
 * server/tool boundary) do not filter any server.
 */
function resolveDeniedMcpServerNames(toolsDeny: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const pattern of toolsDeny) {
    const trimmed = pattern.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("__");
    if (separatorIndex <= 0) {
      continue;
    }
    const serverName = trimmed.slice(0, separatorIndex);
    const toolSuffix = trimmed.slice(separatorIndex + 2);
    if (toolSuffix === "*") {
      names.add(serverName);
    }
  }
  return names;
}

function filterMcpServersByDeny(
  mcpServers: readonly RuntimeMcpServer[] | undefined,
  toolsDeny: readonly string[] | undefined,
): RuntimeMcpServer[] | undefined {
  if (!mcpServers) {
    return undefined;
  }
  if (!toolsDeny || toolsDeny.length === 0) {
    return undefined;
  }
  const denied = resolveDeniedMcpServerNames(toolsDeny);
  if (denied.size === 0) {
    return undefined;
  }
  return mcpServers.filter((server) => !denied.has(server.name));
}

export class AcpxRuntime implements AcpxRuntimeLike {
  private readonly sessionStore: ResetAwareSessionStore;
  private readonly delegate: BaseAcpxRuntime;
  private readonly allMcpServers: readonly RuntimeMcpServer[];

  constructor(
    options: AcpRuntimeOptions,
    testOptions?: ConstructorParameters<typeof BaseAcpxRuntime>[1],
  ) {
    this.sessionStore = createResetAwareSessionStore(options.sessionStore);
    this.allMcpServers = (options.mcpServers ?? []) as readonly RuntimeMcpServer[];
    this.delegate = new BaseAcpxRuntime(
      {
        ...options,
        sessionStore: this.sessionStore,
      },
      testOptions,
    );
  }

  isHealthy(): boolean {
    return this.delegate.isHealthy();
  }

  probeAvailability(): Promise<void> {
    return this.delegate.probeAvailability();
  }

  doctor(): Promise<AcpRuntimeDoctorReport> {
    return this.delegate.doctor();
  }

  ensureSession(input: Parameters<AcpRuntime["ensureSession"]>[0]): Promise<AcpRuntimeHandle> {
    const filtered = filterMcpServersByDeny(this.allMcpServers, input.toolsDeny);
    process.stderr.write(
      `[debug-acp-deny:wrapper] sessionKey=${input.sessionKey} toolsDeny=${JSON.stringify(input.toolsDeny)} allMcpServers=${JSON.stringify(this.allMcpServers.map((s) => s.name))} filtered=${filtered ? JSON.stringify(filtered.map((s) => s.name)) : "undefined"}\n`,
    );
    if (!filtered) {
      return this.delegate.ensureSession(input);
    }
    return this.delegate.ensureSession({
      ...input,
      mcpServers: filtered,
    } as Parameters<BaseAcpxRuntime["ensureSession"]>[0]);
  }

  runTurn(input: Parameters<AcpRuntime["runTurn"]>[0]): AsyncIterable<AcpRuntimeEvent> {
    return this.delegate.runTurn(input);
  }

  getCapabilities(): ReturnType<BaseAcpxRuntime["getCapabilities"]> {
    return this.delegate.getCapabilities();
  }

  getStatus(input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0]): Promise<AcpRuntimeStatus> {
    return this.delegate.getStatus(input);
  }

  setMode(input: Parameters<NonNullable<AcpRuntime["setMode"]>>[0]): Promise<void> {
    return this.delegate.setMode(input);
  }

  setConfigOption(input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]): Promise<void> {
    return this.delegate.setConfigOption(input);
  }

  cancel(input: Parameters<AcpRuntime["cancel"]>[0]): Promise<void> {
    return this.delegate.cancel(input);
  }

  async prepareFreshSession(input: { sessionKey: string }): Promise<void> {
    this.sessionStore.markFresh(input.sessionKey);
  }

  close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    return this.delegate
      .close({
        handle: input.handle,
        reason: input.reason,
        discardPersistentState: input.discardPersistentState,
      })
      .then(() => {
        if (input.discardPersistentState) {
          this.sessionStore.markFresh(input.handle.sessionKey);
        }
      });
  }
}

export {
  ACPX_BACKEND_ID,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
};

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
