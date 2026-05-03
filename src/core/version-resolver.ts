// ============================================================
// XNLC — Version Resolver
// Resolves version inheritance and builds complete version data
// Author: MAINER4IK
// ============================================================

import { VersionJson, VersionJsonLibrary, VersionJsonRule } from "../types/index.js";
import { MetaClient } from "./meta-client.js";
import { checkRules } from "../utils/index.js";
import { OSInfo } from "../types/index.js";

export class VersionResolver {
  constructor(private metaClient: MetaClient) {}

  async resolveVersion(versionId: string, osInfo: OSInfo): Promise<VersionJson> {
    const versionJson = await this.metaClient.fetchVersionJson(versionId);
    return this.resolveInheritance(versionJson, osInfo);
  }

  async resolveVersionFromJson(versionJson: VersionJson, osInfo: OSInfo): Promise<VersionJson> {
    return this.resolveInheritance(versionJson, osInfo);
  }

  private async resolveInheritance(versionJson: VersionJson, osInfo: OSInfo): Promise<VersionJson> {
    if (!versionJson.inheritsFrom) {
      return versionJson;
    }

    const parentJson = await this.metaClient.fetchVersionJson(versionJson.inheritsFrom);
    const resolved = await this.resolveInheritance(parentJson, osInfo);

    // Merge libraries (child overrides parent)
    const mergedLibraries = this.mergeLibraries(resolved.libraries, versionJson.libraries, osInfo);

    // Merge arguments
    let mergedArgs: VersionJson["arguments"];
    if (versionJson.arguments) {
      mergedArgs = this.mergeArguments(resolved.arguments, versionJson.arguments);
    } else {
      mergedArgs = resolved.arguments;
    }

    return {
      ...resolved,
      ...versionJson,
      libraries: mergedLibraries,
      arguments: mergedArgs,
      // Keep inheritsFrom so LaunchBuilder can detect legacy/modloader profiles
      // and add the base version jar to classpath
    };
  }

  private mergeLibraries(
    parent: VersionJsonLibrary[],
    child: VersionJsonLibrary[],
    _osInfo: OSInfo,
  ): VersionJsonLibrary[] {
    const map = new Map<string, VersionJsonLibrary>();

    const libraryKey = (lib: VersionJsonLibrary): string => {
      const normalized = lib.name.replace(/@jar$/, "");
      const nativeKey = lib.natives ? JSON.stringify(lib.natives) : "";
      const classifierKey = lib.downloads?.classifiers
        ? Object.keys(lib.downloads.classifiers).sort().join(",")
        : "";
      const extractKey = lib.extract?.exclude?.join(",") ?? "";
      const downloadOnlyKey = lib.downloadOnly ? "downloadOnly" : "";
      return [normalized, nativeKey, classifierKey, extractKey, downloadOnlyKey].join("|");
    };

    // Add child libraries first (they should take priority in classpath order)
    for (const lib of child) {
      map.set(libraryKey(lib), lib);
    }

    // Then add parent libraries (only if not already present)
    for (const lib of parent) {
      const key = libraryKey(lib);
      if (!map.has(key)) {
        map.set(key, lib);
      }
    }

    return Array.from(map.values());
  }

  private mergeArguments(
    parent: VersionJson["arguments"] | undefined,
    child: VersionJson["arguments"] | undefined,
  ): VersionJson["arguments"] {
    if (!parent) return child ?? {};

    return {
      jvm: [...(parent.jvm ?? []), ...(child?.jvm ?? [])],
      game: [...(parent.game ?? []), ...(child?.game ?? [])],
    };
  }

  filterLibrariesForOS(libraries: VersionJsonLibrary[], osInfo: OSInfo): VersionJsonLibrary[] {
    return libraries.filter((lib) => {
      if (!lib.rules) return true;
      return checkRules(lib.rules as VersionJsonRule[], osInfo);
    });
  }
}
