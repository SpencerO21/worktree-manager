import * as path from 'path';
import * as vscode from 'vscode';

export function terminalName(worktreePath: string): string {
  return path.basename(worktreePath) || worktreePath;
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
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        for (const [worktreePath, terminal] of this.terminals) {
          if (terminal === closed) {
            this.terminals.delete(worktreePath);
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
