import fs from "node:fs";
import path from "node:path";
import { IPCServer } from "./ipc/server.js";
import { config } from "./config.js";
import { log } from "./util/log.js";
import { SnapshotBuilder } from "./snapshot.js";
import type {
  PushConfig,
  PushConfigMessage,
  PushSnapshotMapping,
  RequestPushConfigMessage,
  StudioMessage,
} from "./ipc/messages.js";

interface PushOptions {
  source?: string;
  destination?: string;
  destructive?: boolean;
  usePlaceConfig?: boolean;
}

export class PushCommand {
  private ipc: IPCServer;
  private options: PushOptions;
  private receivedConfig: PushConfig | null = null;

  constructor(options: PushOptions = {}) {
    this.options = options;
    this.ipc = new IPCServer(config.port, undefined, {
      requestSnapshotOnConnect: false,
    });
  }

  public async run(): Promise<void> {
    const mappings = await this.collectMappings();
    if (!mappings || mappings.length === 0) {
      log.error("No push mappings available. Provide -s/-d or place config.");
      return;
    }

    log.info(`Building ${mappings.length} mapping(s) for push...`);

    const snapshotMappings: PushSnapshotMapping[] = [];

    for (const mapping of mappings) {
      const destSegments = mapping.destination;

      const sourceCandidates = this.expandSourceCandidates(mapping.source);
      const sourceDir = sourceCandidates.find((candidate) =>
        fs.existsSync(candidate)
      );

      if (!sourceDir) {
        log.error(
          `Source path not found for push mapping. Tried: ${sourceCandidates.join(
            ", "
          )}`
        );
        continue;
      }

      const builder = new SnapshotBuilder({
        sourceDir,
        destPrefix: destSegments,
        skipSymlinks: true,
      });

      const instances = await builder.build();
      log.success(
        `Prepared ${
          instances.length
        } instances from ${sourceDir} -> ${destSegments.join("/")}`
      );

      snapshotMappings.push({
        destination: destSegments,
        destructive: Boolean(mapping.destructive),
        instances,
      });
    }

    if (snapshotMappings.length === 0) {
      log.error("No push mappings could be prepared (missing source paths).");
      return;
    }

    await new Promise<void>((resolve) => {
      const sendSnapshot = () => {
        log.info("Studio connected. Sending push snapshot...");
        this.ipc.send({ type: "pushSnapshot", mappings: snapshotMappings });
        setTimeout(() => {
          this.ipc.close();
          resolve();
        }, 200);
      };

      if (this.ipc.isConnected()) {
        sendSnapshot();
      } else {
        this.ipc.onConnection(sendSnapshot);
      }
    });
  }

  private async collectMappings(): Promise<PushConfig["mappings"] | null> {
    // CLI-provided mapping takes priority
    if (this.options.source && this.options.destination) {
      const destSegments = this.parseDestination(this.options.destination);
      if (destSegments.length === 0) {
        log.error(
          "Destination must be a dot-separated path (e.g., ReplicatedStorage.Packages)"
        );
        return null;
      }
      return [
        {
          source: this.options.source,
          destination: destSegments,
          destructive: Boolean(this.options.destructive),
        },
      ];
    }

    if (this.options.usePlaceConfig === false) {
      return null;
    }

    log.info(
      "Waiting for push config from Studio (ServerStorage.Azul.Config)..."
    );
    const config = await this.waitForPushConfig();
    if (!config) {
      return null;
    }

    const sanitized = config.mappings?.filter((m) =>
      Boolean(m && m.source && m.destination && m.destination.length > 0)
    );

    if (!sanitized || sanitized.length === 0) {
      log.error("Received push config, but no valid mappings were found.");
      return null;
    }

    return sanitized.map((m) => ({
      source: m.source,
      destination: m.destination,
      destructive: Boolean(m.destructive),
    }));
  }

  private parseDestination(input: string): string[] {
    return input
      .split(/[./\\]+/)
      .map((segment) => segment.trim())
      .filter(Boolean);
  }

  /**
   * Normalize source path strings from config, preferring the raw value but
   * attempting obvious fixes (e.g., accidental leading '.' before a folder).
   */
  private expandSourceCandidates(source: string): string[] {
    const candidates: string[] = [];
    const cwd = process.cwd();

    const add = (p: string) => {
      const abs = path.resolve(cwd, p);
      if (!candidates.includes(abs)) {
        candidates.push(abs);
      }
    };

    add(source);

    // If someone wrote ".Packages" by mistake, try "Packages"
    if (source.startsWith(".")) {
      const trimmedDot = source.replace(/^\.*/, "");
      if (trimmedDot) add(trimmedDot);
    }

    // If someone prefixed with ./ or .\, resolve both forms
    if (source.startsWith("./") || source.startsWith(".\\")) {
      add(source.slice(2));
    }

    return candidates;
  }

  private async waitForPushConfig(): Promise<PushConfig | null> {
    return new Promise<PushConfig | null>((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          log.warn("Timed out waiting for push config from Studio.");
          resolved = true;
          resolve(null);
        }
      }, 8000);

      this.ipc.onMessage((message: StudioMessage) => {
        if (message.type === "pushConfig") {
          const pushConfig = (message as PushConfigMessage).config;
          this.receivedConfig = pushConfig;
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            resolve(pushConfig);
          }
        }
      });

      // Ask the plugin to send config after connection
      this.ipc.onConnection(() => {
        const request: RequestPushConfigMessage = { type: "requestPushConfig" };
        this.ipc.send(request);
      });
    });
  }
}
