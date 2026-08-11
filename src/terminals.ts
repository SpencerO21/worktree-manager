import * as path from 'path';
import * as vscode from 'vscode';

/** Prefixed so restored terminals can be matched back to their worktree by name. */
const NAME_PREFIX = '⑂ ';

/**
 * How long after activation a terminal VS Code is restoring may still turn up.
 * Only spent when the window came up with no terminals at all, and cut short the
 * moment the match appears.
 */
const RESTORE_GRACE_MS = 1000;

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
  /** Terminals already present mean VS Code restored them before we activated. */
  private readonly mayStillRestore: boolean;
  private readonly restoreDeadline: number;

  constructor(now = Date.now()) {
    this.mayStillRestore =
      vscode.window.terminals.length === 0 &&
      vscode.workspace
        .getConfiguration('terminal.integrated')
        .get<boolean>('enablePersistentSessions', true);
    this.restoreDeadline = now + RESTORE_GRACE_MS;

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
   * Resolve once the worktree's restored terminal has appeared, or once it is
   * clear none is coming. Without this, opening a terminal during the activation
   * that follows a switch races VS Code's own restore and leaves a duplicate.
   */
  private waitForRestore(worktreePath: string): Promise<vscode.Terminal | undefined> {
    const existing = this.get(worktreePath);
    const remaining = this.restoreDeadline - Date.now();
    if (existing || !this.mayStillRestore || remaining <= 0) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const settle = (terminal?: vscode.Terminal) => {
        clearTimeout(timer);
        subscription.dispose();
        resolve(terminal);
      };
      const timer = setTimeout(() => settle(undefined), remaining);
      const subscription = vscode.window.onDidOpenTerminal(() => {
        const match = this.get(worktreePath);
        if (match) {
          settle(match);
        }
      });
    });
  }

  /**
   * Reveal the worktree's terminal, creating it on first use. `command` is sent
   * only to a terminal this call created, so re-entering a worktree never
   * interrupts whatever is already running there. Pass `adopt: false` for a
   * worktree that cannot have a restored terminal — a freshly created one — to
   * skip the restore grace period entirely.
   */
  async open(
    worktreePath: string,
    options: {
      show?: boolean;
      preserveFocus?: boolean;
      command?: string;
      adopt?: boolean;
    } = {},
  ): Promise<vscode.Terminal> {
    const { show = true, preserveFocus = false, command, adopt = true } = options;

    let terminal = adopt ? await this.waitForRestore(worktreePath) : this.get(worktreePath);
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
