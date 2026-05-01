// ============================================================
// XNLC — Main Library Class
// Orchestrates all components for Minecraft launching
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import * as fs from "fs";
import {
  XnlcOptions,
  OSInfo,
  AuthSession,
  LoaderType,
  VersionSelection,
  VersionJson,
  DownloadProgress,
  DownloadProgressCallback,
  LaunchResult,
  LoaderInstallResult,
  InstallationPhase,
  MojangVersionEntry,
  FabricGameVersion,
  FabricLoaderVersion,
  QuiltGameVersion,
  QuiltLoaderVersion,
} from "./types/index.js";
import { MetaClient } from "./core/meta-client.js";
import { VersionResolver } from "./core/version-resolver.js";
import { Downloader } from "./core/downloader.js";
import { LibrariesManager } from "./core/libraries-manager.js";
import { AssetsManager } from "./core/assets-manager.js";
import { NativesExtractor } from "./core/natives-extractor.js";
import { LaunchBuilder } from "./core/launch-builder.js";
import { JavaRunner } from "./core/java-runner.js";
import { JavaManager } from "./core/java-manager.js";
import { LoaderResolver } from "./loaders/loader-resolver.js";
import { AuthManager } from "./auth/auth-manager.js";
import { parseOptifineFilename } from "./loaders/optifine-handler.js";
import {
  getGameDirStructure,
  getVersionDir,
  getLibraryDir,
  getOSInfo,
  ensureDirSync,
  sha1HashSync,
  isLegacyForge,
  getRequiredJavaVersion as resolveJavaVersion,
  shouldRepairOptifineProfile as checkRepairOptifine,
} from "./utils/index.js";

type PreparationPlan = {
  totalFiles: number;
  totalBytes: number;
};

class ProgressTracker {
  private completedFiles = 0;
  private completedBytes = 0;
  private activeBytes = new Map<string, number>();
  private finishedFiles = new Set<string>();

  constructor(
    private readonly plan: PreparationPlan,
    private readonly emit?: DownloadProgressCallback,
  ) {}

  onProgress = (progress: DownloadProgress): void => {
    if (!this.emit) return;

    const fileId = progress.file ?? progress.fileName ?? "__unknown__";
    const downloaded = progress.downloaded ?? progress.downloadedBytes ?? 0;
    const total = progress.total ?? 0;

    if (!this.finishedFiles.has(fileId)) {
      this.activeBytes.set(fileId, downloaded);
      if (total > 0 && downloaded >= total) {
        this.finishedFiles.add(fileId);
        this.completedFiles += 1;
        this.completedBytes += total;
        this.activeBytes.delete(fileId);
      }
    }

    const activeBytes = [...this.activeBytes.values()].reduce((sum, value) => sum + value, 0);
    const downloadedBytes = Math.min(this.plan.totalBytes, this.completedBytes + activeBytes);
    const percent = this.plan.totalBytes > 0
      ? Math.min(100, Math.round((downloadedBytes / this.plan.totalBytes) * 100))
      : progress.percent;

    this.emit({
      ...progress,
      downloadedBytes,
      currentFile: Math.min(this.plan.totalFiles, this.completedFiles + this.activeBytes.size),
      totalFiles: this.plan.totalFiles,
      percent,
    });
  };
}

function withStage(stage: string, callback?: DownloadProgressCallback): DownloadProgressCallback | undefined {
  if (!callback) return undefined;
  return (progress) => callback({ ...progress, type: stage });
}

function resolveVersionId(versionJson: VersionJson, versionIdOverride?: string): string {
  return versionIdOverride ?? versionJson.inheritsFrom ?? versionJson.id;
}

export class Xnlc {
  // Core components
  public metaClient: MetaClient;
  public versionResolver: VersionResolver;
  public downloader: Downloader;
  public librariesManager!: LibrariesManager;
  public assetsManager: AssetsManager;
  public nativesExtractor!: NativesExtractor;
  public launchBuilder!: LaunchBuilder;
  public javaRunner: JavaRunner;
  public javaManager!: JavaManager;
  public loaderResolver!: LoaderResolver;

  // Config
  private options: XnlcOptions;
  private osInfo: OSInfo;

  constructor(options: XnlcOptions) {
    this.options = options;
    this.osInfo = options.os ?? getOSInfo();
    getGameDirStructure(options.gameDir);

    // Initialize core components
    this.metaClient = new MetaClient();
    this.versionResolver = new VersionResolver(this.metaClient);
    this.downloader = new Downloader();
    this.assetsManager = new AssetsManager(this.downloader);
    this.javaRunner = new JavaRunner();

    // Initialize dependent components
    this.initDependentComponents();
  }

  private initDependentComponents(): void {
    this.librariesManager = new LibrariesManager(this.downloader, this.options.gameDir, this.osInfo);
    this.nativesExtractor = new NativesExtractor(this.librariesManager);
    this.launchBuilder = new LaunchBuilder(
      this.osInfo,
      this.options.gameDir,
      this.options.launcherName ?? "xnlc",
      this.options.launcherVersion ?? "1.0.0",
    );
    this.javaManager = new JavaManager(this.downloader, this.options.gameDir);
    this.loaderResolver = new LoaderResolver(
      this.downloader,
      this.metaClient,
      this.options.gameDir,
      this.options.customVersionsDir,
    );
  }

  // ---------- Version Discovery ----------

  async getMojangVersions(): Promise<MojangVersionEntry[]> {
    return this.metaClient.getAllVersions();
  }

  async getLatestRelease(): Promise<string> {
    return this.metaClient.getLatestRelease();
  }

  async getLatestSnapshot(): Promise<string> {
    return this.metaClient.getLatestSnapshot();
  }

  async getForgeVersions(mcVersion: string): Promise<string[]> {
    return this.getForgeHandler(mcVersion).getVersions(mcVersion);
  }

  async getForgeRecommended(mcVersion: string): Promise<string | undefined> {
    return this.getForgeHandler(mcVersion).getRecommendedVersion(mcVersion);
  }

  async getForgeSupportedVersions(): Promise<string[]> {
    const modern = await this.loaderResolver.getForgeHandler().getSupportedMinecraftVersions();
    const legacy = await this.loaderResolver.getForgeLegacyHandler().getSupportedMinecraftVersions();
    return [...new Set([...legacy, ...modern])];
  }

  async getNeoForgeVersions(mcVersion: string): Promise<string[]> {
    return this.loaderResolver.getNeoForgeHandler().getVersions(mcVersion);
  }

  async getNeoForgeSupportedVersions(): Promise<string[]> {
    return this.loaderResolver.getNeoForgeHandler().getSupportedMinecraftVersions();
  }

  async getNeoForgeRecommended(mcVersion: string): Promise<string | undefined> {
    return this.loaderResolver.getNeoForgeHandler().getRecommendedVersion(mcVersion);
  }

  async getFabricGameVersions(): Promise<FabricGameVersion[]> {
    return this.loaderResolver.getFabricHandler().getGameVersions();
  }

  async getFabricLoaderVersions(mcVersion: string): Promise<FabricLoaderVersion[]> {
    return this.loaderResolver.getFabricHandler().getLoaderVersionsForGame(mcVersion);
  }

  async getQuiltGameVersions(): Promise<QuiltGameVersion[]> {
    return this.loaderResolver.getQuiltHandler().getGameVersions();
  }

  async getQuiltLoaderVersions(mcVersion: string): Promise<QuiltLoaderVersion[]> {
    return this.loaderResolver.getQuiltHandler().getLoaderVersionsForGame(mcVersion);
  }

  async getOptifineVersions(mcVersion: string): Promise<import("./loaders/optifine-handler.js").OptifineVersion[]> {
    return this.loaderResolver.getOptifineHandler().getVersions(mcVersion);
  }

  async getOptifineSupportedVersions(): Promise<string[]> {
    return this.loaderResolver.getOptifineHandler().getSupportedVersions();
  }

  async getOptifineAllVersions(): Promise<import("./loaders/optifine-handler.js").OptifineVersion[]> {
    return this.loaderResolver.getOptifineHandler().getAllVersions();
  }

  async getOptifineRecommended(mcVersion: string): Promise<import("./loaders/optifine-handler.js").OptifineVersion | undefined> {
    return this.loaderResolver.getOptifineHandler().getRecommendedVersion(mcVersion);
  }

  async getCustomVersions(): Promise<string[]> {
    return this.loaderResolver.getCustomVersionHandler().getVersions();
  }

  // ---------- Download & Install ----------

  async downloadVanilla(mcVersion: string, onProgress?: DownloadProgressCallback): Promise<VersionJson> {
    const versionJson = await this.versionResolver.resolveVersion(mcVersion, this.osInfo);
    const plan = await this.buildPreparationPlan(versionJson, mcVersion);
    const tracker = new ProgressTracker(plan, onProgress);

    // Download client jar
    const clientDownload = versionJson.downloads?.client;
    if (clientDownload?.url) {
      const versionDir = getVersionDir(this.options.gameDir, mcVersion);
      ensureDirSync(versionDir);
      const clientDest = path.join(versionDir, `${mcVersion}.jar`);

      await this.downloader.download({
        url: clientDownload.url,
        dest: clientDest,
        sha1: clientDownload.sha1,
        size: clientDownload.size,
        onProgress: withStage("game", tracker.onProgress),
      });
    }

    // Write version.json
    const versionDir = getVersionDir(this.options.gameDir, mcVersion);
    ensureDirSync(versionDir);
    const versionJsonPath = path.join(versionDir, `${mcVersion}.json`);
    fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2));

    // Download libraries
    await this.librariesManager.resolveAndDownload(versionJson, withStage("libraries", tracker.onProgress));

    // Download assets
    await this.assetsManager.downloadAssets(versionJson, this.options.gameDir, withStage("assets", tracker.onProgress));

    return versionJson;
  }

  private getLoaderInstallationPhase(loaderType: LoaderType): InstallationPhase {
    switch (loaderType) {
      case "forge":
      case "forge-legacy":
        return "installing-loader";
      case "neoforge":
        return "installing-loader";
      case "fabric":
      case "fabric-legacy":
      case "quilt":
        return "downloading-libraries";
      case "optifine":
        return "installing-loader";
      default:
        return "installing";
    }
  }

  async installLoader(
    mcVersion: string,
    loaderType: LoaderType,
    loaderVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<LoaderInstallResult> {
    const actualLoaderType = this.loaderResolver.determineLoaderType(mcVersion, loaderType, loaderVersion);
    const installPhase = this.getLoaderInstallationPhase(actualLoaderType);
    
    onProgress?.({
      type: actualLoaderType,
      installationPhase: installPhase,
      percent: 0,
    });

    return this.loaderResolver.installLoader(
      mcVersion,
      actualLoaderType,
      loaderVersion,
      onProgress,
    );
  }

  private async buildPreparationPlan(versionJson: VersionJson, versionIdOverride?: string): Promise<PreparationPlan> {
    const vanillaMeta = this.countVanillaMeta(versionJson, versionIdOverride);
    const libraries = {
      totalFiles: this.librariesManager.countTotalFiles(versionJson),
      totalBytes: this.librariesManager.countTotalSize(versionJson),
    };
    const assets = {
      totalFiles: await this.assetsManager.countAssets(versionJson, this.options.gameDir),
      totalBytes: await this.assetsManager.countTotalSize(versionJson, this.options.gameDir),
    };

    return {
      totalFiles: vanillaMeta.totalFiles + libraries.totalFiles + assets.totalFiles,
      totalBytes: vanillaMeta.totalBytes + libraries.totalBytes + assets.totalBytes,
    };
  }

  private countVanillaMeta(versionJson: VersionJson, versionIdOverride?: string): PreparationPlan {
    let totalFiles = 0;
    let totalBytes = 0;
    const versionId = resolveVersionId(versionJson, versionIdOverride);

    const clientDownload = versionJson.downloads?.client;
    if (clientDownload?.url) {
      const clientDest = path.join(getVersionDir(this.options.gameDir, versionId), `${versionId}.jar`);
      if (!fs.existsSync(clientDest)) {
        totalFiles += 1;
        totalBytes += clientDownload.size ?? 0;
      }
    }

    return { totalFiles, totalBytes };
  }

  private async ensureClientJar(
    versionJson: VersionJson,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const clientDownload = versionJson.downloads?.client;
    if (!clientDownload?.url) {
      return;
    }

    const versionId = resolveVersionId(versionJson);
    const versionDir = getVersionDir(this.options.gameDir, versionId);
    ensureDirSync(versionDir);

    const clientDest = path.join(versionDir, `${versionId}.jar`);
    if (fs.existsSync(clientDest)) {
      return;
    }

    await this.downloader.download({
      url: clientDownload.url,
      dest: clientDest,
      sha1: clientDownload.sha1,
      size: clientDownload.size,
      onProgress,
    });
  }

  private async ensureBaseVanillaInstalled(
    mcVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const baseVersionDir = getVersionDir(this.options.gameDir, mcVersion);
    const baseVersionJsonPath = path.join(baseVersionDir, `${mcVersion}.json`);
    const baseClientJarPath = path.join(baseVersionDir, `${mcVersion}.jar`);

    if (fs.existsSync(baseVersionJsonPath) && fs.existsSync(baseClientJarPath)) {
      return;
    }

    await this.downloadVanilla(mcVersion, onProgress);
  }

  private logJavaRuntime(javaRuntime: Awaited<ReturnType<JavaManager["findOrDownloadJava"]>>): void {
    if (javaRuntime.vendor === "azul") {
      console.log(`Java ${javaRuntime.version} downloaded and ready.`);
    } else if (javaRuntime.vendor === "downloaded") {
      console.log(`Using previously downloaded Java ${javaRuntime.version}.`);
    } else {
      console.log(`Using system Java ${javaRuntime.version} at ${javaRuntime.path}.`);
    }
  }

  // ---------- Launch ----------

  async launch(
    selection: VersionSelection,
    auth: AuthSession,
    config: {
      javaPath?: string;
      jvmArgs?: string[];
      gameArgs?: string[];
      memoryMin?: string;
      memoryMax?: string;
      width?: number;
      height?: number;
    } = {},
    onProgress?: DownloadProgressCallback,
  ): Promise<LaunchResult> {
    this.ensureLauncherProfiles();

    const resolvedSelection = await this.resolveSelection(selection);
    const { loaderType, customVersionPath } = resolvedSelection;
    let javaRuntime: Awaited<ReturnType<JavaManager["findOrDownloadJava"]>> | null = null;

    // Order requirement: Java -> Vanilla -> Modloader.
    // For non-custom launches we can resolve required Java from base vanilla metadata first.
    if (!customVersionPath && loaderType !== "custom") {
      const baseVersionJson = await this.versionResolver.resolveVersion(resolvedSelection.mcVersion, this.osInfo);
      const requiredJavaVersion = this.getRequiredJavaVersion(baseVersionJson);
      javaRuntime = await this.javaManager.findOrDownloadJava(
        requiredJavaVersion,
        config.javaPath ?? this.options.javaPath,
      );
      this.logJavaRuntime(javaRuntime);
    }

    const versionJson = await this.resolveLaunchVersion(resolvedSelection, onProgress);
    
    // For custom versions with inheritsFrom, resolve inheritance to get base Minecraft libraries
    // Otherwise use the resolved versionJson directly
    const resolvedJson = customVersionPath
      ? (versionJson.inheritsFrom
        ? await this.versionResolver.resolveVersionFromJson(versionJson, this.osInfo)
        : versionJson)
      : loaderType === "vanilla"
        ? await this.versionResolver.resolveVersion(versionJson.id, this.osInfo)
        : await this.versionResolver.resolveVersionFromJson(versionJson, this.osInfo);

    const plan = await this.buildPreparationPlan(resolvedJson);
    const tracker = new ProgressTracker(plan, onProgress);

    // Step 4: Ensure the client jar exists for the launch target.
    // Inherited profiles such as Fabric/Quilt need the base Minecraft jar
    // present under the parent version directory for the runtime classpath.
    await this.ensureClientJar(resolvedJson, withStage("game", tracker.onProgress));

    // Step 5: Download libraries for resolved version
    const libraries = await this.librariesManager.resolveAndDownload(resolvedJson, withStage("libraries", tracker.onProgress));

    // Step 6: Download assets
    await this.assetsManager.downloadAssets(resolvedJson, this.options.gameDir, withStage("assets", tracker.onProgress));

    // Step 7: Extract natives
    await this.nativesExtractor.extractNatives(resolvedJson, this.options.gameDir);

    // Fallback for custom version paths where required Java is unknown before resolving version JSON.
    if (!javaRuntime) {
      const requiredJavaVersion = this.getRequiredJavaVersion(resolvedJson);
      javaRuntime = await this.javaManager.findOrDownloadJava(
        requiredJavaVersion,
        config.javaPath ?? this.options.javaPath,
      );
      this.logJavaRuntime(javaRuntime);
    }

    const javaPath = javaRuntime.path;

    // Step 9: Build launch command
    const command = this.launchBuilder.build(
      resolvedJson,
      auth,
      libraries,
      javaPath,
      config.jvmArgs ?? this.options.defaultJvmArgs ?? [],
      config.gameArgs ?? [],
      config.memoryMin,
      config.memoryMax,
      config.width,
      config.height,
    );

    // Step 10: Launch
    return this.javaRunner.launch(command, this.options.gameDir);
  }

  private async resolveLaunchVersion(
    selection: VersionSelection,
    onProgress?: DownloadProgressCallback,
  ): Promise<VersionJson> {
    const {
      mcVersion,
      loaderType = "vanilla",
      loaderVersion,
      customVersionPath,
    } = selection;
    
    // Handle custom version path (when user enters a path instead of MC version)
    if (customVersionPath) {
      const result = await this.loaderResolver.getCustomVersionHandler().install(customVersionPath, "", onProgress);
      return result.versionJson;
    }

    if (loaderType === "vanilla") {
      return this.downloadVanilla(mcVersion, onProgress);
    }

    if (loaderType === "custom") {
      if (!customVersionPath) {
        throw new Error("Custom version path is required for custom loaders");
      }
      const result = await this.loaderResolver.getCustomVersionHandler().install(customVersionPath, "", onProgress);
      return result.versionJson;
    }

    await this.ensureBaseVanillaInstalled(mcVersion, onProgress);

    if (!loaderVersion) {
      throw new Error(`Failed to resolve ${loaderType} version for Minecraft ${mcVersion}`);
    }

    const profileName = this.getProfileName(mcVersion, loaderType, loaderVersion);
    const versionJsonPath = this.getVersionJsonPath(profileName);
    await this.ensureInstalledVersion(selection, versionJsonPath, onProgress);
    if (!fs.existsSync(versionJsonPath)) {
      throw new Error(`Version JSON not found at ${versionJsonPath}`);
    }
    return this.readVersionJson(versionJsonPath);
  }

  private async resolveSelection(selection: VersionSelection): Promise<VersionSelection> {
    const loaderType = selection.loaderType ?? "vanilla";
    if (loaderType === "vanilla" || loaderType === "custom" || selection.loaderVersion) {
      return {
        ...selection,
        loaderType,
      };
    }

    return {
      ...selection,
      loaderType,
      loaderVersion: await this.resolveDefaultLoaderVersion(selection.mcVersion, loaderType),
    };
  }

  private async resolveDefaultLoaderVersion(
    mcVersion: string,
    loaderType: LoaderType,
  ): Promise<string> {
    switch (loaderType) {
      case "forge": {
        const recommended = await this.getForgeRecommended(mcVersion);
        if (recommended) return recommended;
        const versions = await this.getForgeVersions(mcVersion);
        if (versions.length > 0) return versions.at(-1)!;
        break;
      }
      case "neoforge": {
        const recommended = await this.getNeoForgeRecommended(mcVersion);
        if (recommended) return recommended;
        const versions = await this.getNeoForgeVersions(mcVersion);
        if (versions.length > 0) return versions.at(-1)!;
        break;
      }
      case "fabric": {
        const versions = await this.getFabricLoaderVersions(mcVersion);
        const stable = versions.find((version) => version.stable);
        if (stable?.version) return stable.version;
        if (versions[0]?.version) return versions[0].version;
        break;
      }
case "quilt": {
        const versions = await this.getQuiltLoaderVersions(mcVersion);
        const stable = versions.find((version) => !version.version.includes("-beta") && !version.version.includes("-pre") && !version.version.includes("-rc"));
        if (stable?.version) return stable.version;
        if (versions[0]?.version) return versions[0]?.version;
        break;
      }
      case "optifine": {
        const recommended = await this.getOptifineRecommended(mcVersion);
        if (recommended?.filename) return recommended.filename;
        const versions = await this.getOptifineVersions(mcVersion);
        if (versions[0]?.filename) return versions[0].filename;
        break;
      }
      default:
        break;
    }

    throw new Error(`No ${loaderType} versions found for Minecraft ${mcVersion}`);
  }

  private async ensureInstalledVersion(
    selection: VersionSelection,
    versionJsonPath: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const { mcVersion, loaderType = "vanilla", loaderVersion } = selection;
    if (!loaderVersion) return;

    if (!fs.existsSync(versionJsonPath)) {
      await this.installLoader(mcVersion, loaderType, loaderVersion, onProgress);
    }

    if (!fs.existsSync(versionJsonPath)) {
      return;
    }

    const current = this.readVersionJson(versionJsonPath);
    if (loaderType === "optifine" && this.shouldRepairOptifineProfile(current)) {
      await this.installLoader(mcVersion, loaderType, loaderVersion, onProgress);
      return;
    }

    if ((loaderType === "forge" || loaderType === "forge-legacy") && this.shouldRepairForgeProfile(current)) {
      await this.installLoader(mcVersion, loaderType, loaderVersion, onProgress);
      return;
    }

  }

  private readVersionJson(versionJsonPath: string): VersionJson {
    return JSON.parse(fs.readFileSync(versionJsonPath, "utf-8")) as VersionJson;
  }

  private getVersionJsonPath(profileName: string): string {
    return path.join(getVersionDir(this.options.gameDir, profileName), `${profileName}.json`);
  }

  private getProfileName(
    mcVersion: string,
    loaderType: LoaderType,
    loaderVersion: string,
  ): string {
    const actualLoaderType = this.loaderResolver.determineLoaderType(mcVersion, loaderType, loaderVersion);
    const parsedOptifine = loaderType === "optifine" ? parseOptifineFilename(loaderVersion) : null;
    const mcVersionParts = mcVersion.split(".");
    const mcMinor = parseInt(mcVersionParts[1] || "0");
    let versionSuffix: string;
    if (actualLoaderType === "forge" || actualLoaderType === "forge-legacy") {
      if (actualLoaderType === "forge-legacy") {
        if (loaderVersion.startsWith(`${mcVersion}-`)) {
          versionSuffix = loaderVersion;
        } else if (loaderVersion.endsWith(`-${mcVersion}`)) {
          versionSuffix = loaderVersion;
        } else if (loaderVersion.includes(mcVersion)) {
          versionSuffix = loaderVersion;
        } else if (mcMinor <= 8) {
          versionSuffix = `${mcVersion}-${loaderVersion}-${mcVersion}`;
        } else {
          versionSuffix = `${mcVersion}-${loaderVersion}`;
        }
      } else if (loaderVersion.includes(mcVersion)) {
        versionSuffix = `${mcVersion}-${loaderVersion.split("-")[1]}`;
      } else {
        versionSuffix = `${mcVersion}-${loaderVersion}`;
      }
    } else if (mcMinor <= 7) {
      versionSuffix = `${mcVersion}-${loaderVersion}-${mcVersion}`;
    } else {
      versionSuffix = `${mcVersion}-${loaderVersion}`;
    }

    switch (actualLoaderType) {
      case "forge":
      case "forge-legacy":
        return `forge-${versionSuffix}`;
      case "neoforge":
        return `NeoForge ${mcVersion}`;
      case "fabric":
      case "fabric-legacy":
        return `fabric-loader-${loaderVersion}-${mcVersion}`;
      case "quilt":
        return `quilt-loader-${loaderVersion}-${mcVersion}`;
      case "optifine":
        return parsedOptifine
          ? `${mcVersion}-OptiFine_${parsedOptifine.edition}_${parsedOptifine.release}`
          : `${mcVersion}-OptiFine_${loaderVersion}`;
      case "custom":
        return loaderVersion;
      default:
        return mcVersion;
    }
  }

  private getRequiredJavaVersion(versionJson: VersionJson): number {
    return resolveJavaVersion(versionJson);
  }

  private shouldRepairOptifineProfile(versionJson: VersionJson): boolean {
    return checkRepairOptifine(versionJson, this.osInfo);
  }

  private shouldRepairForgeProfile(versionJson: VersionJson): boolean {
    const forgeLib = versionJson.libraries?.find((lib) => /^net\.minecraftforge:forge:[^:]+$/.test(lib.name));
    const forgeArtifact = forgeLib?.downloads?.artifact;
    if (forgeArtifact?.path) {
      const forgePath = path.join(getLibraryDir(this.options.gameDir), forgeArtifact.path);
      if (!fs.existsSync(forgePath)) {
        return true;
      }

      if (forgeArtifact.size && fs.statSync(forgePath).size !== forgeArtifact.size) {
        return true;
      }

      if (forgeArtifact.sha1 && sha1HashSync(forgePath) !== forgeArtifact.sha1) {
        return true;
      }
    }

    const clientLib = versionJson.libraries?.find((lib) => /^net\.minecraftforge:forge:.+:client$/.test(lib.name));
    const artifact = clientLib?.downloads?.artifact;
    if (!artifact?.path) {
      return false;
    }

    const clientPath = path.join(getLibraryDir(this.options.gameDir), artifact.path);
    if (!fs.existsSync(clientPath)) {
      return true;
    }

    if (artifact.size && fs.statSync(clientPath).size !== artifact.size) {
      return true;
    }

    return !!artifact.sha1 && sha1HashSync(clientPath) !== artifact.sha1;
  }

  private getForgeHandler(mcVersion: string) {
    return isLegacyForge(mcVersion, "")
      ? this.loaderResolver.getForgeLegacyHandler()
      : this.loaderResolver.getForgeHandler();
  }

  private ensureLauncherProfiles(): void {
    const launcherProfilesPath = path.join(this.options.gameDir, "launcher_profiles.json");
    if (!fs.existsSync(launcherProfilesPath)) {
      fs.writeFileSync(launcherProfilesPath, JSON.stringify({ profiles: {} }, null, 2));
    }
  }

  // ---------- Auth Helpers ----------

  createOfflineAuth(username: string): AuthSession {
    return AuthManager.createOfflineAuth(username);
  }

  // ---------- Getters ----------

  getGameDir(): string {
    return this.options.gameDir;
  }

  getOSInfo(): OSInfo {
    return this.osInfo;
  }
}
