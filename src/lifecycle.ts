import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { listWorktrees } from './git';
import { TerminalManager } from './terminals';
import {
  LifecycleKind,
  resolveLifecycle,
  workspaceEnvironment,
} from './workspaceConfig';

const SETUP_STATE_KEY = 'worktreeManager.setupState';

interface LifecycleResult {
  ok: boolean;
  ran: boolean;
}

export type SetupStatus = 'not-run' | 'running' | 'ready' | 'failed' | 'stale';

async function rootPathFor(worktreePath: string): Promise<string> {
  const worktrees = await listWorktrees([worktreePath]);
  return worktrees.find((worktree) => worktree.isMain)?.path ?? worktreePath;
}

function lifecycleTitle(kind: LifecycleKind, worktreePath: string): string {
  const action = kind[0].toUpperCase() + kind.slice(1);
  return `${action} ${path.basename(worktreePath)}`;
}

class LifecycleTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private process?: ChildProcessWithoutNullStreams;
  private completed = false;

  readonly done: Promise<boolean>;
  private finish!: (ok: boolean) => void;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
  ) {
    this.done = new Promise<boolean>((resolve) => {
      this.finish = resolve;
    });
  }

  open(): void {
    const windows = process.platform === 'win32';
    const shell = windows ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
    const args = windows ? ['/d', '/s', '/c', this.command] : ['-lc', this.command];
    this.process = spawn(shell, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
    });
    const write = (chunk: Buffer) => {
      this.writeEmitter.fire(chunk.toString().replace(/\r?\n/g, '\r\n'));
    };
    this.process.stdout.on('data', write);
    this.process.stderr.on('data', write);
    this.process.on('error', (error) => {
      this.writeEmitter.fire(`\r\n${error.message}\r\n`);
      this.complete(false);
    });
    this.process.on('close', (code) => {
      const ok = code === 0;
      this.writeEmitter.fire(`\r\n${ok ? 'Completed successfully.' : `Exited with code ${code ?? '?'}.`}\r\n`);
      this.complete(ok);
    });
  }

  handleInput(data: string): void {
    this.process?.stdin.write(data);
  }

  close(): void {
    if (!this.completed) {
      this.process?.kill();
      this.complete(false);
    }
    this.writeEmitter.dispose();
  }

  private complete(ok: boolean): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.finish(ok);
  }
}

/** Run finite setup/teardown commands in a visible terminal and await the exit code. */
async function runTask(
  kind: Exclude<LifecycleKind, 'run'>,
  worktreePath: string,
  cwd: string,
  commands: string[],
  env: Record<string, string>,
): Promise<boolean> {
  const pty = new LifecycleTerminal(
    commands.map((command) => `(${command})`).join(' && '),
    cwd,
    env,
  );
  const terminal = vscode.window.createTerminal({
    name: lifecycleTitle(kind, worktreePath),
    pty,
    iconPath: new vscode.ThemeIcon(kind === 'setup' ? 'tools' : 'trash'),
  });
  terminal.show();
  return pty.done;
}

export class LifecycleManager implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeState = this.stateEmitter.event;
  private readonly runningSetups = new Set<string>();
  private readonly failedSetups = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly terminals: TerminalManager,
  ) {}

  private setupState(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(SETUP_STATE_KEY, {});
  }

  private async rememberSetup(worktreePath: string, signature: string): Promise<void> {
    await this.context.globalState.update(SETUP_STATE_KEY, {
      ...this.setupState(),
      [path.resolve(worktreePath)]: signature,
    });
  }

  async forget(worktreePath: string): Promise<void> {
    const resolved = path.resolve(worktreePath);
    const state = { ...this.setupState() };
    delete state[resolved];
    await this.context.globalState.update(SETUP_STATE_KEY, state);
    this.runningSetups.delete(resolved);
    this.failedSetups.delete(resolved);
    this.stateEmitter.fire(resolved);
  }

  async setupStatus(worktreePath: string, rootPath: string): Promise<SetupStatus> {
    const resolved = path.resolve(worktreePath);
    if (this.runningSetups.has(resolved)) {
      return 'running';
    }
    if (this.failedSetups.has(resolved)) {
      return 'failed';
    }
    try {
      const lifecycle = await resolveLifecycle('setup', worktreePath, rootPath);
      const remembered = this.setupState()[resolved];
      if (!remembered) {
        return 'not-run';
      }
      return remembered === setupSignature(lifecycle.commands, lifecycle.cwd) ? 'ready' : 'stale';
    } catch {
      return 'failed';
    }
  }

  async setup(worktreePath: string, options: { force?: boolean } = {}): Promise<LifecycleResult> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('Trust this workspace before running setup commands.');
      return { ok: false, ran: false };
    }

    const rootPath = await rootPathFor(worktreePath);
    let lifecycle;
    try {
      lifecycle = await resolveLifecycle('setup', worktreePath, rootPath);
    } catch (error) {
      const resolved = path.resolve(worktreePath);
      this.failedSetups.add(resolved);
      this.stateEmitter.fire(resolved);
      void vscode.window.showErrorMessage(`Worktree setup configuration is invalid: ${(error as Error).message}`);
      return { ok: false, ran: false };
    }
    const signature = setupSignature(lifecycle.commands, lifecycle.cwd);
    if (!options.force && this.setupState()[path.resolve(worktreePath)] === signature) {
      return { ok: true, ran: false };
    }
    if (lifecycle.commands.length === 0) {
      await this.rememberSetup(worktreePath, signature);
      this.stateEmitter.fire(path.resolve(worktreePath));
      return { ok: true, ran: false };
    }

    const resolved = path.resolve(worktreePath);
    this.runningSetups.add(resolved);
    this.failedSetups.delete(resolved);
    this.stateEmitter.fire(resolved);
    const ok = await runTask(
      'setup',
      worktreePath,
      lifecycle.cwd,
      lifecycle.commands,
      workspaceEnvironment(worktreePath, rootPath),
    );
    this.runningSetups.delete(resolved);
    if (ok) {
      await this.rememberSetup(worktreePath, signature);
      this.failedSetups.delete(resolved);
    } else {
      this.failedSetups.add(resolved);
    }
    this.stateEmitter.fire(resolved);
    return { ok, ran: true };
  }

  async teardown(worktreePath: string): Promise<LifecycleResult> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('Trust this workspace before running teardown commands.');
      return { ok: false, ran: false };
    }

    const rootPath = await rootPathFor(worktreePath);
    let lifecycle;
    try {
      lifecycle = await resolveLifecycle('teardown', worktreePath, rootPath);
    } catch (error) {
      void vscode.window.showErrorMessage(`Worktree teardown configuration is invalid: ${(error as Error).message}`);
      return { ok: false, ran: false };
    }
    if (lifecycle.commands.length === 0) {
      return { ok: true, ran: false };
    }

    const ok = await runTask(
      'teardown',
      worktreePath,
      lifecycle.cwd,
      lifecycle.commands,
      workspaceEnvironment(worktreePath, rootPath),
    );
    return { ok, ran: true };
  }

  async runApp(worktreePath: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('Trust this workspace before running app commands.');
      return;
    }
    if (this.terminals.showApp(worktreePath)) {
      return;
    }

    const setup = await this.setup(worktreePath);
    if (!setup.ok) {
      void vscode.window.showErrorMessage(
        `Setup failed for ${path.basename(worktreePath)}. Review the setup terminal, then retry Run App.`,
      );
      return;
    }

    const rootPath = await rootPathFor(worktreePath);
    let lifecycle;
    try {
      lifecycle = await resolveLifecycle('run', worktreePath, rootPath);
    } catch (error) {
      void vscode.window.showErrorMessage(`Worktree run configuration is invalid: ${(error as Error).message}`);
      return;
    }
    if (lifecycle.commands.length === 0) {
      void vscode.window.showErrorMessage(
        `No run command is configured for ${path.basename(worktreePath)}. Add \`run\` to .worktrees/config.json or .superset/config.json.`,
      );
      return;
    }

    this.terminals.runApp(worktreePath, lifecycle.commands, {
      cwd: lifecycle.cwd,
      env: workspaceEnvironment(worktreePath, rootPath),
    });
  }

  dispose(): void {
    this.stateEmitter.dispose();
  }
}

function setupSignature(commands: string[], cwd: string): string {
  return JSON.stringify({ commands, cwd });
}
