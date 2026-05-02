// ============================================================
// XNLC — Java Manager
// Detects, downloads, and manages Java runtimes
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import { Downloader } from "./downloader.js";
import { URLS } from "../constants/urls.js";

const AZUL_API = URLS.official.azul.metadataApi;

export interface JavaRuntime {
  path: string;
  version: number;
  vendor: string;
}

export class JavaManager {
  constructor(
    private downloader: Downloader,
    private gameDir: string,
  ) {}

  /**
   * Detect the Java version of a given java binary.
   * Returns the major version number (e.g. 21, 25).
   */
  detectJavaVersion(javaPath: string = "java"): number {
    try {
      const result = spawnSync(javaPath, ["-version"], {
        encoding: "utf-8",
        shell: false,
      });
      const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
      const match = output.match(/version "(.*?)"/);
      if (match) {
        const parts = match[1]!.split(".");
        const major = parseInt(parts[0]!, 10);
        // Handle "1.x" format (Java 8 and earlier)
        if (major === 1) {
          return parseInt(parts[1]!, 10);
        }
        return major;
      }
    } catch {
      // Java not found
    }
    return 0;
  }

  /**
   * Find a suitable Java runtime for the required version.
   * Checks:
   * 1. User-provided javaPath
   * 2. System PATH java
   * 3. Previously downloaded runtime in gameDir
   * 4. Downloads from Azul Zulu if needed
   */
  async findOrDownloadJava(
    requiredVersion: number,
    userJavaPath?: string,
    onProgress?: (pct: number) => void,
  ): Promise<JavaRuntime> {
    // 1. Check user-provided path
    if (userJavaPath) {
      const version = this.detectJavaVersion(userJavaPath);
      if (this.isJavaCompatible(version, requiredVersion)) {
        return { path: userJavaPath, version, vendor: "user" };
      }
    }

    // 2. Check system PATH
    const systemVersion = this.detectJavaVersion("java");
    if (this.isJavaCompatible(systemVersion, requiredVersion)) {
      return { path: "java", version: systemVersion, vendor: "system" };
    }

    // 3. Check previously downloaded runtime
    const downloadedRuntime = this.getDownloadedRuntime(requiredVersion);
    if (downloadedRuntime) {
      return downloadedRuntime;
    }

    // 4. Download from Azul Zulu
    return this.downloadJava(requiredVersion, onProgress);
  }

  /**
   * Check if a Java version is compatible with the required version.
   * For Java 8 requirement, only Java 8 is compatible (launchwrapper breaks on 9+).
   * For Java 17+ requirement, any version >= required is fine.
   */
  private isJavaCompatible(actualVersion: number, requiredVersion: number): boolean {
    // Java 8 is a special case — legacy Minecraft (1.12.2 and below) requires exactly Java 8
    // because launchwrapper and other legacy libraries are incompatible with Java 9+
    if (requiredVersion === 8) {
      return actualVersion === 8;
    }
    // For modern Java, any version >= required works
    return actualVersion >= requiredVersion;
  }

  /**
   * Check if a previously downloaded runtime exists in the game directory.
   */
  private getDownloadedRuntime(requiredVersion: number): JavaRuntime | null {
    const runtimesDir = path.join(this.gameDir, "runtimes");
    if (!fs.existsSync(runtimesDir)) return null;

    const entries = fs.readdirSync(runtimesDir);
    for (const entry of entries) {
      if (entry.startsWith(`java-${requiredVersion}`)) {
        const javaPath = this.findJavaBinary(path.join(runtimesDir, entry));
        if (javaPath) {
          const version = this.detectJavaVersion(javaPath);
          return { path: javaPath, version, vendor: "downloaded" };
        }
      }
    }
    return null;
  }

  /**
   * Download Java from Azul Zulu.
   */
  private async downloadJava(
    version: number,
    onProgress?: (pct: number) => void,
  ): Promise<JavaRuntime> {
    const osInfo = this.getPlatformInfo();
    const downloadUrl = await this.getAzulDownloadUrl(version, osInfo);

    if (!downloadUrl) {
      throw new Error(
        `Could not find Java ${version} for ${osInfo.os}-${osInfo.arch}. ` +
        `Please install Java ${version}+ manually and set --java-path.`,
      );
    }

    const runtimesDir = path.join(this.gameDir, "runtimes");
    const extractDir = path.join(runtimesDir, `java-${version}`);

    // Download
    const fileName = path.basename(new URL(downloadUrl).pathname);
    const archivePath = path.join(runtimesDir, fileName);

    fs.mkdirSync(runtimesDir, { recursive: true });

    console.log(`Downloading Java ${version} from Azul Zulu...`);
    await this.downloader.download({
      url: downloadUrl,
      dest: archivePath,
      onProgress: onProgress
        ? (p) => onProgress(p.percent ?? 0)
        : undefined,
    });

    // Extract
    console.log(`Extracting Java ${version}...`);
    await this.extractArchive(archivePath, extractDir);

    // Clean up archive
    fs.unlinkSync(archivePath);

    // Find java binary
    const javaPath = this.findJavaBinary(extractDir);
    if (!javaPath) {
      throw new Error(`Could not find java binary in extracted runtime`);
    }

    // Make executable on Unix
    if (os.platform() !== "win32") {
      fs.chmodSync(javaPath, 0o755);
    }

    const detectedVersion = this.detectJavaVersion(javaPath);
    return { path: javaPath, version: detectedVersion, vendor: "azul" };
  }

  /**
   * Get the Azul Zulu download URL for a specific Java version and platform.
   */
  private async getAzulDownloadUrl(
    version: number,
    platform: { os: string; arch: string },
  ): Promise<string | null> {
    try {
      const expectedExt = platform.os === "windows" ? ".zip" : ".tar.gz";
      const query = new URLSearchParams({
        java_version: String(version),
        os: platform.os,
        arch: platform.arch,
        bundle_type: "jdk",
        ext: expectedExt.slice(1),
        latest: "true",
      });

      const url = `${AZUL_API}/?${query.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const data = await res.json() as Array<Record<string, unknown>>;
      if (!Array.isArray(data) || data.length === 0) return null;

      const preferred = data.find((asset) => {
        const downloadUrl = asset?.["download_url"];
        return typeof downloadUrl === "string" && downloadUrl.endsWith(expectedExt);
      });

      const fallback = data.find((asset) => {
        const downloadUrl = asset?.["download_url"];
        return typeof downloadUrl === "string" && (downloadUrl.endsWith(".zip") || downloadUrl.endsWith(".tar.gz") || downloadUrl.endsWith(".tgz"));
      });

      return (preferred?.["download_url"] as string)
        ?? (fallback?.["download_url"] as string)
        ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Extract a tar.gz or zip archive.
   */
  private async extractArchive(archivePath: string, destDir: string): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });

    if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
      const result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir, "--strip-components=1"], {
        stdio: "inherit",
        shell: false,
      });
      if (result.status !== 0) {
        throw new Error(`Failed to extract archive: ${archivePath}`);
      }
    } else if (archivePath.endsWith(".zip")) {
      const AdmZip = (await import("adm-zip/adm-zip.js")).default;
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(destDir, true);
      // Handle nested directory (Zulu archives often have a top-level dir)
      const entries = fs.readdirSync(destDir);
      if (entries.length === 1 && fs.statSync(path.join(destDir, entries[0]!)).isDirectory()) {
        const nestedDir = path.join(destDir, entries[0]!);
        const nestedEntries = fs.readdirSync(nestedDir);
        for (const entry of nestedEntries) {
          fs.renameSync(path.join(nestedDir, entry), path.join(destDir, entry));
        }
        fs.rmdirSync(nestedDir);
      }
    } else {
      throw new Error(`Unsupported archive format: ${archivePath}`);
    }
  }

  /**
   * Find the java binary in an extracted JDK directory.
   */
  private findJavaBinary(rootDir: string): string | null {
    const isWin = os.platform() === "win32";
    const javaName = isWin ? "java.exe" : "java";

    // Standard JDK layout: bin/java
    const standardPath = path.join(rootDir, "bin", javaName);
    if (fs.existsSync(standardPath)) return standardPath;

    // Try to find recursively
    try {
      const entries = fs.readdirSync(rootDir);
      for (const entry of entries) {
        const fullPath = path.join(rootDir, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          const binPath = path.join(fullPath, "bin", javaName);
          if (fs.existsSync(binPath)) return binPath;
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * Get platform info for Azul Zulu API.
   */
  private getPlatformInfo(): { os: string; arch: string } {
    const platform = os.platform();
    const arch = os.arch();

    let osName: string;
    if (platform === "linux") osName = "linux";
    else if (platform === "darwin") osName = "mac";
    else if (platform === "win32") osName = "windows";
    else {
      console.warn(`Unknown platform: ${platform}, defaulting to linux`);
      osName = "linux";
    }

    let archName: string;
    if (arch === "x64") archName = "x86_64";
    else if (arch === "arm64" || arch === "aarch64") archName = "aarch64";
    else if (arch === "arm") archName = "arm";
    else {
      console.warn(`Unknown architecture: ${arch}, defaulting to x86_64`);
      archName = "x86_64";
    }

    return { os: osName, arch: archName };
  }
}
