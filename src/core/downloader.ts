// ============================================================
// XNLC — Downloader
// Handles file downloads with SHA1 validation and progress
// Author: MAINER4IK
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { sha1Hash, ensureDirSync } from "../utils/index.js";
import { DownloadProgressCallback } from "../types/index.js";

export interface DownloadOptions {
  url: string;
  dest: string;
  sha1?: string;
  size?: number;
  onProgress?: DownloadProgressCallback;
  retries?: number;
}

export class Downloader {
  constructor() {}

  async download(options: DownloadOptions): Promise<void> {
    const { url, dest, sha1: expectedSha1, size: expectedSize, onProgress, retries = 3 } = options;
    if (!url) return; // Skip empty URLs
    const finalUrl = url;

    // If file exists and can be validated, skip
    if (fs.existsSync(dest)) {
      const stats = fs.statSync(dest);
      if (expectedSha1) {
        const actualSha1 = sha1Hash(fs.readFileSync(dest));
        if (actualSha1 === expectedSha1) {
          return; // Already downloaded and valid
        }
      } else if (typeof expectedSize === "number" && expectedSize > 0 && stats.size === expectedSize) {
        return; // Already downloaded and valid by size
      } else if (expectedSize === undefined) {
        return; // No validation metadata available, preserve existing behavior
      }
    }

    ensureDirSync(path.dirname(dest));

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.downloadOnce(finalUrl, dest, expectedSha1, onProgress);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    throw lastError ?? new Error(`Failed to download ${url} after ${retries} attempts`);
  }

  private async downloadOnce(
    url: string,
    dest: string,
    expectedSha1: string | undefined,
    onProgress: DownloadProgressCallback | undefined,
  ): Promise<void> {
    // Handle file:// URLs
    if (url.startsWith("file://")) {
      const sourcePath = url.slice(7); // Remove file://
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`File not found: ${sourcePath}`);
      }
      
      ensureDirSync(path.dirname(dest));
      fs.copyFileSync(sourcePath, dest);
      return;
    }

    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        console.warn(`Library not found (404): ${url}`);
        throw new Error(`Library not found (HTTP 404): ${url}`);
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    }

    const totalSize = parseInt(res.headers.get("content-length") ?? "0", 10);
    const fileName = path.basename(dest);
    const tempPath = `${dest}.tmp`;
    let downloaded = 0;

    if (!res.body) {
      throw new Error(`Empty response body for ${url}`);
    }

    const reader = res.body.getReader();
    const writeStream = fs.createWriteStream(tempPath);

    const cleanupTemp = (): void => {
      try {
        if (fs.existsSync(tempPath)) {
          fs.rmSync(tempPath, { force: true });
        }
      } catch {
        // ignore cleanup failures
      }
    };

    return new Promise((resolve, reject) => {
      const fail = (error: Error): void => {
        cleanupTemp();
        reject(error);
      };

      writeStream.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));

      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) {
            writeStream.end(() => {
              try {
                if (expectedSha1) {
                  const actualSha1 = sha1Hash(fs.readFileSync(tempPath));
                  if (actualSha1 !== expectedSha1) {
                    fail(new Error(`SHA1 mismatch for ${fileName}: expected ${expectedSha1}, got ${actualSha1}`));
                    return;
                  }
                }
                fs.renameSync(tempPath, dest);
                resolve();
              } catch (err) {
                fail(err instanceof Error ? err : new Error(String(err)));
              }
            });
            return;
          }

          downloaded += value.length;
          if (onProgress && totalSize > 0) {
            onProgress({
              fileName,
              file: dest,
              downloaded,
              total: totalSize,
              percent: Math.round((downloaded / totalSize) * 100),
            });
          }

          writeStream.write(Buffer.from(value), (err) => {
            if (err) {
              fail(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            pump();
          });
        }).catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
      };

      pump();
    });
  }

  async downloadMultiple(
    items: DownloadOptions[],
    concurrency: number = 5,
  ): Promise<void> {
    // Deduplicate by destination path to avoid race conditions
    const seen = new Set<string>();
    const uniqueItems = items.filter((item) => {
      if (seen.has(item.dest)) return false;
      seen.add(item.dest);
      return true;
    });

    const queue = [...uniqueItems];
    const workers: Promise<void>[] = [];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) {
          await this.download(item);
        }
      }
    };

    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
  }
}
