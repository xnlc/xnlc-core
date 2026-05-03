export type OSType = "windows" | "linux" | "osx";
export type ArchType = "x86" | "x64" | "arm64";
export type VersionType = "release" | "snapshot" | "old_alpha" | "old_beta" | "modified";
export type AuthMode = "offline";
export type LoaderType =
  | "vanilla"
  | "forge"
  | "forge-legacy"
  | "neoforge"
  | "fabric"
  | "fabric-legacy"
  | "quilt"
  | "optifine"
  | "custom";
export type InstallationPhase =
  | "downloading-vanilla"
  | "downloading-installer"
  | "downloading-libraries"
  | "downloading-client"
  | "installing-loader"
  | "installing";

export interface OSInfo {
  os: OSType;
  arch: ArchType;
}

export interface MojangVersionEntry {
  id: string;
  type: VersionType | string;
  url: string;
  time?: string;
  releaseTime?: string;
  sha1?: string;
  complianceLevel?: number;
}

export interface MojangVersionManifest {
  latest: {
    release: string;
    snapshot: string;
  };
  versions: MojangVersionEntry[];
}

export interface VersionJsonDownload {
  sha1?: string;
  size?: number;
  url: string;
  path?: string;
}

export interface VersionJsonDownloads {
  client?: VersionJsonDownload;
  server?: VersionJsonDownload;
  client_mappings?: VersionJsonDownload;
  server_mappings?: VersionJsonDownload;
  artifact?: VersionJsonDownload;
  classifiers?: Record<string, VersionJsonDownload>;
  [key: string]: VersionJsonDownload | Record<string, VersionJsonDownload> | undefined;
}

export interface VersionJsonAssetIndex {
  id: string;
  sha1?: string;
  size?: number;
  totalSize?: number;
  url: string;
}

export interface VersionJsonJavaVersion {
  component?: string;
  majorVersion?: number;
}

export interface VersionJsonRule {
  action: "allow" | "disallow";
  os?: {
    name?: OSType | string;
    version?: string;
    arch?: string;
  };
  features?: Record<string, boolean>;
}

export interface VersionJsonArgumentValue {
  rules?: VersionJsonRule[];
  value: string | string[];
}

export interface VersionJsonArguments {
  game?: Array<string | VersionJsonArgumentValue>;
  jvm?: Array<string | VersionJsonArgumentValue>;
}

export interface VersionJsonLogging {
  client?: {
    argument?: string;
    file?: VersionJsonDownload & { id?: string };
    type?: string;
  };
  [key: string]: unknown;
}

export interface VersionJsonLibrary {
  name: string;
  downloads?: {
    artifact?: VersionJsonDownload;
    classifiers?: Record<string, VersionJsonDownload>;
  };
  natives?: Record<string, string>;
  rules?: VersionJsonRule[];
  extract?: {
    exclude?: string[];
  };
  url?: string;
  sha1?: string;
  size?: number;
  checksum?: string;
  serverreq?: boolean;
  clientreq?: boolean;
  downloadOnly?: boolean;
  includeInClasspath?: boolean;
  [key: string]: unknown;
}

export interface VersionJson {
  id: string;
  time?: string;
  releaseTime?: string;
  type: VersionType | string;
  mainClass: string;
  inheritsFrom?: string;
  jar?: string;
  family?: string;
  minecraftArguments?: string;
  arguments?: VersionJsonArguments;
  libraries: VersionJsonLibrary[];
  downloads?: VersionJsonDownloads;
  assetIndex?: VersionJsonAssetIndex;
  assets?: string;
  javaVersion?: VersionJsonJavaVersion;
  logging?: VersionJsonLogging;
  minimumLauncherVersion?: number;
  tlauncherVersion?: number;
  complianceLevel?: number;
  releaseType?: string;
  [key: string]: unknown;
}

export interface ResolvedLibrary {
  name: string;
  path: string;
  url?: string;
  sha1?: string;
  size?: number;
  natives?: Record<string, string>;
  isNative: boolean;
  classifier?: string;
}

export interface AssetIndexEntry {
  hash: string;
  size: number;
}

export interface AssetIndex {
  objects: Record<string, AssetIndexEntry>;
  virtual?: boolean;
  map_to_resources?: boolean;
}

export interface AuthSession {
  username: string;
  uuid: string;
  accessToken: string;
  profileId?: string;
  profileName?: string;
  userProperties?: string;
  meta?: Record<string, unknown>;
}

export interface OfflineAuth extends AuthSession {
  mode: "offline";
}

export type LoaderVersion = string;

export interface LoaderInstallResult {
  versionJson: VersionJson;
  versionJsonPath: string;
  profileName: string;
}

export interface LaunchConfig {
  javaPath?: string;
  jvmArgs?: string[];
  gameArgs?: string[];
  memoryMin?: string;
  memoryMax?: string;
  width?: number;
  height?: number;
}

export interface LaunchResult {
  process: import("child_process").ChildProcess;
  profileName: string;
  command: string;
}

export interface DownloadProgress {
  type?: string;
  file?: string;
  fileName?: string;
  currentFile?: number;
  totalFiles?: number;
  downloaded?: number;
  downloadedBytes?: number;
  total?: number;
  percent?: number;
  installationPhase?: InstallationPhase;
}

export type DownloadProgressCallback = (progress: DownloadProgress) => void;

export interface XnlcOptions {
  gameDir: string;
  os?: OSInfo;
  javaPath?: string;
  launcherName?: string;
  launcherVersion?: string;
  defaultJvmArgs?: string[];
  customVersionsDir?: string;
}

export interface VersionSelection {
  mcVersion: string;
  loaderType?: LoaderType;
  loaderVersion?: string;
  customVersionPath?: string;
}

export interface ForgeProfileLibrary extends VersionJsonLibrary {
  url?: string;
}

export interface ForgeProcessor {
  jar: string;
  sides?: string[];
  classpath?: string[];
  args?: string[];
  outputs?: Record<string, string>;
}

export interface ForgeInstallerProfile {
  spec?: number;
  profile?: string;
  version?: string;
  icon?: string;
  json?: string;
  path?: string;
  minecraft?: string;
  welcome?: string;
  data?: Record<string, { client?: string; server?: string }>;
  processors?: ForgeProcessor[];
  libraries?: ForgeProfileLibrary[];
  versionInfo?: VersionJson;
  mirrorList?: string;
  logo?: string;
  install?: {
    profileName?: string;
    target?: string;
    path?: string;
  };
  [key: string]: unknown;
}

export interface FabricGameVersion {
  version: string;
  stable: boolean;
}

export interface FabricLoaderVersion {
  version: string;
  stable: boolean;
}

export interface FabricProfileJson extends VersionJson {}

export interface QuiltGameVersion {
  version: string;
  stable: boolean;
}

export interface QuiltLoaderVersion {
  version: string;
  separator?: string;
  build?: number;
  maven?: string;
}

export interface QuiltLoaderMetadata {
  loader: QuiltLoaderVersion;
  intermediary?: {
    version?: string;
    stable?: boolean;
  };
  hashed?: {
    version?: string;
  };
}
