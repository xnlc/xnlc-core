import * as path from "path";
import * as fsSync from "fs";
import type { OSInfo, VersionJson } from "../types/index.js";
import { flattenVersionJsonArguments, getLaunchArgumentValues, tokenizeCommandLine, hasLaunchArgument, countLaunchArgument, getVersionDir } from "./index.js";

export function getRequiredJavaVersion(versionJson: VersionJson): number {
  const javaVersion = versionJson.javaVersion;
  if (javaVersion?.majorVersion) {
    return javaVersion.majorVersion;
  }

  if (versionJson.mainClass === "net.minecraft.launchwrapper.Launch") {
    return 8;
  }

  if (versionJson.mainClass === "net.minecraft.clientmain.Main" && versionJson.minecraftArguments) {
    return 8;
  }

  const baseVersion = versionJson.inheritsFrom ?? versionJson.id ?? "";
  const parts = baseVersion.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;

  if (major < 1 || (major === 1 && minor <= 12)) {
    return 8;
  }

  return 21;
}

export function shouldRepairOptifineProfile(versionJson: VersionJson, osInfo: OSInfo): boolean {
  const gameArgs = flattenVersionJsonArguments(versionJson.arguments?.game ?? [], undefined, osInfo);
  const tweakValues = getLaunchArgumentValues(gameArgs, "--tweakClass");
  const hasTweaker = tweakValues.includes("optifine.OptiFineTweaker")
    || (versionJson.minecraftArguments ?? "").includes("optifine.OptiFineTweaker");
  const hasLaunchwrapper = versionJson.libraries.some((lib) =>
    lib.name.startsWith("optifine:launchwrapper:") || lib.name === "net.minecraft:launchwrapper:1.12",
  );

  return versionJson.mainClass !== "net.minecraft.launchwrapper.Launch"
    || !hasTweaker
    || (versionJson.arguments !== undefined && hasLaunchArgument(gameArgs, "--gameDir"))
    || countLaunchArgument(gameArgs, "--gameDir") > 1
    || !hasLaunchwrapper;
}
