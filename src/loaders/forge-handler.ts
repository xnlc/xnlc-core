// ============================================================
// XNLC — Forge Handler (Modern, 1.13+)
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { VersionJson, ForgeInstallerProfile, ForgeProfileLibrary, LoaderInstallResult, DownloadProgressCallback, InstallationPhase } from "../types/index.js";
import { Downloader, DownloadOptions } from "../core/downloader.js";
import { MetaClient } from "../core/meta-client.js";
import { mavenCoordinateToPath, getVersionDir, getLibraryDir, ensureDirSync, parseMavenCoordinate, sha1HashSync, libraryNameToPath } from "../utils/index.js";
import { URLS } from "../constants/urls.js";

const FORGE_MAVEN = URLS.official.forge.maven;
const FORGE_FILES = URLS.official.forge.files;
const MOJANG_LIBRARIES = URLS.official.mojang.libraries;

const FORGE_RESOURCE_DATA_KEYS = [
  "MC_SLIM",
  "MC_EXTRA",
  "MC_SRG",
  "PATCHED",
] as const;
type ForgeResourceDataKey = typeof FORGE_RESOURCE_DATA_KEYS[number];

type ForgeVersionIndex = {
  metadata: Record<string, string[]>;
  promos: Record<string, string>;
};

export class ForgeHandler {
  constructor(
    private downloader: Downloader,
    private metaClient: MetaClient,
    private gameDir: string,
  ) {}

  private normalizeForgeVersion(version: string): { mcVersion: string; loaderVersion: string } | null {
    const [mcVersion, ...rest] = version.split("-");
    if (!mcVersion || rest.length === 0) {
      return null;
    }

    let loaderVersion = rest.join("-");
    if (version.endsWith(`-${mcVersion}`)) {
      loaderVersion = rest.slice(0, -1).join("-");
    }

    return loaderVersion ? { mcVersion, loaderVersion } : null;
  }

  private findJava11(): string | null {
    const runtimesDir = path.join(this.gameDir, "runtimes");
    if (!fs.existsSync(runtimesDir)) return null;

    const entries = fs.readdirSync(runtimesDir);
    for (const entry of entries) {
      const version = parseInt(entry.replace("java-", ""));
      if (!isNaN(version) && version >= 11) {
        const javaPath = path.join(runtimesDir, entry, "bin", "java");
        if (fs.existsSync(javaPath)) {
          return javaPath;
        }
      }
    }
    return null;
  }

  private async fetchVersionIndex(): Promise<ForgeVersionIndex> {
    const [metadata, promos] = await Promise.all([
      this.fetchMetadata(),
      this.fetchPromotions(),
    ]);

    return { metadata, promos };
  }

  private async fetchMetadata(): Promise<Record<string, string[]>> {
    const metadata: Record<string, string[]> = {};

    try {
      const res = await fetch(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`);
      if (!res.ok) {
        return metadata;
      }

      const xml = await res.text();
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]!.trim());

      for (const version of versions) {
        const normalized = this.normalizeForgeVersion(version);
        if (!normalized) continue;

        const { mcVersion, loaderVersion } = normalized;
        metadata[mcVersion] ??= [];
        if (!metadata[mcVersion]!.includes(loaderVersion)) {
          metadata[mcVersion]!.push(loaderVersion);
        }
      }
    } catch {
      return metadata;
    }

    return metadata;
  }

  private async fetchPromotions(): Promise<Record<string, string>> {
    try {
      const res = await fetch(`${FORGE_FILES}/net/minecraftforge/forge/promotions_slim.json`);
      if (!res.ok) return {};

      const data = await res.json() as { promos?: Record<string, string> };
      return data.promos ?? {};
    } catch {
      return {};
    }
  }

  async getSupportedMinecraftVersions(): Promise<string[]> {
    const { metadata, promos } = await this.fetchVersionIndex();
    const versions = new Set<string>();

    for (const [mcVersion, forgeVersions] of Object.entries(metadata)) {
      if (Array.isArray(forgeVersions) && forgeVersions.length > 0) {
        versions.add(mcVersion);
      }
    }

    for (const key of Object.keys(promos)) {
      const match = key.match(/^(.+?)-(latest|recommended)$/);
      if (match?.[1]) {
        versions.add(match[1]);
      }
    }

    return [...versions];
  }

  async getVersions(mcVersion: string): Promise<string[]> {
    const { metadata, promos } = await this.fetchVersionIndex();
    const versions = new Set(metadata[mcVersion] ?? []);
    const recommended = promos[`${mcVersion}-recommended`];
    const latest = promos[`${mcVersion}-latest`];

    if (recommended) versions.add(recommended);
    if (latest) versions.add(latest);

    return [...versions];
  }

  async getRecommendedVersion(mcVersion: string): Promise<string | undefined> {
    const promos = await this.fetchPromotions();
    return promos[`${mcVersion}-recommended`];
  }

  async getLatestVersion(mcVersion: string): Promise<string | undefined> {
    const promos = await this.fetchPromotions();
    return promos[`${mcVersion}-latest`];
  }

  private withPhase(phase: InstallationPhase, onProgress?: DownloadProgressCallback): DownloadProgressCallback | undefined {
    if (!onProgress) return undefined;
    return (progress) => onProgress({ ...progress, installationPhase: phase });
  }

  private getPreferredRepositoryBase(libName: string): string {
    const groupId = libName.split(":")[0] ?? "";

    if (groupId === "net.minecraftforge") {
      return URLS.official.forge.maven;
    }
    if (groupId === "net.neoforged" || groupId.startsWith("net.neoforged.")) {
      return URLS.official.neoforge.maven;
    }
    if (groupId === "net.fabricmc" || groupId.startsWith("net.fabricmc.")) {
      return URLS.official.fabric.maven;
    }
    if (groupId === "org.quiltmc" || groupId.startsWith("org.quiltmc.")) {
      return URLS.official.quilt.mavenRelease;
    }
    if (groupId === "net.minecraft" || groupId === "com.mojang" || groupId === "lzma") {
      return URLS.official.mojang.libraries;
    }

    return URLS.official.mavenCentralApache;
  }

  private normalizeExternalLibraryUrl(url: string | undefined, libName: string): string | undefined {
    if (!url) return url;

    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/+/, "");
      const search = parsed.search;
      const preferredBase = this.getPreferredRepositoryBase(libName);

      if (parsed.hostname === "maven.creeperhost.net" || parsed.hostname === "repo1.maven.org" || parsed.hostname === "repo.maven.apache.org") {
        return `${preferredBase}/${path}${search}`;
      }

      if (parsed.hostname === "files.minecraftforge.net") {
        const forgePath = path.startsWith("maven/") ? path.slice("maven/".length) : path;
        return `${URLS.official.forge.maven}/${forgePath}${search}`;
      }

      if (parsed.hostname === "maven.minecraftforge.net") {
        return `${URLS.official.forge.maven}/${path}${search}`;
      }
    } catch {
      return url;
    }

    return url;
  }

  private normalizeLibraryBaseUrl(baseUrl: string | undefined, libName: string): string | undefined {
    if (!baseUrl) return baseUrl;
    if (/\.(jar|zip)(\?.*)?$/i.test(baseUrl) || /\/download(\?.*)?$/i.test(baseUrl)) {
      return this.normalizeExternalLibraryUrl(baseUrl, libName);
    }
    return `${this.getPreferredRepositoryBase(libName)}/`;
  }

  private normalizeProfileLibrary(lib: ForgeProfileLibrary): ForgeProfileLibrary {
    return {
      ...lib,
      url: this.normalizeLibraryBaseUrl(lib.url, lib.name),
      downloads: lib.downloads?.artifact
        ? {
            ...lib.downloads,
            artifact: {
              ...lib.downloads.artifact,
              url: this.normalizeExternalLibraryUrl(lib.downloads.artifact.url, lib.name) ?? lib.downloads.artifact.url,
            },
          }
        : lib.downloads,
    };
  }

  private normalizeInstallerProfile(profile: ForgeInstallerProfile): ForgeInstallerProfile {
    return {
      ...profile,
      libraries: (profile.libraries ?? []).map((lib) => this.normalizeProfileLibrary(lib)),
    };
  }

  private normalizeVersionLibrary<T extends VersionJson["libraries"][number]>(lib: T): T {
    return {
      ...lib,
      url: this.normalizeLibraryBaseUrl(lib.url, lib.name),
      downloads: lib.downloads?.artifact
        ? {
            ...lib.downloads,
            artifact: {
              ...lib.downloads.artifact,
              url: this.normalizeExternalLibraryUrl(lib.downloads.artifact.url, lib.name) ?? lib.downloads.artifact.url,
            },
          }
        : lib.downloads,
    };
  }

  private async isValidForgeInstallerArchive(installerPath: string): Promise<boolean> {
    try {
      const AdmZip = (await import("adm-zip/adm-zip.js")).default;
      const zip = new AdmZip(installerPath);
      return !!zip.getEntry("install_profile.json") || !!zip.getEntry("version.json");
    } catch {
      return false;
    }
  }

  private async ensureInstallerArchive(
    installerUrl: string,
    installerDest: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    await this.downloader.download({
      url: installerUrl,
      dest: installerDest,
      onProgress: this.withPhase("downloading-installer", onProgress),
    });

    if (await this.isValidForgeInstallerArchive(installerDest)) {
      return;
    }

    try {
      fs.rmSync(installerDest, { force: true });
    } catch {
      // ignore cleanup failures
    }

    await this.downloader.download({
      url: installerUrl,
      dest: installerDest,
      onProgress: this.withPhase("downloading-installer", onProgress),
    });

    if (!await this.isValidForgeInstallerArchive(installerDest)) {
      throw new Error(`Downloaded Forge installer is corrupted: ${installerDest}`)
    }
  }

  async install(
    mcVersion: string,
    forgeVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<LoaderInstallResult> {
    let fullVersion = forgeVersion;
    if (!forgeVersion.includes(mcVersion)) {
      fullVersion = `${mcVersion}-${forgeVersion}`;
    }
    const profileName = `forge-${fullVersion}`;
    const versionDir = getVersionDir(this.gameDir, profileName);
    ensureDirSync(versionDir);

    onProgress?.({
      type: "forge",
      installationPhase: "downloading-vanilla",
      percent: 0,
    });

    const baseJson = await this.metaClient.fetchVersionJson(mcVersion);

    onProgress?.({
      type: "forge",
      installationPhase: "downloading-vanilla",
      percent: 0,
    });

    const mcVersionJson = await this.metaClient.fetchVersionJson(mcVersion);
    const mcClientUrl = mcVersionJson.downloads?.client?.url;
    if (mcClientUrl) {
      const globalLibDir = getLibraryDir(this.gameDir);
      const mcClientJarDir = path.join(globalLibDir, "com", "mojang", "minecraft", mcVersion);
      ensureDirSync(mcClientJarDir);
      const mcClientJar = path.join(mcClientJarDir, `minecraft-${mcVersion}-client.jar`);
      if (!fs.existsSync(mcClientJar)) {
        await this.downloader.download({ url: mcClientUrl, dest: mcClientJar });
      }
    }

    onProgress?.({
      type: "forge",
      installationPhase: "downloading-installer",
      percent: 0,
    });

    const installerUrl = `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;
    const installerDest = path.join(versionDir, `forge-${fullVersion}-installer.jar`);

    await this.ensureInstallerArchive(installerUrl, installerDest, onProgress);

    const AdmZip = (await import("adm-zip/adm-zip.js")).default;
    const zip = new AdmZip(installerDest);

    const profileJson = zip.getEntry("install_profile.json");
    if (!profileJson) {
      throw new Error("install_profile.json not found in Forge installer");
    }
    const profile = this.normalizeInstallerProfile(
      JSON.parse(profileJson.getData().toString("utf-8")) as ForgeInstallerProfile,
    );

    const versionEntry = zip.getEntry("version.json");
    let versionJson: VersionJson;
    if (versionEntry) {
      versionJson = this.normalizeInstallerVersionJson(
        JSON.parse(versionEntry.getData().toString("utf-8")) as VersionJson,
        profile,
        mcVersion,
        fullVersion,
        baseJson,
      );
    } else {
      versionJson = await this.buildVersionJsonFromProfile(profile, mcVersion, forgeVersion);
    }

    const versionJsonPath = path.join(versionDir, `${profileName}.json`);
    fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2));

    await this.downloadProfileLibraries(profile, this.withPhase("downloading-libraries", onProgress));
    await this.ensureForgeArtifacts(zip, versionJson, fullVersion, this.withPhase("downloading-libraries", onProgress));

    await this.createPatchedClientJar(installerDest, zip, profile, fullVersion, mcVersion, this.withPhase("downloading-client", onProgress));

    const properJarName = `forge-${fullVersion}.jar`;
    const properJarDest = path.join(versionDir, properJarName);
    if (!fs.existsSync(properJarDest)) {
      fs.renameSync(installerDest, properJarDest);
    }

    return {
      versionJson,
      versionJsonPath,
      profileName,
    };
  }

  private async downloadProfileLibraries(profile: ForgeInstallerProfile, onProgress?: DownloadProgressCallback): Promise<void> {
    const libs = profile.libraries ?? [];
    const items = libs.map((lib: ForgeProfileLibrary) => {
      const dl = lib.downloads?.artifact;
      if (!dl) return null;
      if (!dl.url || (!dl.url.startsWith("http://") && !dl.url.startsWith("https://"))) {
        return null;
      }
      const dest = path.join(getLibraryDir(this.gameDir), dl.path ?? libraryNameToPath(lib.name));
      return { url: dl.url, dest, sha1: dl.sha1, size: dl.size, onProgress };
    }).filter(Boolean) as DownloadOptions[];

    if (items.length > 0) {
      await this.downloader.downloadMultiple(items, 5);
    }
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

  private buildLocalLibrary(descriptor: string, sha1?: string): VersionJson["libraries"][number] {
    const coord = parseMavenCoordinate(descriptor);
    return {
      name: `${coord.groupId}:${coord.artifactId}:${coord.version}${coord.classifier ? `:${coord.classifier}` : ""}`,
      downloads: {
        artifact: {
          path: mavenCoordinateToPath(coord.groupId, coord.artifactId, coord.version, coord.classifier, coord.extension),
          url: "",
          sha1: sha1 ?? "",
          size: 0,
        },
      },
      downloadOnly: true,
    };
  }

  private buildSupplementalLibraries(profile: ForgeInstallerProfile, fullVersion: string): VersionJson["libraries"] {
    const libraries: VersionJson["libraries"] = [
      {
        name: `net.minecraftforge:forge:${fullVersion}:universal`,
        downloads: {
          artifact: {
            url: `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-universal.jar`,
            path: mavenCoordinateToPath("net.minecraftforge", "forge", fullVersion, "universal"),
            sha1: "",
            size: 0,
          },
        },
        downloadOnly: true,
      },
      {
        name: "net.minecraft:launchwrapper:1.12",
        downloads: {
          artifact: {
            url: `${MOJANG_LIBRARIES}/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar`,
            path: "net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar",
            sha1: "",
            size: 0,
          },
        },
      },
    ];

    for (const key of FORGE_RESOURCE_DATA_KEYS) {
      const descriptor = this.getProfileDataValue(profile, key);
      if (!descriptor?.startsWith("[") || !descriptor.endsWith("]")) continue;
      const sha = this.getProfileDataValue(profile, `${key}_SHA`);
      libraries.push(this.buildLocalLibrary(descriptor.slice(1, -1), sha));
    }

    return libraries;
  }

  private normalizeInstallerVersionJson(
    versionJson: VersionJson,
    profile: ForgeInstallerProfile,
    mcVersion: string,
    fullVersion: string,
    baseJson: VersionJson,
  ): VersionJson {
      const libraries = (versionJson.libraries ?? []).map((lib) => this.normalizeVersionLibrary(lib));
    const seen = new Set(libraries.map((lib) => `${lib.name}|${lib.natives ? "natives" : "plain"}|${lib.downloads?.classifiers ? "classifiers" : ""}`));

    for (const lib of this.buildSupplementalLibraries(profile, fullVersion)) {
      const key = `${lib.name}|${lib.natives ? "natives" : "plain"}|${lib.downloads?.classifiers ? "classifiers" : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      libraries.push(lib);
    }

    return this.mergeBaseMetadata({
      ...versionJson,
      id: `forge-${fullVersion}`,
      type: versionJson.type ?? "release",
      inheritsFrom: versionJson.inheritsFrom ?? mcVersion,
      libraries,
    }, baseJson);
  }

  private async extractBundledArtifact(zip: import("adm-zip"), artifactPath: string, dest: string): Promise<boolean> {
    const entry = zip.getEntry(`maven/${artifactPath}`);
    if (!entry) {
      return false;
    }
    ensureDirSync(path.dirname(dest));
    fs.writeFileSync(dest, entry.getData());
    return true;
  }

  private async ensureForgeArtifacts(
    zip: import("adm-zip"),
    versionJson: VersionJson,
    fullVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const globalLibDir = getLibraryDir(this.gameDir);
    const forgeLibs = (versionJson.libraries ?? []).filter((lib) => lib.name.startsWith(`net.minecraftforge:forge:${fullVersion}`));

    for (const lib of forgeLibs) {
      const artifact = lib.downloads?.artifact;
      if (!artifact?.path) continue;

      const dest = path.join(globalLibDir, artifact.path);
      if (fs.existsSync(dest)) continue;

      const extracted = await this.extractBundledArtifact(zip, artifact.path, dest);
      if (extracted) continue;

      if (artifact.url) {
        await this.downloader.download({
          url: artifact.url,
          dest,
          sha1: artifact.sha1,
          size: artifact.size,
          onProgress,
        });
      }
    }
  }

  /**
   * Create the patched client JAR.
   * Strategy:
   * 1. Validate the generated client jar against the installer-declared SHA.
   * 2. Run the official Forge client processor chain when available.
   * 3. Fall back to legacy binary patching for older installer layouts.
   */
  private async createPatchedClientJar(
    installerPath: string,
    zip: import("adm-zip"),
    profile: ForgeInstallerProfile,
    fullVersion: string,
    mcVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const clientJarDest = this.getPatchedClientJarPath(profile, fullVersion);
    const expectedSha = this.getProfileDataValue(profile, "PATCHED_SHA");

    if (this.isGeneratedClientJarValid(clientJarDest, expectedSha)) {
      console.log(`Forge client jar already exists and is valid: ${clientJarDest}`);
      return;
    }

    if (fs.existsSync(clientJarDest)) {
      console.log(`Forge client jar exists but failed validation; regenerating: ${clientJarDest}`);
      fs.unlinkSync(clientJarDest);
    }

    if ((profile.processors?.length ?? 0) > 0) {
      console.log("Running Forge installer client processors...");
      await this.runForgeInstallerClientProcessors(installerPath, clientJarDest, expectedSha);
      return;
    }

    // Fall back to binary patching
    console.log("No pre-built client jar found. Running binary patching...");
    await this.runBinaryPatching(zip, profile, fullVersion, mcVersion, onProgress);
    this.assertGeneratedClientJarValid(clientJarDest, expectedSha);
  }

  private getPatchedClientJarPath(profile: ForgeInstallerProfile, fullVersion: string): string {
    const patched = this.getProfileDataValue(profile, "PATCHED");
    const globalLibDir = getLibraryDir(this.gameDir);

    if (patched?.startsWith("[") && patched.endsWith("]")) {
      return path.join(globalLibDir, this.mavenDescriptorToPath(patched.slice(1, -1)));
    }

    return path.join(globalLibDir, mavenCoordinateToPath("net.minecraftforge", "forge", fullVersion, "client"));
  }

  private getProfileDataValue(profile: ForgeInstallerProfile, key: string): string | undefined {
    const data = (profile as unknown as { data?: Record<string, string | Record<string, string>> }).data;
    const entry = data?.[key];
    const value = typeof entry === "string" ? entry : entry?.client;

    if (!value) {
      return undefined;
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }
    return value;
  }

  private mavenDescriptorToPath(descriptor: string): string {
    const parts = descriptor.split(":");
    const lastIndex = parts.length - 1;
    const lastPart = parts[lastIndex] ?? "";
    const extIndex = lastPart.indexOf("@");
    let extension = "jar";

    if (extIndex >= 0) {
      extension = lastPart.slice(extIndex + 1);
      parts[lastIndex] = lastPart.slice(0, extIndex);
    }

    return mavenCoordinateToPath(
      parts[0] ?? "",
      parts[1] ?? "",
      parts[2] ?? "",
      parts[3],
      extension,
    );
  }

  private isGeneratedClientJarValid(clientJarPath: string, expectedSha?: string): boolean {
    if (!fs.existsSync(clientJarPath)) {
      return false;
    }
    if (expectedSha && sha1HashSync(clientJarPath) !== expectedSha) {
      return false;
    }
    return true;
  }

  private assertGeneratedClientJarValid(clientJarPath: string, expectedSha?: string): void {
    if (!fs.existsSync(clientJarPath)) {
      throw new Error("Forge client processor completed but client JAR was not created");
    }
    if (expectedSha) {
      const actualSha = sha1HashSync(clientJarPath);
      if (actualSha !== expectedSha) {
        throw new Error(`Forge client JAR checksum mismatch. Expected ${expectedSha}, got ${actualSha}`);
      }
    }
  }

  private async runForgeInstallerClientProcessors(
    installerPath: string,
    clientJarPath: string,
    expectedSha?: string,
  ): Promise<void> {
    const javaPath = this.findJava11() ?? "java";
    console.log(`Using Java for Forge installer: ${javaPath}`);

    execFileSync(javaPath, [
      "-jar",
      installerPath,
      "--installClient",
      this.gameDir,
    ], {
      stdio: "inherit",
      timeout: 600000,
    });

    this.assertGeneratedClientJarValid(clientJarPath, expectedSha);
    console.log(`Forge client JAR generated: ${clientJarPath}`);
  }

  /**
   * Run binary patching to create the patched client JAR.
   * This extracts client.lzma from the installer, downloads the vanilla MC jar,
   * and runs binarypatcher to apply the patch.
   */
  private async runBinaryPatching(
    zip: import("adm-zip"),
    profile: ForgeInstallerProfile,
    fullVersion: string,
    mcVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const globalLibDir = getLibraryDir(this.gameDir);
    const tempDir = path.join(getVersionDir(this.gameDir, `forge-${fullVersion}`), "patch-temp");
    ensureDirSync(tempDir);

    try {
      // 1. Extract client.lzma from installer JAR
      const binpatchEntry = zip.getEntry("data/client.lzma");
      if (!binpatchEntry) {
        throw new Error("client.lzma not found in installer JAR");
      }
      const binpatchPath = path.join(tempDir, "client.lzma");
      fs.writeFileSync(binpatchPath, binpatchEntry.getData());

      // 2. Download vanilla Minecraft client JAR
      const mcVersionJson = await this.metaClient.fetchVersionJson(mcVersion);
      const mcClientUrl = mcVersionJson.downloads?.client?.url;
      if (!mcClientUrl) {
        throw new Error(`No client download URL found for Minecraft ${mcVersion}`);
      }
      const mcClientJar = path.join(tempDir, "minecraft_client.jar");
      console.log("Downloading vanilla Minecraft client JAR...");
      await this.downloader.download({ url: mcClientUrl, dest: mcClientJar, onProgress });

      // 3. Download binarypatcher and its dependencies
      const clientJarDest = path.join(globalLibDir, mavenCoordinateToPath("net.minecraftforge", "forge", fullVersion, "client"));
      await this.downloadBinaryPatcherDeps(profile, onProgress);

      // 4. Find binarypatcher jar
      const bpLib = profile.libraries?.find(l => l.name.startsWith("net.minecraftforge:binarypatcher:"));
      if (!bpLib?.downloads?.artifact) {
        throw new Error("binarypatcher not found in profile libraries");
      }
      const bpPath = path.join(globalLibDir, bpLib.downloads.artifact.path ?? libraryNameToPath(bpLib.name));

      // 5. Build classpath for binarypatcher
      const bpProcessor = profile.processors?.find(p =>
        p.jar.startsWith("net.minecraftforge:binarypatcher:") &&
        (p.sides?.includes("client") ?? true)
      );
      if (!bpProcessor) {
        throw new Error("binarypatcher processor not found in profile");
      }

      const classpathEntries = [bpPath];
      for (const cp of bpProcessor.classpath ?? []) {
        const coord = parseMavenCoordinate(cp);
        const cpPath = path.join(globalLibDir, mavenCoordinateToPath(coord.groupId, coord.artifactId, coord.version, coord.classifier, coord.extension));
        if (fs.existsSync(cpPath)) {
          classpathEntries.push(cpPath);
        }
      }
      const classpath = classpathEntries.join(path.delimiter);

      // 6. Run binarypatcher
      console.log("Running binary patcher...");
      const args = [
        "--clean", mcClientJar,
        "--output", clientJarDest,
        "--apply", binpatchPath,
        "--data",
        "--unpatched",
      ];

      const javaPath = this.findJava11() ?? "java";
      console.log(`Using Java: ${javaPath}`);
      execFileSync(javaPath, [
        "-cp",
        classpath,
        "net.minecraftforge.binarypatcher.ConsoleTool",
        ...args,
      ], {
        stdio: "inherit",
        timeout: 300000,
      });

      if (!fs.existsSync(clientJarDest)) {
        throw new Error("Binary patcher completed but client JAR was not created");
      }

      console.log(`Patched client JAR created: ${clientJarDest}`);
    } finally {
      // Cleanup temp directory
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Download binarypatcher dependencies (srgutils, jopt-simple, lzma-java, javaxdelta, trove).
   */
  private async downloadBinaryPatcherDeps(
    profile: ForgeInstallerProfile,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const bpProcessor = profile.processors?.find(p =>
      p.jar.startsWith("net.minecraftforge:binarypatcher:") &&
      (p.sides?.includes("client") ?? true)
    );
    if (!bpProcessor?.classpath) return;

    const globalLibDir = getLibraryDir(this.gameDir);
    const items: DownloadOptions[] = [];

    for (const cp of bpProcessor.classpath) {
      const coord = parseMavenCoordinate(cp);
      const mavenPath = mavenCoordinateToPath(coord.groupId, coord.artifactId, coord.version, coord.classifier, coord.extension);
      const dest = path.join(globalLibDir, mavenPath);

      if (fs.existsSync(dest)) continue;

      // Determine URL
      let url: string | null = null;
      if (coord.groupId === "net.minecraftforge") {
        url = `${FORGE_MAVEN}/${mavenPath}`;
      } else if (coord.groupId === "net.minecraft" || coord.groupId === "com.mojang") {
        url = `https://libraries.minecraft.net/${mavenPath}`;
      } else {
        url = `https://repo1.maven.org/maven2/${mavenPath}`;
      }

      if (url) {
        items.push({ url, dest, onProgress });
      }
    }

    if (items.length > 0) {
      await this.downloader.downloadMultiple(items, 3);
    }
  }

  private async buildVersionJsonFromProfile(
    profile: ForgeInstallerProfile,
    mcVersion: string,
    forgeVersion: string,
  ): Promise<VersionJson> {
    const fullVersion = forgeVersion;
    const baseJson = await this.metaClient.fetchVersionJson(mcVersion);
    const profileVersion = profile.version;

    return {
      ...baseJson,
      id: profileVersion ?? `forge-${fullVersion}`,
      inheritsFrom: mcVersion,
      jar: mcVersion,
      mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
      arguments: {
        jvm: [
          "-Djava.net.preferIPv6Addresses=system",
          "-DignoreList=bootstraplauncher,securejarhandler,asm-commons,asm-util,asm-analysis,asm-tree,asm,JarJarFileSystems,client-extra,fmlcore,javafmllanguage,lowcodelanguage,mclanguage,forge-,${version_name}.jar",
          "-DmergeModules=jna-5.10.0.jar,jna-platform-5.10.0.jar",
          "-DlibraryDirectory=${library_directory}",
        ],
        game: [
          "--launchTarget",
          "forgeclient",
          "--fml.forgeVersion",
          forgeVersion,
          "--fml.mcVersion",
          mcVersion,
          "--fml.forgeGroup",
          "net.minecraftforge",
        ],
      },
      libraries: [
        {
          name: "net.minecraftforge:forge:" + fullVersion + ":client",
          downloads: {
            artifact: {
              url: `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-client.jar`,
              path: mavenCoordinateToPath("net.minecraftforge", "forge", fullVersion, "client"),
              sha1: "",
              size: 0,
            },
          },
        },
        ...(baseJson.libraries ?? []),
      ],
    };
  }
}
