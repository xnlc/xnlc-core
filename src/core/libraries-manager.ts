// ============================================================
// XNLC — Libraries Manager
// Resolves and downloads all required libraries
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { VersionJson, VersionJsonLibrary, ResolvedLibrary, OSInfo, DownloadProgressCallback } from "../types/index.js";
import { Downloader } from "./downloader.js";
import { libraryNameToPath, checkRules, getNativesClassifier, getLibraryDir } from "../utils/index.js";
import { URLS } from "../constants/urls.js";

export class LibrariesManager {
  constructor(
    private downloader: Downloader,
    private gameDir: string,
    private osInfo: OSInfo,
  ) {}

  getOsInfo(): OSInfo {
    return this.osInfo;
  }

  countTotalFiles(versionJson: VersionJson): number {
    const libraries = this.resolveLibraries(versionJson);
    let count = 0;
    const seenPaths = new Set<string>();

    for (const lib of libraries) {
      const hasArtifact = !!lib.downloads?.artifact?.url;
      const hasNatives = lib.natives && Object.keys(lib.natives).length > 0;
      const natives = lib.natives ?? {};
      const classifier = hasNatives ? (natives[getNativesClassifier(this.osInfo)] ?? natives[this.osInfo.os]) : null;
      const hasClassifier = classifier && lib.downloads?.classifiers?.[classifier];

      if (hasClassifier) {
        const classifierPath = lib.downloads?.classifiers?.[classifier]?.path ?? libraryNameToPath(lib.name);
        const classifierDest = path.join(getLibraryDir(this.gameDir), classifierPath);
        if (!seenPaths.has(classifierDest)) {
          seenPaths.add(classifierDest);
          if (!fs.existsSync(classifierDest)) count++;
        }
      }

      if (hasArtifact) {
        const libPath = this.getLibraryPath(lib);
        const dest = path.join(getLibraryDir(this.gameDir), libPath);
        if (!seenPaths.has(dest)) {
          seenPaths.add(dest);
          if (!fs.existsSync(dest)) count++;
        }
      }
    }

    return count;
  }

  countTotalSize(versionJson: VersionJson): number {
    const libraries = this.resolveLibraries(versionJson);
    let totalSize = 0;
    const seenPaths = new Set<string>();

    for (const lib of libraries) {
      const hasArtifact = !!lib.downloads?.artifact?.url;
      const hasNatives = lib.natives && Object.keys(lib.natives).length > 0;
      const natives = lib.natives ?? {};
      const classifier = hasNatives ? (natives[getNativesClassifier(this.osInfo)] ?? natives[this.osInfo.os]) : null;
      const hasClassifier = classifier && lib.downloads?.classifiers?.[classifier];
      if (hasClassifier) {
        const classifierPath = lib.downloads?.classifiers?.[classifier]?.path ?? libraryNameToPath(lib.name);
        const classifierDest = path.join(getLibraryDir(this.gameDir), classifierPath);
        if (!seenPaths.has(classifierDest) && !fs.existsSync(classifierDest)) {
          seenPaths.add(classifierDest);
          totalSize += lib.downloads?.classifiers?.[classifier]?.size ?? 0;
        }
      }

      if (hasArtifact) {
        const libPath = this.getLibraryPath(lib);
        const dest = path.join(getLibraryDir(this.gameDir), libPath);
        if (!seenPaths.has(dest) && !fs.existsSync(dest)) {
          seenPaths.add(dest);
          totalSize += lib.downloads?.artifact?.size ?? 0;
        }
      }
    }

    return totalSize;
  }

  async resolveAndDownload(
    versionJson: VersionJson,
    onProgress?: DownloadProgressCallback,
  ): Promise<ResolvedLibrary[]> {
    const libraries = this.resolveLibraries(versionJson);
    const resolved: ResolvedLibrary[] = [];
    const seenPaths = new Set<string>();

    for (const lib of libraries) {
      let url = lib.downloads?.artifact?.url;
      let sha1 = lib.downloads?.artifact?.sha1;
      let size = lib.downloads?.artifact?.size ?? 0;

      if (lib.downloads?.classifiers && lib.natives) {
        const classifier = lib.natives[getNativesClassifier(this.osInfo)] ?? lib.natives[this.osInfo.os];
        if (classifier) {
          const classifierEntry = lib.downloads.classifiers[classifier];
          if (classifierEntry) {
            const classifierPath = classifierEntry.path ?? libraryNameToPath(lib.name);
            const classifierDest = path.join(getLibraryDir(this.gameDir), classifierPath);

            if (!seenPaths.has(classifierDest)) {
              seenPaths.add(classifierDest);

              if (!fs.existsSync(classifierDest)) {
                await this.downloader.download({
                  url: classifierEntry.url,
                  dest: classifierDest,
                  sha1: classifierEntry.sha1,
                  size: classifierEntry.size,
                  onProgress,
                });
              }

              resolved.push({
                name: lib.name,
                path: classifierDest,
                url: classifierEntry.url,
                sha1: classifierEntry.sha1 ?? "",
                size: classifierEntry.size ?? 0,
                natives: lib.natives,
                isNative: true,
                classifier,
              });
            }
          }
        }
      }

      const libPath = this.getLibraryPath(lib);
      const dest = path.join(getLibraryDir(this.gameDir), libPath);

      if (seenPaths.has(dest)) {
        continue;
      }
      seenPaths.add(dest);

      if (url?.startsWith("/libraries/")) {
        const localPath = path.join(this.gameDir, url.slice(1));
        if (fs.existsSync(localPath)) {
          resolved.push({
            name: lib.name,
            path: localPath,
            url,
            sha1: sha1 ?? "",
            size,
            natives: lib.natives,
            isNative: this.isNativeLibrary(lib),
            classifier: this.getClassifier(lib),
          });
        }
        continue;
      }

      // Skip native-only libraries that have classifiers but no artifact and no matching artifact
      // (e.g. lwjgl-platform has only natives in classifiers, no base artifact)
      if (!url && lib.downloads?.classifiers && !lib.downloads?.artifact) {
        continue;
      }

      // Empty URL means this is a generated artifact (e.g. Forge client jar)
      // Skip it — it's not downloadable.
      if (url === "") {
        if (fs.existsSync(dest)) {
          resolved.push({
            name: lib.name,
            path: dest,
            url: "",
            sha1: sha1 ?? "",
            size,
            natives: lib.natives,
            isNative: this.isNativeLibrary(lib),
            classifier: this.getClassifier(lib),
          });
        }
        continue;
      }

      if (!url) {
        // Handle libraries with top-level url field (e.g. Fabric profile)
        if (lib.url) {
          const mavenPath = libraryNameToPath(lib.name);
          url = `${lib.url.replace(/\/$/, "")}/${mavenPath}`;
          sha1 = lib.sha1 ?? sha1;
          size = lib.size ?? size;
        } else {
          // Try to construct URL from library name
          const mavenPath = libraryNameToPath(lib.name);
          // Forge libraries are hosted on maven.minecraftforge.net
          if (lib.name.startsWith("net.minecraftforge:")) {
            url = `${URLS.official.forge.maven}/${mavenPath}`;
          } else if (lib.name.startsWith("net.neoforged:") || lib.name.startsWith("net.neoforged.")) {
            url = `${URLS.official.neoforge.maven}/${mavenPath}`;
          } else if (lib.name.startsWith("net.fabricmc:") || lib.name.startsWith("net.fabricmc.intermediary:")) {
            // Fabric libraries
            url = `${URLS.official.fabric.maven}/${mavenPath}`;
          } else if (lib.name.startsWith("net.minecraft:") || lib.name.startsWith("com.mojang:")) {
            url = `${URLS.official.mojang.libraries}/${mavenPath}`;
          } else {
            // Everything else from Maven Central
            url = `${URLS.official.mavenCentral}/${mavenPath}`;
          }
        }
      }

      // Skip libraries with no valid URL
      if (!url) {
        continue;
      }

      await this.downloader.download({
        url,
        dest,
        sha1,
        size,
        onProgress,
      });

      resolved.push({
        name: lib.name,
        path: dest,
        url,
        sha1: sha1 ?? "",
        size,
        natives: lib.natives,
        isNative: this.isNativeLibrary(lib),
        classifier: this.getClassifier(lib),
      });
    }

    return resolved;
  }

  resolveLibraries(versionJson: VersionJson): VersionJsonLibrary[] {
    return versionJson.libraries.filter((lib) => {
      if (!lib.rules) return true;
      return checkRules(lib.rules, this.osInfo);
    });
  }

  getLibraryPath(lib: VersionJsonLibrary): string {
    if (lib.downloads?.artifact?.path) {
      return lib.downloads.artifact.path;
    }
    return libraryNameToPath(lib.name);
  }

  isNativeLibrary(lib: VersionJsonLibrary): boolean {
    // A library is only treated as native when the resolved entry is a native
    // classifier jar or a native-only library without a regular artifact.
    // Libraries like com.mojang:text2speech have a base artifact plus natives,
    // and the base artifact must remain on the runtime classpath.
    if (lib.name.includes("natives-")) {
      return true;
    }

    if (lib.downloads?.classifiers && lib.natives && !lib.downloads?.artifact) {
      return true;
    }

    return false;
  }

  getClassifier(lib: VersionJsonLibrary): string | undefined {
    const parts = lib.name.split(":");
    if (parts.length >= 4) {
      return parts[3];
    }
    return undefined;
  }

  getNativesLibraries(versionJson: VersionJson): VersionJsonLibrary[] {
    return this.resolveLibraries(versionJson).filter((lib) => {
      if (lib.natives) {
        // Try the full classifier first (e.g. "linux-x86_64"), then fall back to simple OS name (e.g. "linux")
        const classifier = lib.natives[getNativesClassifier(this.osInfo)] ?? lib.natives[this.osInfo.os];
        return !!classifier;
      }
      return this.isNativeLibrary(lib);
    });
  }

  getNonNativeLibraries(versionJson: VersionJson): VersionJsonLibrary[] {
    return this.resolveLibraries(versionJson).filter((lib) => {
      if (lib.natives) {
        const classifier = lib.natives[getNativesClassifier(this.osInfo)] ?? lib.natives[this.osInfo.os];
        return !classifier;
      }
      return !this.isNativeLibrary(lib);
    });
  }

  buildClasspath(libraries: ResolvedLibrary[]): string {
    const nonNative = libraries.filter((l) => !l.isNative);
    return nonNative.map((l) => l.path).join(path.delimiter);
  }
}
