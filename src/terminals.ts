import * as path from 'path';
import * as vscode from 'vscode';

/** Prefixed so restored terminals can be matched back to their worktree by name. */
const NAME_PREFIX = '⑂ ';

export function terminalName(worktreePath: string): string {
  return `${NAME_PREFIX}${path.basename(worktreePath) || worktreePath}`;
}

function key(worktreePath: string): string {
  return path.resolve(worktreePath);
}

function cwdOf(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions as vscode.TerminalOptions;
  const cwd = options?.cwd;
  if (typeof cwd === 'string') {
    return cwd;
  }
  if (cwd instanceof vscode.Uri && cwd.scheme === 'file') {
    return cwd.fsPath;
  }
  return undefined;
}

/**
 * One terminal per worktree, keyed by path.
 *
 * Terminals live in a window, and switching a window to another folder reloads it,
 * so this map only ever holds the terminals of the current window. Terminals that
 * VS Code restores across that reload are adopted by cwd, falling back to the
 * prefixed name (restored terminals do not always carry their creation options).
 */
export class TerminalManager implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    for (const terminal of vscode.window.terminals) {
      this.adopt(terminal);
    }
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => this.adopt(terminal)),
      vscode.window.onDidCloseTerminal((closed) => {
        for (const [path, terminal] of this.terminals) {
          if (terminal === closed) {
            this.terminals.delete(path);
          }
        }
      }),
    );
  }

  private adopt(terminal: vscode.Terminal): void {
    const cwd = cwdOf(terminal);
    if (cwd && !this.terminals.has(key(cwd))) {
      this.terminals.set(key(cwd), terminal);
    }
  }

  get(worktreePath: string): vscode.Terminal | undefined {
    const existing = this.terminals.get(key(worktreePath));
    if (existing) {
      return existing;
    }
    const name = terminalName(worktreePath);
    const restored = vscode.window.terminals.find((terminal) => terminal.name === name);
    if (restored) {
      this.terminals.set(key(worktreePath), restored);
    }
    return restored;
  }

  /**
   * Reveal the worktree's terminal, creating it on first use. `command` is sent
   * only to a terminal this call created, so re-entering a worktree never
   * interrupts whatever is already running there.
   */
  open(
    worktreePath: string,
    options: { show?: boolean; preserveFocus?: boolean; command?: string } = {},
  ): vscode.Terminal {
    const { show = true, preserveFocus = false, command } = options;

    let terminal = this.get(worktreePath);
    const isNew = terminal === undefined;
    if (!terminal) {
      terminal = vscode.window.createTerminal({
        name: terminalName(worktreePath),
        cwd: worktreePath,
        iconPath: new vscode.ThemeIcon('git-branch'),
      });
      this.terminals.set(key(worktreePath), terminal);
    }

    if (isNew) {
      const startup = vscode.workspace
        .getConfiguration('worktreeManager')
        .get<string>('terminalStartupCommand', '')
        .trim();
      if (startup) {
        terminal.sendText(startup);
      }
    }
    if (command) {
      terminal.sendText(command);
    }
    if (show) {
      terminal.show(preserveFocus);
    }
    return terminal;
  }

  close(worktreePath: string): void {
    const terminal = this.get(worktreePath);
    if (terminal) {
      this.terminals.delete(key(worktreePath));
      terminal.dispose();
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.terminals.clear();
  }
}
