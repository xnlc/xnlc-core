// ============================================================
// XNLC — Java Runner
// Launches Minecraft with the built command
// Author: MAINER4IK
// ============================================================

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { LaunchCommand } from "./launch-builder.js";
import { LaunchResult } from "../types/index.js";
import { getLogsDir } from "../utils/index.js";

export class JavaRunner {
  private currentProcess: import("child_process").ChildProcess | null = null;
  private pipeOutputToConsole = true;

  setPipeOutputToConsole(enabled: boolean): void {
    this.pipeOutputToConsole = enabled;
  }

  launch(command: LaunchCommand, gameDir: string): LaunchResult {
    const { javaPath, jvmArgs, mainClass, gameArgs, classpath } = command;

    // Validate javaPath exists
    if (!fs.existsSync(javaPath) && javaPath !== "java") {
      const javaDirs = process.env.PATH?.split(path.delimiter) ?? [];
      const found = javaDirs.some((dir) => fs.existsSync(path.join(dir, javaPath)));
      if (!found) {
        throw new Error(`Java not found at: ${javaPath}. Please install Java or specify --java-path`);
      }
    }

    // Ensure logs directory exists
    const logsDir = getLogsDir(gameDir);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Build args: JVM args + main class + game args
    const allArgs = [...jvmArgs, "-cp", classpath, mainClass, ...gameArgs];

    // Debug: print limited launch metadata to stderr without leaking secrets
    if (process.env.XNLC_DEBUG) {
      console.error("DEBUG Classpath:", command.classpath);
      console.error("DEBUG Main class:", mainClass);
      console.error("DEBUG JVM/Game args:", allArgs.length);
    }

    const env: Record<string, string> = {
      ...process.env,
      APPDATA: process.env.APPDATA ?? gameDir,
      XDG_SESSION_TYPE: "x11",
      GLFW_PLATFORM: "x11",
    };

    const child = spawn(javaPath, allArgs, {
      cwd: gameDir,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.currentProcess = child;

    // Log output
    const logFile = path.join(logsDir, "latest.log");
    const logStream = fs.createWriteStream(logFile, { flags: "w" });

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (this.pipeOutputToConsole) {
        process.stdout.write(text);
      }
      logStream.write(text);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (this.pipeOutputToConsole) {
        process.stderr.write(text);
      }
      logStream.write(text);
    });

    child.on("close", (code) => {
      this.currentProcess = null;
      logStream.end();
      if (code !== 0) {
        console.error(`Minecraft exited with code ${code}`);
      }
    });

    const cmdStr = `${javaPath} ${allArgs.join(" ")}`;

    return {
      process: child,
      profileName: mainClass,
      command: cmdStr,
    };
  }

  getCurrentProcess() {
    return this.currentProcess;
  }
}
