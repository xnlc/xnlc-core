// ============================================================
// XNLC — Fabric Handler (Modern, loader >= 0.14.0)
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { VersionJson, FabricGameVersion, FabricLoaderVersion, FabricProfileJson, LoaderInstallResult, DownloadProgressCallback, InstallationPhase } from "../types/index.js";
import { Downloader, DownloadOptions } from "../core/downloader.js";
import { getVersionDir, getLibraryDir, ensureDirSync } from "../utils/index.js";
import { URLS } from "../constants/urls.js";

const FABRIC_META = URLS.official.fabric.metaV2;

export class FabricHandler {
  constructor(
    private downloader: Downloader,
    private gameDir: string,
  ) {}

  async getGameVersions(): Promise<FabricGameVersion[]> {
    const res = await fetch(`${FABRIC_META}/versions/game`);
    if (!res.ok) throw new Error(`Failed to fetch Fabric game versions: ${res.status}`);
    return res.json() as Promise<FabricGameVersion[]>;
  }

  async getLoaderVersions(): Promise<FabricLoaderVersion[]> {
    const res = await fetch(`${FABRIC_META}/versions/loader`);
    if (!res.ok) throw new Error(`Failed to fetch Fabric loader versions: ${res.status}`);
    return res.json() as Promise<FabricLoaderVersion[]>;
  }

  async getLoaderVersionsForGame(mcVersion: string): Promise<FabricLoaderVersion[]> {
    const res = await fetch(`${FABRIC_META}/versions/loader/${mcVersion}`);
    if (!res.ok) throw new Error(`Failed to fetch Fabric loader versions for ${mcVersion}: ${res.status}`);
    const data = await res.json() as Array<{ loader: FabricLoaderVersion }>;
    return data.map((item) => item.loader);
  }

  async getLatestLoaderVersion(mcVersion: string): Promise<string | undefined> {
    const versions = await this.getLoaderVersionsForGame(mcVersion);
    const stable = versions.filter((v) => v.stable);
    return stable[0]?.version ?? versions[0]?.version;
  }

  private withPhase(phase: InstallationPhase, onProgress?: DownloadProgressCallback): DownloadProgressCallback | undefined {
    if (!onProgress) return undefined;
    return (progress) => onProgress({ ...progress, installationPhase: phase });
  }

  async install(
    mcVersion: string,
    loaderVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<LoaderInstallResult> {
    const profileName = `fabric-loader-${loaderVersion}-${mcVersion}`;
    const versionDir = getVersionDir(this.gameDir, profileName);
    ensureDirSync(versionDir);

    const res = await fetch(`${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`);
    if (!res.ok) {
      throw new Error(`Failed to fetch Fabric profile: ${res.status}`);
    }

    const profileJson: FabricProfileJson = await res.json() as FabricProfileJson;

    const versionJsonPath = path.join(versionDir, `${profileName}.json`);
    fs.writeFileSync(versionJsonPath, JSON.stringify(profileJson, null, 2));

    const items = profileJson.libraries.map((lib: VersionJson["libraries"][number]) => {
      const artifact = lib.downloads?.artifact;
      let url = artifact?.url;
      let sha1 = artifact?.sha1;
      let size = artifact?.size;
      let libPath = artifact?.path;

      if (!url && lib.url) {
        const mavenPath = this.libraryNameToPath(lib.name);
        url = `${lib.url.replace(/\/$/, "")}/${mavenPath}`;
        sha1 = undefined;
        size = (lib as any).size;
        libPath = mavenPath;
      }

      if (!url) return null;

      libPath = libPath ?? this.libraryNameToPath(lib.name);
      const dest = path.join(getLibraryDir(this.gameDir), libPath);

      return {
        url,
        dest,
        sha1,
        size,
        onProgress,
      };
    }).filter(Boolean) as DownloadOptions[];

    if (items.length > 0) {
      await this.downloader.downloadMultiple(
        items.map((item) => ({ ...item, onProgress: this.withPhase("downloading-libraries", item.onProgress) })),
        5,
      );
    }

    return {
      versionJson: profileJson as unknown as VersionJson,
      versionJsonPath,
      profileName,
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
