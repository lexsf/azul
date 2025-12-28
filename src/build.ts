import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IPCServer } from "./ipc/server.js";
import { config } from "./config.js";
import { log } from "./util/log.js";
import type { InstanceData } from "./ipc/messages.js";

interface BuildOptions {
  syncDir?: string;
}

export class BuildCommand {
  private ipc: IPCServer;
  private syncDir: string;

  constructor(options: BuildOptions = {}) {
    this.syncDir = path.resolve(options.syncDir ?? config.syncDir);
    this.ipc = new IPCServer(config.port, undefined, {
      requestSnapshotOnConnect: false,
    });
  }

  public async run(): Promise<void> {
    log.info(`Preparing build snapshot from ${this.syncDir}`);
    const instances = await this.buildSnapshot();
    log.info(`Waiting for Studio to connect on port ${config.port}...`);

    await new Promise<void>((resolve) => {
      this.ipc.onConnection(() => {
        log.info("Studio connected. Sending build snapshot...");
        this.ipc.send({ type: "buildSnapshot", data: instances });
        log.success(`Sent ${instances.length} instances`);
        setTimeout(() => {
          this.ipc.close();
          resolve();
        }, 200);
      });
    });
  }

  private async buildSnapshot(): Promise<InstanceData[]> {
    const results: InstanceData[] = [];
    const folderMap = new Map<string, InstanceData>();
    const scriptPaths = new Set<string>();

    const pathKey = (segments: string[]) => segments.join("/");

    const ensureFolder = (segments: string[]) => {
      for (let i = 1; i <= segments.length; i++) {
        const key = segments.slice(0, i).join("/");
        if (scriptPaths.has(key)) continue; // A script at this path should own children
        if (folderMap.has(key)) continue;
        const data: InstanceData = {
          guid: this.makeGuid(),
          className: "Folder",
          name: segments[i - 1],
          path: segments.slice(0, i),
        };
        folderMap.set(key, data);
        results.push(data);
      }
    };

    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      const files = entries.filter((entry) => entry.isFile());
      const directories = entries.filter((entry) => entry.isDirectory());

      // Process files first so we know which paths are scripts before visiting
      // their same-named folders (which hold nested children).
      for (const entry of files) {
        const fullPath = path.join(dir, entry.name);
        if (entry.name.endsWith(".luau") || entry.name.endsWith(".lua")) {
          const relSegments = this.relativeSegments(fullPath);
          const { className, scriptName } = this.classifyScript(entry.name);
          const dirSegments = relSegments.slice(0, -1);
          if (dirSegments.length > 0) {
            ensureFolder(dirSegments);
          }

          const filePathSegments = [...dirSegments, scriptName];
          const source = await fs.readFile(fullPath, "utf-8");

          scriptPaths.add(pathKey(filePathSegments));

          const fileData: InstanceData = {
            guid: this.makeGuid(),
            className,
            name: scriptName,
            path: filePathSegments,
            source,
          };

          results.push(fileData);
        }
      }

      // Process directories after scripts so script-named folders are treated
      // as containers for nested instances rather than sibling Folder nodes.
      for (const entry of directories) {
        const fullPath = path.join(dir, entry.name);
        const relSegments = this.relativeSegments(fullPath);

        if (relSegments.length > 0) {
          ensureFolder(relSegments);
        }

        await walk(fullPath);
      }
    };

    await walk(this.syncDir);

    // Sort shallow-to-deep so parents are created first
    results.sort((a, b) => a.path.length - b.path.length);
    return results;
  }

  private relativeSegments(targetPath: string): string[] {
    const rel = path.relative(this.syncDir, targetPath);
    if (!rel || rel === "") return [];
    return rel.split(path.sep).filter(Boolean);
  }

  private classifyScript(fileName: string): {
    className: "Script" | "LocalScript" | "ModuleScript";
    scriptName: string;
  } {
    if (fileName.endsWith(".lua")) {
      fileName = fileName.replace(/\.lua$/i, ".luau");
    }

    const base = fileName.replace(/\.luau$/i, "");
    if (base.endsWith(".server")) {
      return { className: "Script", scriptName: base.replace(/\.server$/, "") };
    }
    if (base.endsWith(".client")) {
      return {
        className: "LocalScript",
        scriptName: base.replace(/\.client$/, ""),
      };
    }
    if (base.endsWith(".module")) {
      return {
        className: "ModuleScript",
        scriptName: base.replace(/\.module$/, ""),
      };
    }
    // Default to ModuleScript when no explicit suffix
    return { className: "ModuleScript", scriptName: base };
  }

  private makeGuid(): string {
    return randomUUID().replace(/-/g, "");
  }
}
