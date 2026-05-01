// ============================================================
// XNLC — Assets Manager
// Downloads and manages Minecraft assets
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { VersionJson, AssetIndex, DownloadProgressCallback } from "../types/index.js";
import { Downloader } from "./downloader.js";
import { getAssetIndexDir, getAssetObjectsDir, ensureDirSync } from "../utils/index.js";
import { URLS } from "../constants/urls.js";

export class AssetsManager {
  constructor(private downloader: Downloader) {}

  private async ensureAssetIndex(versionJson: VersionJson, gameDir: string): Promise<{ assetIndex: NonNullable<VersionJson["assetIndex"]>; indexDest: string; indexData: AssetIndex; hadIndexFile: boolean }> {
    const { assetIndex } = versionJson;
    if (!assetIndex) {
      throw new Error("No asset index in version JSON");
    }

    const indexDest = path.join(getAssetIndexDir(gameDir), `${assetIndex.id}.json`);
    const hadIndexFile = fs.existsSync(indexDest);
    if (!hadIndexFile) {
      ensureDirSync(path.dirname(indexDest));
      await this.downloader.download({
        url: assetIndex.url,
        dest: indexDest,
        sha1: assetIndex.sha1,
        size: assetIndex.size,
      });
    }

    if (!fs.existsSync(indexDest)) {
      throw new Error(`Asset index file not found after download: ${indexDest}`);
    }
    const indexData = JSON.parse(fs.readFileSync(indexDest, "utf-8")) as AssetIndex;
    return { assetIndex, indexDest, indexData, hadIndexFile };
  }

  async countAssets(versionJson: VersionJson, gameDir: string): Promise<number> {
    const { hadIndexFile, indexData } = await this.ensureAssetIndex(versionJson, gameDir);
    let count = hadIndexFile ? 0 : 1;

    for (const entry of Object.values(indexData.objects)) {
      const hash = entry.hash;
      const prefix = hash.slice(0, 2);
      const dest = path.join(getAssetObjectsDir(gameDir), prefix, hash);
      if (!fs.existsSync(dest)) {
        count++;
      }
    }

    return count;
  }

  async countTotalSize(versionJson: VersionJson, gameDir: string): Promise<number> {
    const { assetIndex, hadIndexFile, indexData } = await this.ensureAssetIndex(versionJson, gameDir);
    let totalSize = hadIndexFile ? 0 : (assetIndex.size ?? 0);

    for (const entry of Object.values(indexData.objects)) {
      const hash = entry.hash;
      const prefix = hash.slice(0, 2);
      const dest = path.join(getAssetObjectsDir(gameDir), prefix, hash);
      if (!fs.existsSync(dest)) {
        totalSize += entry.size;
      }
    }

    return totalSize;
  }

  async downloadAssets(
    versionJson: VersionJson,
    gameDir: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const { assetIndex } = versionJson;
    if (!assetIndex) return;

    // Download asset index (reuses ensureAssetIndex to skip if already present)
    const { indexData } = await this.ensureAssetIndex(versionJson, gameDir);

    // Download all asset objects
    const items = Object.entries(indexData.objects).map(([, entry]) => {
      const hash = entry.hash;
      const prefix = hash.slice(0, 2);
      const dest = path.join(getAssetObjectsDir(gameDir), prefix, hash);

      return {
        url: `${URLS.official.mojang.assets}/${prefix}/${hash}`,
        dest,
        sha1: hash,
        size: entry.size,
        onProgress,
      };
    });

    await this.downloader.downloadMultiple(items, 10);
  }

  async getAssetIndex(versionJson: VersionJson, gameDir: string): Promise<AssetIndex> {
    return (await this.ensureAssetIndex(versionJson, gameDir)).indexData;
  }

  getAssetId(versionJson: VersionJson): string {
    return versionJson.assets ?? versionJson.assetIndex?.id ?? "legacy";
  }
}
