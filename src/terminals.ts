import * as path from 'path';
import * as vscode from 'vscode';

export function terminalName(worktreePath: string): string {
  return path.basename(worktreePath) || worktreePath;
}

export function appTerminalName(worktreePath: string, index = 0): string {
  const suffix = index > 0 ? ` ${index + 1}` : '';
  return `App: ${terminalName(worktreePath)}${suffix}`;
}

export function agentTerminalName(worktreePath: string, kind: string): string {
  return `Agent: ${kind}: ${terminalName(worktreePath)}`;
}

export interface ManagedAgent {
  terminal: vscode.Terminal;
  kind: string;
  startedAt: number;
}

export type ManagedAppState = 'running' | 'stopped';

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
  private readonly agentTerminals = new Map<string, ManagedAgent>();
  private readonly appStates = new Map<string, ManagedAppState>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stateEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeState = this.stateEmitter.event;

  constructor() {
    this.adoptRestoredTerminals();
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        const changed = new Set<string>();
        for (const [worktreePath, terminal] of this.terminals) {
          if (terminal === closed) {
            this.terminals.delete(worktreePath);
            changed.add(worktreePath);
          }
        }
        for (const [worktreePath, terminals] of this.appTerminals) {
          const remaining = terminals.filter((terminal) => terminal !== closed);
          if (remaining.length === 0) {
            this.appTerminals.delete(worktreePath);
            this.appStates.set(worktreePath, 'stopped');
            changed.add(worktreePath);
          } else if (remaining.length !== terminals.length) {
            this.appTerminals.set(worktreePath, remaining);
            changed.add(worktreePath);
          }
        }
        for (const [worktreePath, agent] of this.agentTerminals) {
          if (agent.terminal === closed) {
            this.agentTerminals.delete(worktreePath);
            changed.add(worktreePath);
          }
        }
        changed.forEach((worktreePath) => this.stateEmitter.fire(worktreePath));
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

  /** Start an agent in its own worktree-scoped terminal. Prompt text travels via env, not shell. */
  runAgent(
    worktreePath: string,
    kind: string,
    command: string,
    options: { prompt?: string } = {},
  ): vscode.Terminal {
    const resolved = key(worktreePath);
    const existing = this.agentTerminals.get(resolved);
    if (existing) {
      existing.terminal.show();
      return existing.terminal;
    }
    const env: Record<string, string> = {
      WORKTREE_MANAGER_AGENT_KIND: kind,
      WORKTREE_MANAGER_WORKTREE_PATH: resolved,
    };
    let invocation = command;
    if (options.prompt?.trim()) {
      env.WORKTREE_MANAGER_AGENT_PROMPT = options.prompt;
      invocation += process.platform === 'win32'
        ? ' "$env:WORKTREE_MANAGER_AGENT_PROMPT"'
        : ' "$WORKTREE_MANAGER_AGENT_PROMPT"';
    }
    const terminal = vscode.window.createTerminal({
      name: agentTerminalName(worktreePath, kind),
      cwd: worktreePath,
      env,
      iconPath: new vscode.ThemeIcon('hubot'),
    });
    terminal.sendText(invocation);
    terminal.show();
    this.agentTerminals.set(resolved, { terminal, kind, startedAt: Date.now() });
    this.stateEmitter.fire(resolved);
    return terminal;
  }

  agentKind(worktreePath: string): string | undefined {
    return this.agentTerminals.get(key(worktreePath))?.kind;
  }

  agentState(worktreePath: string): ManagedAgent | undefined {
    return this.agentTerminals.get(key(worktreePath));
  }

  showAgent(worktreePath: string): boolean {
    const agent = this.agentTerminals.get(key(worktreePath));
    if (!agent) {
      return false;
    }
    agent.terminal.show();
    return true;
  }

  stopAgent(worktreePath: string): boolean {
    const resolved = key(worktreePath);
    const agent = this.agentTerminals.get(resolved);
    if (!agent) {
      return false;
    }
    this.agentTerminals.delete(resolved);
    agent.terminal.dispose();
    this.stateEmitter.fire(resolved);
    return true;
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

  hasApp(worktreePath: string): boolean {
    return (this.appTerminals.get(key(worktreePath))?.length ?? 0) > 0;
  }

  appState(worktreePath: string): ManagedAppState {
    return this.hasApp(worktreePath) ? 'running' : (this.appStates.get(key(worktreePath)) ?? 'stopped');
  }

  stopApp(worktreePath: string): boolean {
    const resolved = key(worktreePath);
    const apps = this.appTerminals.get(resolved);
    if (!apps?.length) {
      return false;
    }
    this.appTerminals.delete(resolved);
    this.appStates.set(resolved, 'stopped');
    for (const terminal of apps) {
      terminal.dispose();
    }
    this.stateEmitter.fire(resolved);
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
        env: {
          ...options.env,
          WORKTREE_MANAGER_APP: '1',
          WORKTREE_MANAGER_WORKTREE_PATH: key(worktreePath),
        },
        iconPath: new vscode.ThemeIcon('play'),
      });
      terminal.sendText(command);
      return terminal;
    });
    if (terminals.length > 0) {
      const resolved = key(worktreePath);
      this.appTerminals.set(resolved, terminals);
      this.appStates.set(resolved, 'running');
      this.stateEmitter.fire(resolved);
      terminals[0].show();
    }
    return terminals;
  }

  close(worktreePath: string): void {
    const resolved = key(worktreePath);
    const terminal = this.get(resolved);
    if (terminal) {
      this.terminals.delete(resolved);
      terminal.dispose();
    }
    this.stopAgent(resolved);
    const apps = this.appTerminals.get(resolved);
    if (apps) {
      this.appTerminals.delete(resolved);
      this.appStates.set(resolved, 'stopped');
      for (const app of apps) {
        app.dispose();
      }
    }
    this.stateEmitter.fire(resolved);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.terminals.clear();
    this.appTerminals.clear();
    this.appStates.clear();
    this.agentTerminals.clear();
    this.stateEmitter.dispose();
  }

  private adoptRestoredTerminals(): void {
    for (const terminal of vscode.window.terminals) {
      const options = terminal.creationOptions as vscode.TerminalOptions;
      const env = options.env;
      const cwd = env?.WORKTREE_MANAGER_WORKTREE_PATH ?? terminalCwd(options.cwd);
      if (!cwd) {
        continue;
      }
      const resolved = key(cwd);
      const kind = env?.WORKTREE_MANAGER_AGENT_KIND;
      if (kind) {
        this.agentTerminals.set(resolved, { terminal, kind, startedAt: 0 });
      } else if (env?.WORKTREE_MANAGER_APP === '1') {
        const apps = this.appTerminals.get(resolved) ?? [];
        apps.push(terminal);
        this.appTerminals.set(resolved, apps);
        this.appStates.set(resolved, 'running');
      }
    }
  }
}

function terminalCwd(cwd: string | vscode.Uri | undefined): string | undefined {
  return typeof cwd === 'string' ? cwd : cwd?.scheme === 'file' ? cwd.fsPath : undefined;
}
