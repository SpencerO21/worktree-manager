import * as path from 'path';
import * as vscode from 'vscode';

export function terminalName(worktreePath: string): string {
  return path.basename(worktreePath) || worktreePath;
}

export function appTerminalName(worktreePath: string, index = 0): string {
  const suffix = index > 0 ? ` ${index + 1}` : '';
  return `App: ${terminalName(worktreePath)}${suffix}`;
}

function key(worktreePath: string): string {
  return path.resolve(worktreePath);
}

/**
 * Terminals opened on demand for a worktree — never automatically.
 *
 * Switching worktrees reloads the window, so this only ever tracks terminals
 * created in the current one; anything VS Code restores by itself is left alone.
 */
export class TerminalManager implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly appTerminals = new Map<string, vscode.Terminal[]>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        for (const [worktreePath, terminal] of this.terminals) {
          if (terminal === closed) {
            this.terminals.delete(worktreePath);
          }
        }
        for (const [worktreePath, terminals] of this.appTerminals) {
          const remaining = terminals.filter((terminal) => terminal !== closed);
          if (remaining.length === 0) {
            this.appTerminals.delete(worktreePath);
          } else if (remaining.length !== terminals.length) {
            this.appTerminals.set(worktreePath, remaining);
          }
        }
      }),
    );
  }

  get(worktreePath: string): vscode.Terminal | undefined {
    return this.terminals.get(key(worktreePath));
  }

  private create(worktreePath: string): vscode.Terminal {
    return vscode.window.createTerminal({
      name: terminalName(worktreePath),
      cwd: worktreePath,
      iconPath: new vscode.ThemeIcon('git-branch'),
    });
  }

  /** Reveal this worktree's terminal, opening one the first time. */
  open(worktreePath: string, options: { show?: boolean } = {}): vscode.Terminal {
    let terminal = this.get(worktreePath);
    if (!terminal) {
      terminal = this.create(worktreePath);
      this.terminals.set(key(worktreePath), terminal);
    }
    if (options.show ?? true) {
      terminal.show();
    }
    return terminal;
  }

  /** Run `command` in this worktree's terminal, opening one if there is none. */
  run(worktreePath: string, command: string): vscode.Terminal {
    const terminal = this.open(worktreePath, { show: false });
    terminal.sendText(command);
    terminal.show();
    return terminal;
  }

  /** Reveal an app that is already running for this worktree. */
  showApp(worktreePath: string): boolean {
    const terminals = this.appTerminals.get(key(worktreePath));
    if (!terminals?.length) {
      return false;
    }
    terminals[0].show();
    return true;
  }

  /** Start each configured app command in its own worktree-scoped terminal. */
  runApp(
    worktreePath: string,
    commands: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): vscode.Terminal[] {
    const existing = this.appTerminals.get(key(worktreePath));
    if (existing?.length) {
      existing[0].show();
      return existing;
    }

    const terminals = commands.map((command, index) => {
      const terminal = vscode.window.createTerminal({
        name: appTerminalName(worktreePath, index),
        cwd: options.cwd ?? worktreePath,
        env: options.env,
        iconPath: new vscode.ThemeIcon('play'),
      });
      terminal.sendText(command);
      return terminal;
    });
    if (terminals.length > 0) {
      this.appTerminals.set(key(worktreePath), terminals);
      terminals[0].show();
    }
    return terminals;
  }

  close(worktreePath: string): void {
    const terminal = this.get(worktreePath);
    if (terminal) {
      this.terminals.delete(key(worktreePath));
      terminal.dispose();
    }
    const apps = this.appTerminals.get(key(worktreePath));
    if (apps) {
      this.appTerminals.delete(key(worktreePath));
      for (const app of apps) {
        app.dispose();
      }
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.terminals.clear();
    this.appTerminals.clear();
  }
}
