// ============================================================
// XNLC — Meta Client
// Fetches version data from Mojang API
// Author: MAINER4IK
// ============================================================

import { MojangVersionManifest, MojangVersionEntry, VersionJson } from "../types/index.js";
import { URLS } from "../constants/urls.js";

declare const fetch: typeof globalThis.fetch;

const VERSION_MANIFEST_V2_URL = URLS.official.mojang.versionManifestV2;

export class MetaClient {
  private cache: Map<string, VersionJson> = new Map();
  private manifestCache: MojangVersionManifest | null = null;

  constructor() {}

  async fetchManifest(): Promise<MojangVersionManifest> {
    if (this.manifestCache) return this.manifestCache;

    const res = await fetch(VERSION_MANIFEST_V2_URL);
    if (!res.ok) {
      throw new Error(`Failed to fetch version manifest: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as MojangVersionManifest;
    this.manifestCache = data;
    return data;
  }

  async getVersionEntry(versionId: string): Promise<MojangVersionEntry | undefined> {
    const manifest = await this.fetchManifest();
    return manifest.versions.find((v) => v.id === versionId);
  }

  async fetchVersionJson(versionId: string): Promise<VersionJson> {
    if (this.cache.has(versionId)) {
      return this.cache.get(versionId)!;
    }

    const entry = await this.getVersionEntry(versionId);
    if (!entry) {
      throw new Error(`Version "${versionId}" not found in manifest`);
    }

    const res = await fetch(entry.url);
    if (!res.ok) {
      throw new Error(`Failed to fetch version JSON for "${versionId}": ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as VersionJson;
    this.cache.set(versionId, data);
    return data;
  }

  async getLatestRelease(): Promise<string> {
    const manifest = await this.fetchManifest();
    return manifest.latest.release;
  }

  async getLatestSnapshot(): Promise<string> {
    const manifest = await this.fetchManifest();
    return manifest.latest.snapshot;
  }

  async getVersionsByType(type: string): Promise<MojangVersionEntry[]> {
    const manifest = await this.fetchManifest();
    return manifest.versions.filter((v) => v.type === type);
  }

  async getAllVersions(): Promise<MojangVersionEntry[]> {
    const manifest = await this.fetchManifest();
    return manifest.versions;
  }

  clearCache(): void {
    this.cache.clear();
    this.manifestCache = null;
  }
}
