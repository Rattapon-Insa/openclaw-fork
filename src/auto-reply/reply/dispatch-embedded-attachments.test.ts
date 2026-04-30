import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaUnderstandingSkipError } from "../../media-understanding/errors.js";
import { resolveEmbeddedImageAttachments } from "./dispatch-embedded-attachments.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

describe("resolveEmbeddedImageAttachments", () => {
  it("forwards normalized image attachments as pi-ai ImageContent", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-embedded-"));
    const imagePath = path.join(tempDir, "inbound.png");
    try {
      await fs.writeFile(imagePath, "image-bytes");
      const images = await resolveEmbeddedImageAttachments({
        cfg: createAcpTestConfig({
          channels: {
            imessage: {
              attachmentRoots: [tempDir],
            },
          },
        }),
        ctx: buildTestCtx({
          Provider: "imessage",
          Surface: "imessage",
          MediaPath: imagePath,
          MediaType: "image/png",
        }),
        runtime: {
          MediaAttachmentCache: class {
            async getBuffer() {
              return {
                buffer: Buffer.from("image-bytes"),
                mime: "image/png",
                fileName: "inbound.png",
                size: "image-bytes".length,
              };
            }
          } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
          isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
            false,
          normalizeAttachments: (ctx) => [
            {
              path: ctx.MediaPath,
              mime: ctx.MediaType,
              index: 0,
            },
          ],
          resolveMediaAttachmentLocalRoots: () => [tempDir],
        },
      });

      expect(images).toEqual([
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("image-bytes").toString("base64"),
        },
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips non-image attachments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-embedded-"));
    const filePath = path.join(tempDir, "doc.pdf");
    try {
      await fs.writeFile(filePath, "doc-bytes");
      const images = await resolveEmbeddedImageAttachments({
        cfg: createAcpTestConfig({
          channels: {
            imessage: {
              attachmentRoots: [tempDir],
            },
          },
        }),
        ctx: buildTestCtx({
          Provider: "imessage",
          Surface: "imessage",
          MediaPath: filePath,
          MediaType: "application/pdf",
        }),
        runtime: {
          MediaAttachmentCache: class {
            async getBuffer() {
              return {
                buffer: Buffer.from("doc-bytes"),
                mime: "application/pdf",
                fileName: "doc.pdf",
                size: "doc-bytes".length,
              };
            }
          } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
          isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
            false,
          normalizeAttachments: (ctx) => [
            {
              path: ctx.MediaPath,
              mime: ctx.MediaType,
              index: 0,
            },
          ],
          resolveMediaAttachmentLocalRoots: () => [tempDir],
        },
      });

      expect(images).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty when ctx has no media", async () => {
    const images = await resolveEmbeddedImageAttachments({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({ Provider: "discord", Surface: "discord" }),
      runtime: {
        MediaAttachmentCache: class {
          async getBuffer() {
            throw new Error("should not be called");
          }
        } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
        isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
          false,
        normalizeAttachments: () => [],
        resolveMediaAttachmentLocalRoots: () => [],
      },
    });

    expect(images).toEqual([]);
  });
});
