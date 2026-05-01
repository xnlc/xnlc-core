// ============================================================
// XNLC — Natives Extractor
// Extracts native libraries for the current platform
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import * as fs from "fs";
import AdmZip from "adm-zip";
import { VersionJson, VersionJsonLibrary } from "../types/index.js";
import { LibrariesManager } from "./libraries-manager.js";
import { getNativesDir, getNativesClassifier, getNativesClassifierOld } from "../utils/index.js";

export class NativesExtractor {
  constructor(
    private librariesManager: LibrariesManager,
  ) {}

  async extractNatives(versionJson: VersionJson, gameDir: string): Promise<string> {
    const nativesDir = getNativesDir(gameDir);

    // Clean natives directory
    if (fs.existsSync(nativesDir)) {
      fs.rmSync(nativesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(nativesDir, { recursive: true });

    const nativesLibs = this.librariesManager.getNativesLibraries(versionJson);

    for (const lib of nativesLibs) {
      const jarPath = this.findNativeJarPath(lib, gameDir);
      if (!jarPath) continue;

      if (!fs.existsSync(jarPath)) continue;

      try {
        const zip = new AdmZip(jarPath);
        const entries = zip.getEntries();

        for (const entry of entries) {
          const entryName = entry.entryName;
          if (entryName.endsWith("/") || entryName.startsWith("META-INF/")) continue;
          if (!entryName.endsWith(".so") && !entryName.endsWith(".dll") && !entryName.endsWith(".dylib") && !entryName.endsWith(".jnilib")) {
            continue;
          }

          zip.extractEntryTo(entryName, nativesDir, false, true, false, path.basename(entryName));
        }
      } catch {
        // Some native jars may not contain extractable natives
        continue;
      }
    }

    return nativesDir;
  }

  /**
   * Find the path to the native jar for the current OS.
   * Handles both artifact-based and classifier-based libraries.
   * Prefers classifiers natives jar over artifact when available.
   */
  private findNativeJarPath(lib: VersionJsonLibrary, gameDir: string): string | null {
    const osInfo = this.librariesManager.getOsInfo();

    if (lib.downloads?.classifiers && lib.natives) {
      const modernClassifier = getNativesClassifier(osInfo);
      const oldClassifier = getNativesClassifierOld(osInfo);
      
      const nativeKeys = [lib.natives[modernClassifier], lib.natives[oldClassifier], lib.natives[osInfo.os]].filter(Boolean);
      
      for (const classifier of nativeKeys) {
        if (classifier && lib.downloads.classifiers[classifier]) {
          const classifierEntry = lib.downloads.classifiers[classifier]!;
          
          // Try path first, then construct from library name
          let jarPath: string | null = null;
          if (classifierEntry.path) {
            jarPath = path.join(gameDir, "libraries", classifierEntry.path);
          } else {
            // Construct path from library name (old format with classifiers but no path)
            const libPath = this.librariesManager.getLibraryPath(lib);
            // Replace version suffix with -natives-{os}
            const basePath = libPath.replace(/\.jar$/, "");
            jarPath = path.join(gameDir, "libraries", `${basePath}-${classifier}.jar`);
          }
          
          if (fs.existsSync(jarPath)) {
            return jarPath;
          }
        }
      }
    }

    if (lib.downloads?.artifact?.url) {
      const libPath = this.librariesManager.getLibraryPath(lib);
      return path.join(gameDir, "libraries", libPath);
    }

    return null;
  }

  getNativesDir(gameDir: string): string {
    return getNativesDir(gameDir);
  }
}
