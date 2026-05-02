import * as path from "path";
import * as fs from "fs";
import type { VersionJson, VersionJsonLibrary, ForgeInstallerProfile, LoaderInstallResult, DownloadProgressCallback } from "../types/index.js";
import { Downloader, DownloadOptions } from "../core/downloader.js";
import { MetaClient } from "../core/meta-client.js";
import { mavenCoordinateToPath, getVersionDir, getLibraryDir, ensureDirSync } from "../utils/index.js";
import { URLS } from "../constants/urls.js";

const FORGE_MAVEN = URLS.official.forge.maven;
const FORGE_FILES = FORGE_MAVEN;
const MAIN_CLASS = "net.minecraft.launchwrapper.Launch";
const JAVA3D_URL = `${FORGE_MAVEN}/java3d/vecmath/1.3.1/vecmath-1.3.1.jar`;
const JAVA3D_PATH = "java3d/vecmath/1.3.1/vecmath-1.3.1.jar";

interface ForgeVersionData { promos: Record<string, string>; }
interface MavenMetadata { [key: string]: string[]; }
interface ParsedLibrary { groupId: string; artifactId: string; version: string; classifier: string; }
interface ArtifactDownload { path: string; url: string; sha1?: string; size?: number; }
type ProfileWithVersionInfo = ForgeInstallerProfile & { versionInfo?: VersionJson & { minecraftArguments?: string } };

const resolveMavenUrl = (groupId: string, mavenPath: string): string => {
  switch (groupId) {
    case "net.minecraft":
    case "com.mojang":
      return `${URLS.official.mojang.libraries}/${mavenPath}`;
    case "lzma":
      return `https://libraries.minecraft.net/${mavenPath}`;
    default:
      return `${FORGE_MAVEN}/${mavenPath}`;
  }
};

const parseLibraryName = (name?: string): ParsedLibrary | null => {
  const [groupId, artifactId, rawVersion, classifier = ""] = name?.split(":") ?? [];
  if (!groupId || !artifactId || !rawVersion) return null;
  return { groupId, artifactId, version: rawVersion === "1.5.2" ? "1.3.1" : rawVersion, classifier };
};

const getProfileVersionInfo = (profile: ForgeInstallerProfile) => (profile as ProfileWithVersionInfo).versionInfo;
const getForgeArtifactUrl = (fullVersion: string, type: string) => `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-${type}.jar`;
const getForgeArtifactPath = (fullVersion: string, type: string) => mavenCoordinateToPath("net.minecraftforge", "forge", fullVersion, type);
const getForgeLauncherArtifactUrl = (fullVersion: string) => `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}.jar`;
const getForgeLauncherArtifactPath = (fullVersion: string) => mavenCoordinateToPath("net.minecraftforge", "forge", fullVersion);
const getJava3dLibrary = (): VersionJsonLibrary => ({
  name: "java3d:vecmath:1.3.1",
  downloads: { artifact: { url: JAVA3D_URL, path: JAVA3D_PATH, sha1: "", size: 0 } },
});
const normalizeForgeBaseUrl = (baseUrl?: string) => {
  if (!baseUrl) return baseUrl;
  return baseUrl
    .replace(/^https:\/\/maven\.minecraftforge\.net\/?$/, `${FORGE_MAVEN}/`)
    .replace(/^https:\/\/files\.minecraftforge\.net\/maven\/?$/, `${FORGE_MAVEN}/`)
    .replace(/^https:\/\/files\.minecraftforge\.net\/?$/, `${FORGE_MAVEN}/`);
};
const resolveInstallMavenUrl = (groupId: string, mavenPath: string): string => {
  switch (groupId) {
    case "net.minecraft":
    case "com.mojang":
    case "lzma":
      return `https://libraries.minecraft.net/${mavenPath}`;
    default:
      return `${URLS.official.mavenCentral}/${mavenPath}`;
  }
};

export class ForgeLegacyHandler {
  constructor(
    private downloader: Downloader,
    private metaClient: MetaClient,
    private gameDir: string,
  ) {}

  private stripTrailingMinecraftVersionSegment(value: string): string {
    const match = value.match(/^(.*)-(\d+\.\d+(?:\.\d+)?)$/);
    if (!match?.[1]) {
      return value;
    }
    return match[1];
  }

  private normalizeForgeVersion(version: string): { mcVersion: string; loaderVersion: string } | null {
    const [mcVersion, ...rest] = version.split("-");
    if (!mcVersion || rest.length === 0) {
      return null;
    }

    let loaderVersion = rest.join("-");
    if (version.endsWith(`-${mcVersion}`)) {
      loaderVersion = rest.slice(0, -1).join("-");
    }
    loaderVersion = this.stripTrailingMinecraftVersionSegment(loaderVersion);

    return loaderVersion ? { mcVersion, loaderVersion } : null;
  }

  private async fetchMetadata(): Promise<MavenMetadata> {
    const metadata: MavenMetadata = {};

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
      return res.ok ? (await res.json() as ForgeVersionData).promos : {};
    } catch {
      return {};
    }
  }

  async getVersions(mcVersion: string): Promise<string[]> {
    const [metadata, promos] = await Promise.all([
      this.fetchMetadata(),
      this.fetchPromotions(),
    ]);

    const versions = new Set(metadata[mcVersion] ?? []);
    const recommended = promos[`${mcVersion}-recommended`];
    const latest = promos[`${mcVersion}-latest`];

    if (recommended) versions.add(recommended);
    if (latest) versions.add(latest);

    return [...versions];
  }

  async getSupportedMinecraftVersions(): Promise<string[]> {
    const [metadata, promos] = await Promise.all([
      this.fetchMetadata(),
      this.fetchPromotions(),
    ]);

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

  async getRecommendedVersion(mcVersion: string): Promise<string | undefined> {
    const promos = await this.fetchPromotions();
    return promos[`${mcVersion}-recommended`];
  }

  async install(mcVersion: string, forgeVersion: string, onProgress?: DownloadProgressCallback): Promise<LoaderInstallResult> {
    const fullVersion = this.getFullForgeVersion(mcVersion, forgeVersion);
    const profileName = `forge-${fullVersion}`;
    const versionDir = getVersionDir(this.gameDir, profileName);
    const installerDest = path.join(versionDir, `forge-${fullVersion}-installer.jar`);
    ensureDirSync(versionDir);
    await this.downloadInstaller(fullVersion, installerDest, onProgress);
    const versionJson = await this.extractAndProcessInstaller(installerDest, fullVersion, mcVersion, profileName, versionDir, onProgress);
    return { versionJson, versionJsonPath: path.join(versionDir, `${profileName}.json`), profileName };
  }

  getFullForgeVersion(mcVersion: string, forgeVersion: string): string {
    const normalized = this.stripTrailingMinecraftVersionSegment(forgeVersion.trim());
    if (normalized.startsWith(`${mcVersion}-`)) return normalized;
    if (normalized.endsWith(`-${mcVersion}`)) {
      return normalized;
    }
    if (normalized.includes(mcVersion)) return normalized;
    const mcVersionParts = mcVersion.split(".");
    const mcMinor = parseInt(mcVersionParts[1] || "0");
    if (mcMinor <= 8) {
      return `${mcVersion}-${normalized}-${mcVersion}`;
    }
    return `${mcVersion}-${normalized}`;
  }

  async determineArtifactType(fullVersion: string): Promise<string> {
    return await this.assetExists(getForgeArtifactUrl(fullVersion, "universal")) ? "universal" : "client";
  }

  getMavenUrlForLibrary(groupId: string, _artifactId: string, _version: string, mavenPath: string): string | null {
    return resolveMavenUrl(groupId, mavenPath);
  }

  private async assetExists(url: string): Promise<boolean> {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  }

  private hasDownloadedFile(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  }

  private parseJsonEntry<T>(zip: import("adm-zip"), name: string): T | undefined {
    const entry = zip.getEntry(name);
    return entry ? JSON.parse(entry.getData().toString("utf-8")) as T : undefined;
  }

  private getLibraryDownload(name: string, baseUrl?: string): { url: string; path: string } | null {
    const parsed = parseLibraryName(name);
    if (!parsed) return null;
    const libPath = mavenCoordinateToPath(parsed.groupId, parsed.artifactId, parsed.version, parsed.classifier);
    const resolvedBase = normalizeForgeBaseUrl(baseUrl) ?? resolveMavenUrl(parsed.groupId, "");
    const isDirectFile = /\.(jar|zip)(\?.*)?$/.test(resolvedBase) || /\/download(\?.*)?$/.test(resolvedBase);
    return { url: isDirectFile ? resolvedBase : `${resolvedBase}${libPath}`.replace(/([^:]\/)\/+/g, "$1"), path: libPath };
  }

  private getInstallLibraryDownload(name: string, baseUrl?: string): { url: string; path: string } | null {
    const parsed = parseLibraryName(name);
    if (!parsed) return null;
    const libPath = mavenCoordinateToPath(parsed.groupId, parsed.artifactId, parsed.version, parsed.classifier);
    const url = baseUrl ? this.getLibraryDownload(name, baseUrl)?.url : resolveInstallMavenUrl(parsed.groupId, libPath);
    return url ? { url, path: libPath } : null;
  }

  private artifactOption(artifact: ArtifactDownload | undefined, onProgress?: DownloadProgressCallback): DownloadOptions | null {
    if (!artifact?.url || !artifact.path || !artifact.url.startsWith("http")) return null;
    const dest = path.join(getLibraryDir(this.gameDir), artifact.path);
    return this.hasDownloadedFile(dest) ? null : { url: artifact.url, dest, sha1: artifact.sha1, size: artifact.size, onProgress };
  }

  private libraryOption(lib: VersionJsonLibrary, onProgress?: DownloadProgressCallback): DownloadOptions | null {
    const parsed = parseLibraryName(lib.name);
    if (!parsed || (parsed.groupId === "net.minecraftforge" && parsed.artifactId === "forge")) return null;
    const download = this.getInstallLibraryDownload(lib.name, lib.url);
    if (!download) return null;
    const dest = path.join(getLibraryDir(this.gameDir), download.path);
    return this.hasDownloadedFile(dest) ? null : { url: download.url, dest, onProgress };
  }

  private getForgeVersionFromLibraries(versionJson: VersionJson): string | undefined {
    return versionJson.libraries?.find(lib => lib.name?.startsWith("net.minecraftforge:forge:"))?.name?.split(":")[2];
  }

  private normalizeLibrary(lib: VersionJsonLibrary, fullVersion: string): VersionJsonLibrary {
    if (!lib.name) return lib;
    if (lib.name.startsWith("net.minecraftforge:forge:")) {
      const [, , version, classifier] = lib.name.split(":");
      const isLauncherArtifact = !classifier || classifier === version?.split("-")[0];
      const artifactUrl = isLauncherArtifact
        ? getForgeLauncherArtifactUrl(fullVersion)
        : getForgeArtifactUrl(fullVersion, classifier);
      const artifactPath = isLauncherArtifact
        ? getForgeLauncherArtifactPath(fullVersion)
        : getForgeArtifactPath(fullVersion, classifier);
      return {
        name: lib.name,
        exact_url: artifactUrl,
        downloads: {
          artifact: {
            url: artifactUrl,
            path: artifactPath,
            sha1: lib.downloads?.artifact?.sha1 ?? "",
            size: lib.downloads?.artifact?.size ?? 0,
          },
        },
      } as VersionJsonLibrary;
    }
    if (lib.name.startsWith("java3d:vecmath:1.5.2")) return getJava3dLibrary();
    if (lib.downloads?.artifact?.url) return lib;
    const download = this.getLibraryDownload(lib.name, lib.url);
    return download ? { ...lib, url: normalizeForgeBaseUrl(lib.url), downloads: { artifact: { url: download.url, path: download.path, sha1: "", size: 0 } } } : lib;
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

  private async downloadFromUrls(urls: string[], dest: string, onProgress?: DownloadProgressCallback): Promise<boolean> {
    let lastError: unknown = undefined;

    for (const url of urls) {
      try {
        await this.downloader.download({ url, dest, onProgress });
        if (this.hasDownloadedFile(dest)) return true;
      } catch (err) {
        lastError = err;
      }
    }

    if (this.hasDownloadedFile(dest)) return true;
    if (lastError instanceof Error) {
      console.log(`Failed to download from fallback URLs for ${path.basename(dest)}: ${lastError.message}`);
    }
    return false;
  }

  private async downloadInstaller(fullVersion: string, dest: string, onProgress?: DownloadProgressCallback): Promise<void> {
    const installerUrls = [
      `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`,
      `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-universal.jar`,
    ];
    if (await this.downloadFromUrls(installerUrls, dest, onProgress)) return;
    
    console.log("Installer not found, trying to download universal jar as installer...");
    const universalUrls = [
      `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-universal.jar`,
    ];
    if (await this.downloadFromUrls(universalUrls, dest, onProgress)) return;
    throw this.createVersionError(fullVersion);
  }

  private createVersionError(fullVersion: string): Error {
    const mcVer = fullVersion.split("-")[0];
    const help = mcVer === "1.8.9"
      ? "\nFor 1.8.9, try version 11.15.1.1722"
      : mcVer === "1.7.10"
        ? `\nFor 1.7.10, use MCArchive: ${URLS.official.mcArchiveForgeHelp}`
        : "\nNote: Old Forge versions may not be on Forge servers.";
    return new Error(`Failed to download Forge installer for ${fullVersion}.${help}`);
  }

  private buildVersionJson(versionJson: VersionJson, profileName: string, mcVersion: string, fullVersion: string, fallbackJar: string): VersionJson {
    if (!this.getForgeVersionFromLibraries(versionJson)) return { ...versionJson, id: profileName, inheritsFrom: versionJson.inheritsFrom || mcVersion, mainClass: versionJson.mainClass || MAIN_CLASS, jar: fallbackJar };
    return {
      ...versionJson,
      id: profileName,
      inheritsFrom: versionJson.inheritsFrom || mcVersion,
      mainClass: versionJson.mainClass || MAIN_CLASS,
      jar: fullVersion.startsWith(mcVersion) ? `forge-${fullVersion}` : profileName,
      libraries: versionJson.libraries?.map(lib => this.normalizeLibrary(lib, fullVersion)),
    };
  }

  private async buildVersionJsonFromProfile(profile: ForgeInstallerProfile, mcVersion: string, fullVersion: string): Promise<VersionJson> {
    const baseJson = await this.metaClient.fetchVersionJson(mcVersion);
    const artifactType = await this.determineArtifactType(fullVersion);
    const versionInfo = getProfileVersionInfo(profile);
    return this.mergeBaseMetadata({
      ...baseJson,
      id: `forge-${fullVersion}`,
      inheritsFrom: mcVersion,
      mainClass: MAIN_CLASS,
      jar: `forge-${fullVersion}`,
      minecraftArguments: versionInfo?.minecraftArguments ?? "",
      libraries: [
        {
          name: `net.minecraftforge:forge:${fullVersion}:${artifactType}`,
          downloads: { artifact: { url: getForgeArtifactUrl(fullVersion, artifactType), path: getForgeArtifactPath(fullVersion, artifactType), sha1: "", size: 0 } },
        },
        ...(versionInfo?.libraries ?? []).map(lib => this.normalizeLibrary({ name: lib.name } as VersionJsonLibrary, fullVersion)),
        ...(baseJson.libraries ?? []),
      ],
    }, baseJson);
  }

  private async resolveVersionJson(versionJson: VersionJson | undefined, profile: ForgeInstallerProfile | undefined, profileName: string, mcVersion: string, fullVersion: string): Promise<VersionJson> {
    const baseJson = await this.metaClient.fetchVersionJson(mcVersion);
    if (versionJson) return this.mergeBaseMetadata(this.buildVersionJson(versionJson, profileName, mcVersion, fullVersion, `forge-${fullVersion}`), baseJson);
    if (!profile) throw new Error("Neither install_profile.json nor version.json found in Forge installer");
    const versionInfo = getProfileVersionInfo(profile);
    if (versionInfo?.libraries?.length) {
      return this.mergeBaseMetadata(this.buildVersionJson(versionInfo, profileName, mcVersion, this.getForgeVersionFromLibraries(versionInfo) ?? fullVersion, profileName), baseJson);
    }
    return await this.buildVersionJsonFromProfile(profile, mcVersion, fullVersion);
  }

  private async ensureJava3d(onProgress?: DownloadProgressCallback): Promise<void> {
    const java3dPath = path.join(getLibraryDir(this.gameDir), JAVA3D_PATH);
    if (fs.existsSync(java3dPath)) return;
    ensureDirSync(path.dirname(java3dPath));
    try {
      await this.downloader.download({ url: `${URLS.official.mavenCentral}/java3d/vecmath/1.3.1/vecmath-1.3.1.jar`, dest: java3dPath, onProgress });
    } catch {}
  }

  private async downloadProfileLibraries(profile: ForgeInstallerProfile, onProgress?: DownloadProgressCallback): Promise<void> {
    const versionItems = (getProfileVersionInfo(profile)?.libraries ?? [])
      .map(lib => this.libraryOption(lib, onProgress))
      .filter(Boolean) as DownloadOptions[];
    const profileItems = (profile.libraries ?? [])
      .map((lib) => {
        const artifact = lib.downloads?.artifact;
        if (!artifact?.path || !artifact.url) return null;
        return this.artifactOption(artifact as ArtifactDownload, onProgress);
      })
      .filter(Boolean) as DownloadOptions[];
    if (versionItems.length + profileItems.length > 0) await this.downloader.downloadMultiple([...versionItems, ...profileItems], 5);
  }

  private async ensureForgeArtifacts(fullVersion: string, onProgress?: DownloadProgressCallback): Promise<void> {
    const forgeDir = path.join(getLibraryDir(this.gameDir), "net", "minecraftforge", "forge", fullVersion);
    const launcherDest = path.join(forgeDir, `forge-${fullVersion}.jar`);
    const clientDest = path.join(forgeDir, `forge-${fullVersion}-client.jar`);
    const universalDest = path.join(forgeDir, `forge-${fullVersion}-universal.jar`);
    ensureDirSync(forgeDir);

    if (!fs.existsSync(launcherDest)) {
      const launcherUrl = getForgeLauncherArtifactUrl(fullVersion);
      console.log(`Downloading Forge launcher jar...`);
      await this.downloader.download({ url: launcherUrl, dest: launcherDest, onProgress });
      console.log(`Forge launcher jar downloaded to: ${launcherDest}`);
    }

    if (!fs.existsSync(clientDest) && !fs.existsSync(universalDest)) {
      const universalUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-universal.jar`;
      console.log(`Downloading Forge universal jar...`);
      await this.downloader.download({ url: universalUrl, dest: universalDest, onProgress });
      console.log(`Forge universal jar downloaded to: ${universalDest}`);
    }
  }

  private async extractAndProcessInstaller(installerDest: string, fullVersion: string, mcVersion: string, profileName: string, versionDir: string, onProgress?: DownloadProgressCallback): Promise<VersionJson> {
    const AdmZip = (await import("adm-zip/adm-zip.js")).default;
    const zip = new AdmZip(installerDest);
    const profile = this.parseJsonEntry<ForgeInstallerProfile>(zip, "install_profile.json");
    const rawVersionJson = this.parseJsonEntry<VersionJson>(zip, "version.json");
    const versionJson = await this.resolveVersionJson(rawVersionJson, profile, profileName, mcVersion, fullVersion);
    fs.writeFileSync(path.join(versionDir, `${profileName}.json`), JSON.stringify(versionJson, null, 2));
    if (profile) {
      await this.ensureJava3d(onProgress);
      await this.downloadProfileLibraries(profile, onProgress);
      await this.ensureForgeArtifacts(fullVersion, onProgress);
    }
    const properJarDest = path.join(versionDir, `forge-${fullVersion}.jar`);
    if (!fs.existsSync(properJarDest)) fs.renameSync(installerDest, properJarDest);
    return versionJson;
  }
}
