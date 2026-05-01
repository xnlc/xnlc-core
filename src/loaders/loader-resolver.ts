// ============================================================
// XNLC — Loader Resolver
// Determines which loader handler to use based on version
// Author: MAINER4IK
// ============================================================

import * as path from "path";
import { LoaderType, DownloadProgressCallback, LoaderInstallResult } from "../types/index.js";
import { ForgeHandler } from "./forge-handler.js";
import { ForgeLegacyHandler } from "./forge-legacy-handler.js";
import { NeoForgeHandler } from "./neoforge-handler.js";
import { FabricHandler } from "./fabric-handler.js";
import { FabricLegacyHandler } from "./fabric-legacy-handler.js";
import { QuiltHandler } from "./quilt-handler.js";
import { OptifineHandler } from "./optifine-handler.js";
import { CustomVersionHandler } from "./custom-version-handler.js";
import { Downloader } from "../core/downloader.js";
import { MetaClient } from "../core/meta-client.js";
import { isLegacyForge, isLegacyFabric } from "../utils/index.js";

type ResolvedLoaderType = Exclude<LoaderType, "vanilla">;

export class LoaderResolver {
  private forgeHandler: ForgeHandler;
  private forgeLegacyHandler: ForgeLegacyHandler;
  private neoforgeHandler: NeoForgeHandler;
  private fabricHandler: FabricHandler;
  private fabricLegacyHandler: FabricLegacyHandler;
  private quiltHandler: QuiltHandler;
  private optifineHandler: OptifineHandler;
  private customVersionHandler: CustomVersionHandler;

  constructor(
    downloader: Downloader,
    metaClient: MetaClient,
    gameDir: string,
    customVersionsDir?: string,
  ) {
    this.forgeHandler = new ForgeHandler(downloader, metaClient, gameDir);
    this.forgeLegacyHandler = new ForgeLegacyHandler(downloader, metaClient, gameDir);
    this.neoforgeHandler = new NeoForgeHandler(downloader, metaClient, gameDir);
    this.fabricHandler = new FabricHandler(downloader, gameDir);
    this.fabricLegacyHandler = new FabricLegacyHandler(downloader, gameDir);
    this.quiltHandler = new QuiltHandler(downloader, gameDir);
    this.optifineHandler = new OptifineHandler(downloader, metaClient, gameDir);
    this.customVersionHandler = new CustomVersionHandler(customVersionsDir || path.join(process.env.HOME || "", ".xnlc", "versions"));
  }

  getForgeHandler(): ForgeHandler {
    return this.forgeHandler;
  }

  getForgeLegacyHandler(): ForgeLegacyHandler {
    return this.forgeLegacyHandler;
  }

  getNeoForgeHandler(): NeoForgeHandler {
    return this.neoforgeHandler;
  }

  getFabricHandler(): FabricHandler {
    return this.fabricHandler;
  }

  getFabricLegacyHandler(): FabricLegacyHandler {
    return this.fabricLegacyHandler;
  }

  getQuiltHandler(): QuiltHandler {
    return this.quiltHandler;
  }

  getOptifineHandler(): OptifineHandler {
    return this.optifineHandler;
  }

  getCustomVersionHandler(): CustomVersionHandler {
    return this.customVersionHandler;
  }

  getHandler(loaderType: ResolvedLoaderType):
    | ForgeHandler
    | ForgeLegacyHandler
    | NeoForgeHandler
    | FabricHandler
    | FabricLegacyHandler
    | QuiltHandler
    | OptifineHandler
    | CustomVersionHandler {
    switch (loaderType) {
      case "forge":
        return this.forgeHandler;
      case "forge-legacy":
        return this.forgeLegacyHandler;
      case "neoforge":
        return this.neoforgeHandler;
      case "fabric":
        return this.fabricHandler;
      case "fabric-legacy":
        return this.fabricLegacyHandler;
      case "quilt":
        return this.quiltHandler;
      case "optifine":
        return this.optifineHandler;
      case "custom":
        return this.customVersionHandler;
    }
  }

  async installLoader(
    mcVersion: string,
    loaderType: LoaderType,
    loaderVersion: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<LoaderInstallResult> {
    if (loaderType === "vanilla") {
      throw new Error("Vanilla does not require loader installation");
    }
    if (loaderType === "custom") {
      return this.customVersionHandler.install(loaderVersion, mcVersion, onProgress);
    }
    return this.getHandler(loaderType).install(mcVersion, loaderVersion, onProgress);
  }

  determineLoaderType(mcVersion: string, loaderType: LoaderType, loaderVersion: string): LoaderType {
    if (loaderType === "forge") {
      return isLegacyForge(mcVersion, loaderVersion) ? "forge-legacy" : "forge";
    }
    if (loaderType === "fabric") {
      return isLegacyFabric(loaderVersion) ? "fabric-legacy" : "fabric";
    }
    return loaderType;
  }

  isLegacyForge(mcVersion: string): boolean {
    return isLegacyForge(mcVersion, "");
  }

  isLegacyFabric(loaderVersion: string): boolean {
    return isLegacyFabric(loaderVersion);
  }
}
