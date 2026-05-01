// ============================================================
// XNLC — NeoForge Handler
// Supports modern NeoForge installers and version metadata
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
import type {
  VersionJson,
  ForgeInstallerProfile,
  ForgeProfileLibrary,
  LoaderInstallResult,
  DownloadProgressCallback,
  VersionJsonLibrary,
  InstallationPhase,
} from "../types/index.js";
import { Downloader } from "../core/downloader.js";
import { MetaClient } from "../core/meta-client.js";
import { getVersionDir, getLibraryDir, ensureDirSync } from "../utils/index.js";
import { URLS } from "../constants/urls.js";

const NEOFORGE_MAVEN = URLS.official.neoforge.maven;
const MAIN_CLASS = "net.neoforged.fml.startup.Client";
const NEOFORGE_MAJOR = 21;

type ZipLike = {
  getEntry(name: string): { getData(): Buffer } | null;
};

export class NeoForgeHandler {
  constructor(
    private downloader: Downloader,
    private metaClient: MetaClient,
    private gameDir: string,
  ) {}

  private getProfileName(mcVersion: string): string {
    return `NeoForge ${mcVersion}`;
  }

  private getFamily(mcVersion: string): string {
    const parts = mcVersion.split(".");
    return parts.length >= 2 ? `NeoForge-${parts[0]}.${parts[1]}` : `NeoForge-${mcVersion}`;
  }

  private getInstallerUrl(loaderVersion: string): string {
    return `${NEOFORGE_MAVEN}/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  }

  private normalizeLoaderVersion(mcVersion: string, loaderVersion: string): string {
    const trimmed = loaderVersion.trim();
    if (!trimmed) return trimmed;

    // NeoForge versions are typically build numbers like 21.11.42 for MC 1.21.11.
    // Keep explicit version strings as-is.
    if (trimmed.includes(mcVersion)) return trimmed;
    return trimmed;
  }

  private async fetchMetadataXml(): Promise<string> {
    const url = `${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch NeoForge metadata: ${res.status}`);
        }
        return await res.text();
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to fetch NeoForge metadata");
  }

  private parseVersionsFromMetadata(xml: string): string[] {
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]!);
  }

  private mcPrefix(mcVersion: string): string {
    const version = mcVersion.startsWith("1.") ? mcVersion.slice(2) : mcVersion;
    return version.replace(/\.+$/, "");
  }

  private matchesMinecraftVersion(loaderVersion: string, mcVersion: string): boolean {
    const prefix = this.mcPrefix(mcVersion);
    return loaderVersion === prefix || loaderVersion.startsWith(`${prefix}.`) || loaderVersion.startsWith(`${prefix}-`);
  }


  private isStableVersion(version: string): boolean {
    return !version.includes("beta") && !version.includes("alpha") && !version.includes("rc");
  }

  /**
   * Fetch the NeoForge Maven metadata once and return all unique
   * Minecraft versions that have at least one NeoForge build available.
   *
   * Handles both old format (1.20.4 → NF prefix 20.4) and new format
   * (26.1.2 → NF prefix 26.1.2) by cross-referencing with the Mojang
   * version manifest.
   *
   * Single HTTP request for Maven + single request for Mojang manifest
   * instead of per-mc-version polling.
   */
  async getSupportedMinecraftVersions(): Promise<string[]> {
    const [xml, mojangVersions] = await Promise.all([
      this.fetchMetadataXml(),
      this.metaClient.getAllVersions().then((entries) => new Set(entries.map((e) => e.id))),
    ]);
    const allVersions = this.parseVersionsFromMetadata(xml);
    const seen = new Set<string>();
    const mcVersions: string[] = [];

    for (const v of allVersions) {
      // Strip -beta / -alpha suffix for prefix extraction
      const clean = v.replace(/-.*$/, "");
      const parts = clean.split(".");
      if (parts.length < 2) continue;

      // Try old format first: NF "20.4.x" → MC "1.20.4"
      const oldFormat = `1.${parts[0]}.${parts[1]}`;
      if (mojangVersions.has(oldFormat) && !seen.has(oldFormat)) {
        seen.add(oldFormat);
        mcVersions.push(oldFormat);
        continue;
      }

      // Try new format: NF "26.1.2.x" → MC "26.1.2"
      if (parts.length >= 3) {
        const newFormat = `${parts[0]}.${parts[1]}.${parts[2]}`;
        if (mojangVersions.has(newFormat) && !seen.has(newFormat)) {
          seen.add(newFormat);
          mcVersions.push(newFormat);
        }
      }
    }

    return mcVersions;
  }

  async getVersions(mcVersion: string): Promise<string[]> {
    const xml = await this.fetchMetadataXml();
    return this.parseVersionsFromMetadata(xml).filter((version) => this.matchesMinecraftVersion(version, mcVersion));
  }

  async getRecommendedVersion(mcVersion: string): Promise<string | undefined> {
    const versions = await this.getVersions(mcVersion);
    if (versions.length === 0) return undefined;

    const stable = versions.filter((v) => this.isStableVersion(v));
    return (stable.at(-1) ?? versions.at(-1));
  }

  async getLatestVersion(mcVersion: string): Promise<string | undefined> {
    const versions = await this.getVersions(mcVersion);
    return versions.at(-1);
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
    const fullVersion = this.normalizeLoaderVersion(mcVersion, loaderVersion);
    const profileName = this.getProfileName(mcVersion);
    const versionDir = getVersionDir(this.gameDir, profileName);
    ensureDirSync(versionDir);

    onProgress?.({
      type: "neoforge",
      installationPhase: "downloading-vanilla",
      percent: 0,
    });

    const baseJson = await this.metaClient.fetchVersionJson(mcVersion);

    onProgress?.({
      type: "neoforge",
      installationPhase: "downloading-installer",
      percent: 0,
    });

    const installerUrl = this.getInstallerUrl(fullVersion);
    const installerDest = path.join(versionDir, `neoforge-${fullVersion}-installer.jar`);

    await this.downloader.download({
      url: installerUrl,
      dest: installerDest,
      onProgress: this.withPhase("downloading-installer", onProgress),
    });

    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(installerDest);

    const profile = this.readInstallerJson<ForgeInstallerProfile>(zip, "install_profile.json");
    if (profile.minecraft && profile.minecraft !== mcVersion) {
      throw new Error(`NeoForge installer Minecraft version mismatch: expected ${mcVersion}, got ${profile.minecraft}`);
    }
    const installerVersionJson = this.readInstallerJson<VersionJson>(zip, "version.json");

    await this.downloadProfileLibraries(profile, this.withPhase("downloading-libraries", onProgress));
    await this.downloadLibraries(installerVersionJson, this.withPhase("downloading-libraries", onProgress));

    this.ensureLauncherProfiles();

    onProgress?.({
      type: "neoforge",
      installationPhase: "installing-loader",
      percent: 0,
    });

    execFileSync("java", [
      "-jar",
      installerDest,
      "--install-client",
      this.gameDir,
      "--mirror",
      URLS.official.neoforge.mirror,
    ], {
      stdio: "inherit",
      timeout: 1200000,
    });

    const now = new Date().toISOString();
    const versionJson: VersionJson = this.mergeBaseMetadata(
      {
        ...installerVersionJson,
        id: profileName,
        time: now,
        releaseTime: now,
        inheritsFrom: mcVersion,
        jar: mcVersion,
        family: this.getFamily(mcVersion),
        type: "modified",
        mainClass: installerVersionJson.mainClass || MAIN_CLASS,
        minimumLauncherVersion: installerVersionJson.minimumLauncherVersion ?? NEOFORGE_MAJOR,
        tlauncherVersion: installerVersionJson.tlauncherVersion ?? 11,
      },
      baseJson,
    );

    const versionJsonPath = path.join(versionDir, `${profileName}.json`);
    fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2));

    await this.downloadLibraries(versionJson, this.withPhase("downloading-libraries", onProgress));

    return {
      versionJson,
      versionJsonPath,
      profileName,
    };
  }

  private mergeBaseMetadata(versionJson: VersionJson, baseJson: VersionJson): VersionJson {
    return {
      ...versionJson,
      downloads: versionJson.downloads ?? baseJson.downloads,
      assetIndex: versionJson.assetIndex ?? baseJson.assetIndex,
      assets: versionJson.assets ?? baseJson.assets,
      javaVersion: versionJson.javaVersion ?? baseJson.javaVersion,
      logging: versionJson.logging ?? baseJson.logging,
      minimumLauncherVersion: versionJson.minimumLauncherVersion ?? baseJson.minimumLauncherVersion,
    };
  }

  private getFallbackArtifactUrl(artifactUrl: string): string | undefined {
    if (artifactUrl.startsWith(`${URLS.official.neoforge.maven}/`)) {
      return artifactUrl.replace(`${URLS.official.neoforge.maven}/`, `${URLS.official.mavenCentralApache}/`);
    }
    return undefined;
  }

  private async ensureArtifactAvailable(artifact: NonNullable<VersionJsonLibrary["downloads"]>["artifact"], onProgress?: DownloadProgressCallback): Promise<void> {
    if (!artifact?.path) return;
    const dest = path.join(getLibraryDir(this.gameDir), artifact.path);
    const primary = { url: artifact.url, dest, sha1: artifact.sha1, size: artifact.size, onProgress };

    try {
      await this.downloader.download(primary);
      return;
    } catch (err) {
      const fallbackUrl = this.getFallbackArtifactUrl(artifact.url);
      if (!fallbackUrl) {
        throw err;
      }
      await this.downloader.download({ url: fallbackUrl, dest, sha1: artifact.sha1, size: artifact.size, onProgress });
    }
  }

  private async downloadProfileLibraries(profile: ForgeInstallerProfile, onProgress?: DownloadProgressCallback): Promise<void> {
    for (const lib of profile.libraries ?? []) {
      const artifact = lib.downloads?.artifact;
      if (!artifact?.url || !artifact.path || !artifact.url.startsWith("http")) continue;
      await this.ensureProfileArtifactAvailable(lib, onProgress);
    }
  }

  private async ensureProfileArtifactAvailable(
    library: ForgeProfileLibrary,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const artifact = library.downloads?.artifact;
    if (!artifact?.path || !artifact.url) return;

    await this.ensureArtifactAvailable({
      path: artifact.path,
      sha1: artifact.sha1,
      size: artifact.size,
      url: artifact.url,
    }, onProgress);
  }

  private async downloadLibraries(versionJson: VersionJson, onProgress?: DownloadProgressCallback): Promise<void> {
    for (const lib of versionJson.libraries ?? []) {
      const artifact = lib.downloads?.artifact;
      if (!artifact?.url || !artifact.path || !artifact.url.startsWith("http")) continue;
      await this.ensureArtifactAvailable(artifact, onProgress);
    }
  }

  private readInstallerJson<T>(zip: ZipLike, entryName: string): T {
    const entry = zip.getEntry(entryName);
    if (!entry) {
      throw new Error(`${entryName} not found in NeoForge installer`);
    }
    return JSON.parse(entry.getData().toString("utf-8")) as T;
  }

  private ensureLauncherProfiles(): void {
    const launcherProfilesPath = path.join(this.gameDir, "launcher_profiles.json");
    if (!fs.existsSync(launcherProfilesPath)) {
      fs.writeFileSync(launcherProfilesPath, JSON.stringify({ profiles: {} }, null, 2));
    }
  }

}
