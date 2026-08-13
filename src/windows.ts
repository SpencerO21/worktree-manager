import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 20_000;

interface WindowMarker {
  paths: string[];
  heartbeat: number;
}

/**
 * A lightweight presence registry shared by every window running the extension.
 *
 * VS Code exposes the folders in this extension host, but not the folders open in
 * its other windows. Each host therefore keeps one short-lived marker in the
 * extension's global storage directory. Separate files avoid concurrent windows
 * overwriting one another, while the heartbeat makes crashed hosts disappear.
 */
export class OpenWindowRegistry implements vscode.Disposable {
  private readonly directory: string;
  private readonly marker: string;
  private heartbeat?: NodeJS.Timeout;
  private workspacePaths = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private disposed = false;

  constructor(storageUri: vscode.Uri) {
    this.directory = path.join(storageUri.fsPath, 'open-windows');
    this.marker = path.join(this.directory, `${process.pid}-${randomUUID()}.json`);
  }

  async start(paths: Iterable<string>): Promise<void> {
    this.workspacePaths = resolvedPaths(paths);
    await this.writeMarker();
    this.heartbeat = setInterval(() => void this.writeMarker(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  async setWorkspacePaths(paths: Iterable<string>): Promise<void> {
    this.workspacePaths = resolvedPaths(paths);
    await this.writeMarker();
  }

  async getOpenPaths(): Promise<Set<string>> {
    const open = new Set(this.workspacePaths);
    let names: string[];
    try {
      names = await fsp.readdir(this.directory);
    } catch {
      return open;
    }

    const now = Date.now();
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const markerPath = path.join(this.directory, name);
          try {
            const value = JSON.parse(await fsp.readFile(markerPath, 'utf8')) as WindowMarker;
            if (
              typeof value.heartbeat !== 'number' ||
              !Array.isArray(value.paths) ||
              now - value.heartbeat > STALE_AFTER_MS
            ) {
              await removeMarker(markerPath);
              return;
            }
            for (const workspacePath of value.paths) {
              if (typeof workspacePath === 'string') {
                open.add(path.resolve(workspacePath));
              }
            }
          } catch {
            // A host may be replacing its tiny marker while this one scans. The
            // next refresh will see it; malformed abandoned markers are harmless.
          }
        }),
    );
    return open;
  }

  dispose(): void {
    void this.close();
  }

  async close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.disposed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    this.closing = this.pending.then(() => removeMarker(this.marker));
    return this.closing;
  }

  private writeMarker(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const value: WindowMarker = {
      paths: [...this.workspacePaths],
      heartbeat: Date.now(),
    };
    this.pending = this.pending
      .then(async () => {
        if (this.disposed) {
          return;
        }
        await fsp.mkdir(this.directory, { recursive: true });
        await fsp.writeFile(this.marker, JSON.stringify(value), 'utf8');
      })
      .catch(() => {
        // Presence is a visual convenience and must never stop activation when
        // global storage is temporarily unavailable.
      });
    return this.pending;
  }
}

function resolvedPaths(paths: Iterable<string>): Set<string> {
  return new Set([...paths].map((workspacePath) => path.resolve(workspacePath)));
}

async function removeMarker(markerPath: string): Promise<void> {
  try {
    await fsp.unlink(markerPath);
  } catch {
    // Marker cleanup is best-effort. An old marker will age out on a later scan.
  }
}
