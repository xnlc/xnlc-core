// ============================================================
// XNLC — Launch Builder
// Builds JVM args, game args, and classpath
// Author: MAINER4IK
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { VersionJson, VersionJsonArgumentValue, OSInfo, AuthSession, ResolvedLibrary } from "../types/index.js";
import { getNativesDir, getLibraryDir, checkRules, flattenVersionJsonArguments, tokenizeCommandLine } from "../utils/index.js";

export interface LaunchCommand {
  javaPath: string;
  jvmArgs: string[];
  mainClass: string;
  gameArgs: string[];
  classpath: string;
}

const LINUX_JVM_ARGS = [
  "-Dorg.lwjgl.glfw.libname=libglfw.so",
  "-Dglfw.preferred.platform=x11",
];

const LINUX_HEADLESS_JVM_ARGS = [
  "-Dglfw.window.api=headless",
  "-Dorg.lwjgl.opengl.Display.forceDisplayOff=true",
  "-Djava.awt.headless=true",
  "-Djava.awt.graphics.headless=true",
];

const MODERN_LINUX_OPEN_ARGS = [
  "--add-opens=java.base/java.lang=ALL-UNNAMED",
  "--add-opens=java.base/java.util=ALL-UNNAMED",
  "--add-opens=java.base/java.io=ALL-UNNAMED",
  "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
  "--add-opens=java.base/java.net=ALL-UNNAMED",
];

export class LaunchBuilder {
  private javaVersionCache: Map<string, number> = new Map();

  constructor(
    private osInfo: OSInfo,
    private gameDir: string,
    private launcherName: string = "xnlc",
    private launcherVersion: string = "1.0.0",
  ) {}

  build(
    versionJson: VersionJson,
    auth: AuthSession,
    libraries: ResolvedLibrary[],
    javaPath: string,
    customJvmArgs: string[] = [],
    customGameArgs: string[] = [],
    memoryMin?: string,
    memoryMax?: string,
    width?: number,
    height?: number,
  ): LaunchCommand {
    const nativesDir = getNativesDir(this.gameDir);
    const classpath = this.buildClasspath(libraries, versionJson);
    const jvmArgs = this.buildJvmArgs(versionJson, nativesDir, classpath, customJvmArgs, memoryMin, memoryMax, javaPath);
    const gameArgs = this.buildGameArgs(versionJson, auth, customGameArgs, width, height);

    return {
      javaPath,
      jvmArgs,
      mainClass: versionJson.mainClass,
      gameArgs,
      classpath,
    };
  }

  private buildClasspath(libraries: ResolvedLibrary[], versionJson: VersionJson): string {
    const nonNative = libraries.filter((l) => !l.isNative && l.path.endsWith(".jar"));
    const paths = nonNative.map((l) => l.path);
    const seen = new Set(paths);
    const pushIfExists = (jarPath: string): void => {
      if (!fs.existsSync(jarPath) || seen.has(jarPath)) {
        return;
      }
      seen.add(jarPath);
      paths.push(jarPath);
    };

    const isNeoForge = (versionJson.family ?? "").startsWith("NeoForge-")
      || versionJson.arguments?.game?.some((arg) => typeof arg === "string" && arg === "--fml.neoForgeVersion");

    // NeoForge profiles already provide a patched client jar through downloads.client.
    // Adding the base vanilla jar can create duplicate module/package definitions on
    // older NeoForge versions (e.g. 1.21.5), so skip it for NeoForge profiles.
    if (!isNeoForge) {
      // Prefer an explicit version jar if present (e.g. OptiFine / patched profiles)
      if (versionJson.jar) {
        const explicitJar = path.join(this.gameDir, "versions", versionJson.id, `${versionJson.jar}.jar`);
        pushIfExists(explicitJar);
      }

      // Add version jar for modloaders with inheritsFrom
      if (versionJson.inheritsFrom) {
        const baseVersion = versionJson.inheritsFrom;
        const versionJar = path.join(this.gameDir, "versions", baseVersion, `${baseVersion}.jar`);
        pushIfExists(versionJar);
      }
      // Add version jar for standalone versions (vanilla or legacy modloaders)
      else {
        const versionJar = path.join(this.gameDir, "versions", versionJson.id, `${versionJson.id}.jar`);
        pushIfExists(versionJar);
      }
    }

    return paths.join(path.delimiter);
  }

  private buildJvmArgs(
    versionJson: VersionJson,
    nativesDir: string,
    classpath: string,
    customJvmArgs: string[],
    memoryMin?: string,
    memoryMax?: string,
    javaPath?: string,
  ): string[] {
    const javaVersion = this.detectJavaVersion(javaPath);
    const args = [
      ...this.getMemoryArgs(memoryMin, memoryMax),
      ...this.getPlatformJvmArgs(versionJson, javaVersion),
      "-Xss1M",
      `-Djava.library.path=${nativesDir}`,
      ...flattenVersionJsonArguments(versionJson.arguments?.jvm ?? [], undefined, this.osInfo),
    ];

    return this.filterJvmArgs(
      this.replaceJvmPlaceholders(args, versionJson, nativesDir, classpath),
      customJvmArgs,
      javaVersion,
    );
  }

  // JVM args that require specific Java versions
  private readonly JVM_ARGS_MIN_JAVA: Record<string, number> = {
    "--sun-misc-unsafe-memory-access": 23,
    "--enable-native-access": 22,
    "-XX:UseCompactObjectHeaders": 22,
    "-XX:+UseCompactObjectHeaders": 22,
    "-XX:-UseCompactObjectHeaders": 22,
    "--add-opens": 16,
    "--add-modules": 11,
    "--enable-preview": 12,
  };

  private filterJvmArgs(processedArgs: string[], customJvmArgs: string[], javaVersion: number): string[] {
    const filtered: string[] = [];
    let afterCp = false; // Track if we're past the -cp section

    for (let i = 0; i < processedArgs.length; i++) {
      const arg = processedArgs[i]!;
      const prevArg = i > 0 ? processedArgs[i - 1]! : "";

      // Skip duplicate -cp arguments (java-runner will add its own)
      if (arg === "-cp" || arg === "-classpath") {
        afterCp = true;
        continue;
      }
      // Skip the classpath value that follows -cp
      if (prevArg === "-cp" || prevArg === "-classpath") {
        continue;
      }
      // Skip classpath entries (paths starting with / or containing : and .jar)
      if (afterCp && (arg.startsWith("/") || arg.includes(".jar"))) {
        continue;
      }
      // If we hit a new - argument, we're past the classpath
      if (afterCp && arg.startsWith("-")) {
        afterCp = false;
      }

      // Check if this arg requires a newer Java version
      let skip = false;
      for (const [prefix, minJava] of Object.entries(this.JVM_ARGS_MIN_JAVA)) {
        if (arg.startsWith(prefix) && javaVersion < minJava) {
          skip = true;
          break;
        }
      }

      if (!skip) {
        filtered.push(arg);
      }
    }

    if (customJvmArgs.length > 0) {
      filtered.push(...customJvmArgs);
    }

    return filtered;
  }

  private detectJavaVersion(javaPath?: string): number {
    const key = javaPath ?? "default";
    const cached = this.javaVersionCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let version = 21;
    try {
      const java = javaPath ?? "java";
      const result = spawnSync(java, ["-version"], {
        encoding: "utf-8",
        shell: false,
      });
      const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
      const match = output.match(/version "(.*?)"/);
      if (match?.[1]) {
        const parts = match[1].split(".");
        const major = parseInt(parts[0] ?? "0", 10);
        if (major === 1) {
          version = parseInt(parts[1] ?? "0", 10);
        } else {
          version = major;
        }
      }
    } catch {
      version = 21;
    }

    this.javaVersionCache.set(key, version);
    return version;
  }

  private buildGameArgs(
    versionJson: VersionJson,
    auth: AuthSession,
    customGameArgs: string[],
    width?: number,
    height?: number,
  ): string[] {
    if (versionJson.minecraftArguments) {
      return tokenizeCommandLine(
        this.replaceGamePlaceholders(versionJson.minecraftArguments, versionJson, auth, width, height),
      );
    }

    const features: Record<string, boolean> = {
      is_demo_user: false,
      has_custom_resolution: !!(width && height),
      has_quick_plays_support: false,
      is_quick_play_singleplayer: false,
      is_quick_play_multiplayer: false,
      is_quick_play_realms: false,
    };
    const args = this.resolveArgumentValues(versionJson.arguments?.game ?? [], features)
      .map((arg) => this.replaceGamePlaceholders(arg, versionJson, auth, width, height));

    if (customGameArgs.length > 0) {
      args.push(...customGameArgs);
    }

    return args;
  }

  private shouldIncludeArg(
    argValue: VersionJsonArgumentValue,
    features?: Record<string, boolean>,
  ): boolean {
    if (!argValue.rules) return true;
    return checkRules(argValue.rules, this.osInfo, features);
  }

  private getMemoryArgs(memoryMin?: string, memoryMax?: string): string[] {
    return [
      `-Xmx${memoryMax ?? "2G"}`,
      `-Xms${memoryMin ?? "256M"}`,
    ];
  }

  private getPlatformJvmArgs(versionJson: VersionJson, javaVersion: number): string[] {
    const args: string[] = [];

    if (this.osInfo.os === "osx") {
      args.push("-XstartOnFirstThread");
    }
    if (this.osInfo.os === "windows") {
      args.push("-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump");
    }
    if (this.osInfo.os === "linux") {
      args.push(...LINUX_JVM_ARGS);
      if (!versionJson.minecraftArguments) {
        args.push(...LINUX_HEADLESS_JVM_ARGS);
      }
      if (!versionJson.minecraftArguments && javaVersion >= 17) {
        args.push(...MODERN_LINUX_OPEN_ARGS);
      }
    }

    return args;
  }

  private resolveArgumentValues(
    argDefs: (string | VersionJsonArgumentValue)[],
    features?: Record<string, boolean>,
  ): string[] {
    const args: string[] = [];

    for (const argDef of argDefs) {
      if (typeof argDef === "string") {
        args.push(argDef);
        continue;
      }
      if (!this.shouldIncludeArg(argDef, features)) {
        continue;
      }
      const values = Array.isArray(argDef.value) ? argDef.value : [argDef.value];
      args.push(...values);
    }

    return args;
  }

  private replaceJvmPlaceholders(
    args: string[],
    versionJson: VersionJson,
    nativesDir: string,
    classpath: string,
  ): string[] {
    const values = {
      natives_directory: nativesDir,
      library_directory: getLibraryDir(this.gameDir),
      launcher_name: this.launcherName,
      launcher_version: this.launcherVersion,
      path: path.join(this.gameDir, "logs", "latest.log"),
      version_name: versionJson.id,
      game_directory: this.gameDir,
      assets_root: path.join(this.gameDir, "assets"),
      classpath_separator: path.delimiter,
      classpath,
    };

    return args.map((arg) => this.replacePlaceholders(arg, values));
  }

  private replaceGamePlaceholders(
    arg: string,
    versionJson: VersionJson,
    auth: AuthSession,
    width?: number,
    height?: number,
  ): string {
    return this.replacePlaceholders(arg, {
      auth_player_name: auth.username,
      version_name: versionJson.id,
      game_directory: this.gameDir,
      assets_root: path.join(this.gameDir, "assets"),
      asset_index: versionJson.assetIndex?.id ?? "legacy",
      assets_index_name: versionJson.assetIndex?.id ?? "legacy",
      game_assets: versionJson.assetIndex?.id
        ? path.join(this.gameDir, "assets", "virtual", versionJson.assetIndex.id)
        : path.join(this.gameDir, "resources"),
      auth_uuid: auth.uuid,
      auth_access_token: auth.accessToken,
      clientid: "",
      auth_xuid: "",
      user_type: "mojang",
      version_type: versionJson.type,
      user_properties: "{}",
      tweak_class: "",
      resolution_width: String(width ?? 854),
      resolution_height: String(height ?? 480),
      quickPlayPath: "",
      quickPlaySingleplayer: "",
      quickPlayMultiplayer: "",
      quickPlayRealms: "",
    });
  }

  private replacePlaceholders(input: string, values: Record<string, string>): string {
    let result = input;
    for (const [key, value] of Object.entries(values)) {
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, "g"), value);
    }
    return result;
  }
}
