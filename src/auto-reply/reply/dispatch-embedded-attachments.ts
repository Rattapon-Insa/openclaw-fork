import type { ImageContent } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { FinalizedMsgContext } from "../templating.js";
import {
  type DispatchAcpAttachmentRuntime,
  loadDispatchAcpMediaRuntime,
} from "./dispatch-acp-attachments.js";

const EMBEDDED_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const EMBEDDED_ATTACHMENT_TIMEOUT_MS = 1_000;

export async function resolveEmbeddedImageAttachments(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  runtime?: DispatchAcpAttachmentRuntime;
}): Promise<ImageContent[]> {
  const runtime = params.runtime ?? (await loadDispatchAcpMediaRuntime());
  const mediaAttachments = runtime
    .normalizeAttachments(params.ctx)
    .map((attachment) =>
      normalizeOptionalString(attachment.path) ? { ...attachment, url: undefined } : attachment,
    );
  const cache = new runtime.MediaAttachmentCache(mediaAttachments, {
    localPathRoots: runtime.resolveMediaAttachmentLocalRoots({
      cfg: params.cfg,
      ctx: params.ctx,
    }),
  });
  const results: ImageContent[] = [];
  for (const attachment of mediaAttachments) {
    const mimeType = attachment.mime ?? "application/octet-stream";
    if (!mimeType.startsWith("image/")) {
      continue;
    }
    if (!normalizeOptionalString(attachment.path)) {
      continue;
    }
    try {
      const { buffer } = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: EMBEDDED_ATTACHMENT_MAX_BYTES,
        timeoutMs: EMBEDDED_ATTACHMENT_TIMEOUT_MS,
      });
      results.push({
        type: "image",
        mimeType,
        data: buffer.toString("base64"),
      });
    } catch (error) {
      if (runtime.isMediaUnderstandingSkipError(error)) {
        logVerbose(
          `dispatch-embedded: skipping attachment #${attachment.index + 1} (${error.reason})`,
        );
      } else {
        const errorName = error instanceof Error ? error.name : typeof error;
        logVerbose(
          `dispatch-embedded: failed to read attachment #${attachment.index + 1} (${errorName})`,
        );
      }
    }
  }
  return results;
}
