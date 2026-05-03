// ============================================================
// XNLC — Quilt Handler
// Separate from Fabric, uses its own API
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { VersionJson, QuiltGameVersion, QuiltLoaderVersion, QuiltLoaderMetadata, LoaderInstallResult, DownloadProgressCallback } from "../types/index.js";
import { Downloader, DownloadOptions } from "../core/downloader.js";
import { getVersionDir, getLibraryDir, ensureDirSync } from "../utils/index.js";
import { URLS } from "../constants/urls.js";

const QUILT_META = URLS.official.quilt.metaV3;
const QUILT_HEADERS = { "User-Agent": "XNeonLauncher/1.0 (https://github.com/MAINER4IK)" };

function isStableVersion(version: string): boolean {
  return !version.includes("-beta") && !version.includes("-pre") && !version.includes("-rc");
}

async function quiltFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: QUILT_HEADERS });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res;
}

export class QuiltHandler {
  constructor(
    private downloader: Downloader,
    private gameDir: string,
  ) {}

  async getGameVersions(): Promise<QuiltGameVersion[]> {
    const res = await quiltFetch(`${QUILT_META}/versions/game`);
    return res.json() as Promise<QuiltGameVersion[]>;
  }

  async getLoaderVersions(): Promise<QuiltLoaderVersion[]> {
    const res = await quiltFetch(`${QUILT_META}/versions/loader`);
    return res.json() as Promise<QuiltLoaderVersion[]>;
  }

  async getLoaderVersionsForGame(mcVersion: string): Promise<QuiltLoaderVersion[]> {
    const res = await quiltFetch(`${QUILT_META}/versions/loader/${mcVersion}`);
    const data = await res.json() as QuiltLoaderMetadata[];
    return data.map((item) => item.loader);
  }

  async getLatestLoaderVersion(mcVersion: string): Promise<string | undefined> {
    const versions = await this.getLoaderVersionsForGame(mcVersion);
    const stableVersions = versions.filter((v) => isStableVersion(v.version));
    return stableVersions[0]?.version ?? versions[0]?.version;
  }

  async install(
    mcVersion: string,
    loaderVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<LoaderInstallResult> {
    const profileName = `quilt-loader-${loaderVersion}-${mcVersion}`;
    const versionDir = getVersionDir(this.gameDir, profileName);
    ensureDirSync(versionDir);

    // Fetch installer JSON from Quilt API
    const res = await quiltFetch(`${QUILT_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`);

    const profileJson = await res.json() as Record<string, unknown>;

    // Normalize to VersionJson
    const versionJson = this.normalizeProfile(profileJson, mcVersion, loaderVersion);

    // Write version.json
    const versionJsonPath = path.join(versionDir, `${profileName}.json`);
    fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2));

    // Download Quilt-specific libraries
    const libs = versionJson.libraries ?? [];
    const items = libs.map((lib) => {
      const artifact = lib.downloads?.artifact;
      if (!artifact?.url) return null;

      const libPath = artifact.path ?? this.libraryNameToPath(lib.name);
      const dest = path.join(getLibraryDir(this.gameDir), libPath);

      return {
        url: artifact.url,
        dest,
        sha1: artifact.sha1,
        size: artifact.size,
        onProgress,
      };
    }).filter(Boolean) as DownloadOptions[];

    if (items.length > 0) {
      await this.downloader.downloadMultiple(items, 5);
    }

    return {
      versionJson,
      versionJsonPath,
      profileName,
    };
  }

  private normalizeProfile(
    profile: Record<string, unknown>,
    mcVersion: string,
    loaderVersion: string,
  ): VersionJson {
    return {
      id: (profile.id as string) ?? `quilt-loader-${loaderVersion}-${mcVersion}`,
      time: (profile.time as string) ?? new Date().toISOString(),
      releaseTime: (profile.releaseTime as string) ?? new Date().toISOString(),
      type: "release",
      mainClass: (profile.mainClass as string) ?? "org.quiltmc.loader.impl.game.minecraft.client.QuiltClientLauncher",
      arguments: profile.arguments as VersionJson["arguments"],
      minecraftArguments: profile.minecraftArguments as string | undefined,
      libraries: (profile.libraries as VersionJson["libraries"]) ?? [],
      // Do NOT set downloads/assetIndex here — they must be inherited
      // from the parent vanilla version via resolveInheritance().
      // Setting them with empty values would override the parent's
      // correct assetIndex (e.g. id="27" with a real URL) with a
      // broken one (id="1.21.10", url=""), causing asset download failures.
      inheritsFrom: mcVersion,
    };
  }

  private libraryNameToPath(name: string): string {
    const parts = name.split(":");
    const groupId = (parts[0] ?? "").replace(/\./g, "/");
    const artifactId = parts[1] ?? "";
    const version = parts[2] ?? "";
    const classifier = parts[3] ?? "";
    const ext = parts[4] ?? "jar";

    let fileName = `${artifactId}-${version}`;
    if (classifier) fileName += `-${classifier}`;
    fileName += `.${ext}`;

    return `${groupId}/${artifactId}/${version}/${fileName}`;
  }
}
