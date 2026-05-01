export const URLS = {
  official: {
    mojang: {
      meta: "https://launchermeta.mojang.com",
      launcher: "https://launcher.mojang.com",
      versionManifest: "https://launchermeta.mojang.com/mc/game/version_manifest.json",
      versionManifestV2: "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
      libraries: "https://libraries.minecraft.net",
      assets: "https://resources.download.minecraft.net",
    },
    forge: {
      files: "https://files.minecraftforge.net",
      maven: "https://maven.minecraftforge.net",
    },
    fabric: {
      meta: "https://meta.fabricmc.net",
      metaV2: "https://meta.fabricmc.net/v2",
      maven: "https://maven.fabricmc.net",
    },
    neoforge: {
      host: "https://maven.neoforged.net",
      maven: "https://maven.neoforged.net/releases",
      mirror: "https://mirrors.neoforged.net",
    },
    quilt: {
      meta: "https://meta.quiltmc.org",
      metaV3: "https://meta.quiltmc.org/v3",
      mavenRelease: "https://maven.quiltmc.org/repository/release",
      mavenHost: "https://maven.quiltmc.org",
    },
    optifine: {
      root: "https://optifine.net",
      downloads: "https://optifine.net/downloads",
    },
    authlibInjector: {
      root: "https://authlib-injector.yushi.moe",
    },
    azul: {
      metadataApi: "https://api.azul.com/metadata/v1/zulu/packages",
    },
    mavenCentral: "https://repo1.maven.org/maven2",
    mavenCentralApache: "https://repo.maven.apache.org/maven2",
    sourceForgeLzma: "https://sourceforge.net/projects/kcauldron/files/lzma/lzma/0.0.1/lzma-0.0.1.jar/download",
    mcArchiveForgeHelp: "https://mcarchive.net/mods/minecraftforge?gvsn=1.7.10",
  },
} as const;

