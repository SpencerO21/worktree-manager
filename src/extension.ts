import * as path from 'path';
import * as vscode from 'vscode';
import { createWorktree } from './create';
import { removeWorktree, Worktree } from './git';
import { TerminalManager } from './terminals';
import { SessionNode, WorktreeNode, WorktreeTreeProvider } from './tree';

/**
 * VS Code can only point a window at another folder by reloading it, which tears
 * down the extension host and every terminal with it. The switch is therefore
 * handed to the next activation through globalState: whichever window comes up in
 * the recorded folder opens its terminal and clears the note.
 */
const PENDING_KEY = 'worktreeManager.pendingSwitch';
const PENDING_TTL_MS = 5 * 60 * 1000;

interface PendingSwitch {
  path: string;
  /** Sent to the worktree terminal once the window has come back up. */
  command?: string;
  at: number;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const terminals = new TerminalManager();
  const provider = new WorktreeTreeProvider();
  const view = vscode.window.createTreeView('worktreeManager.tree', {
    treeDataProvider: provider,
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'worktreeManager.switchWorktree';
  context.subscriptions.push(terminals, view, status, provider);

  const config = () => vscode.workspace.getConfiguration('worktreeManager');

  const refresh = async (): Promise<void> => {
    provider.refresh();
    await updateStatus(status, provider);
  };

  /** Point this window (or a new one) at a worktree and give it its terminal. */
  const switchTo = async (worktreePath: string, command?: string): Promise<void> => {
    const target = path.resolve(worktreePath);

    if (currentFolder() === target) {
      if (command || config().get<boolean>('openTerminalOnSwitch', true)) {
        terminals.open(target, { command });
      }
      return;
    }

    const newWindow = config().get<string>('openIn', 'currentWindow') === 'newWindow';
    await context.globalState.update(PENDING_KEY, {
      path: target,
      command,
      at: Date.now(),
    } satisfies PendingSwitch);

    try {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(target),
        newWindow ? { forceNewWindow: true } : { forceReuseWindow: true },
      );
    } catch (error) {
      await context.globalState.update(PENDING_KEY, undefined);
      void vscode.window.showErrorMessage(
        `Could not open ${target}: ${(error as Error).message}`,
      );
    }
  };

  /** The worktree a command should act on: the clicked node, or one picked by hand. */
  const targetWorktree = async (node?: WorktreeNode): Promise<Worktree | undefined> => {
    if (node instanceof WorktreeNode) {
      return node.worktree;
    }
    return pickWorktree(await provider.getWorktrees(), 'Select a worktree');
  };

  const register = (command: string, handler: (...args: any[]) => any) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('worktreeManager.refresh', refresh);

  register('worktreeManager.openWorktree', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      await switchTo(worktree.path);
    }
  });

  register('worktreeManager.switchWorktree', async () => {
    const worktree = await pickWorktree(await provider.getWorktrees(), 'Switch to worktree');
    if (worktree) {
      await switchTo(worktree.path);
    }
  });

  register('worktreeManager.openWorktreeCurrentWindow', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (!worktree) {
      return;
    }
    if (currentFolder() === path.resolve(worktree.path)) {
      terminals.open(worktree.path);
      return;
    }
    await context.globalState.update(PENDING_KEY, {
      path: path.resolve(worktree.path),
      at: Date.now(),
    } satisfies PendingSwitch);
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(worktree.path),
      { forceReuseWindow: true },
    );
  });

  register('worktreeManager.openWorktreeNewWindow', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (!worktree) {
      return;
    }
    await context.globalState.update(PENDING_KEY, {
      path: path.resolve(worktree.path),
      at: Date.now(),
    } satisfies PendingSwitch);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), {
      forceNewWindow: true,
    });
  });

  register('worktreeManager.openTerminal', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      terminals.open(worktree.path);
    }
  });

  register('worktreeManager.createWorktree', async () => {
    const created = await createWorktree(await provider.getWorktrees());
    if (!created) {
      return;
    }
    await refresh();
    await switchTo(created);
  });

  register('worktreeManager.removeWorktree', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (!worktree) {
      return;
    }
    if (worktree.isMain) {
      void vscode.window.showErrorMessage(
        'The primary working tree cannot be removed with `git worktree remove`.',
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Remove worktree ${path.basename(worktree.path)}?`,
      { modal: true, detail: `${worktree.path}\n\nThe branch itself is kept.` },
      'Remove',
      'Force Remove',
    );
    if (!choice) {
      return;
    }
    try {
      await removeWorktree(worktree.repoRoot, worktree.path, choice === 'Force Remove');
    } catch (error) {
      void vscode.window.showErrorMessage(
        `git worktree remove failed: ${(error as Error).message}`,
      );
      return;
    }
    terminals.close(worktree.path);
    await refresh();
  });

  register('worktreeManager.resumeSession', async (node?: SessionNode) => {
    if (!(node instanceof SessionNode)) {
      return;
    }
    const { session } = node;
    const command =
      session.kind === 'claude'
        ? `${config().get<string>('claudeCommand', 'claude')} --resume ${session.id}`
        : `${config().get<string>('codexCommand', 'codex')} resume ${session.id}`;
    await switchTo(session.cwd, command);
  });

  register('worktreeManager.newClaudeSession', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      terminals.open(worktree.path, { command: config().get<string>('claudeCommand', 'claude') });
    }
  });

  register('worktreeManager.newCodexSession', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      terminals.open(worktree.path, { command: config().get<string>('codexCommand', 'codex') });
    }
  });

  register('worktreeManager.revealInOS', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(worktree.path));
    }
  });

  register('worktreeManager.copyPath', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      await vscode.env.clipboard.writeText(worktree.path);
      void vscode.window.showInformationMessage(`Copied ${worktree.path}`);
    }
  });

  register('worktreeManager.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeManager'),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('worktreeManager')) {
        void refresh();
      }
    }),
  );

  await resumePendingSwitch(context, terminals);
  await updateStatus(status, provider);
}

/**
 * Finish a switch started before the reload: the folder is now open, so the
 * worktree's terminal is (re)created and any queued command sent.
 */
async function resumePendingSwitch(
  context: vscode.ExtensionContext,
  terminals: TerminalManager,
): Promise<void> {
  const pending = context.globalState.get<PendingSwitch>(PENDING_KEY);
  if (!pending) {
    return;
  }
  const folder = currentFolder();
  const fresh = Date.now() - pending.at < PENDING_TTL_MS;
  // Other windows may be starting up too; only the one that landed in the target
  // folder consumes the note, and a stale note is dropped by whoever finds it.
  if (folder !== path.resolve(pending.path)) {
    if (!fresh) {
      await context.globalState.update(PENDING_KEY, undefined);
    }
    return;
  }

  await context.globalState.update(PENDING_KEY, undefined);
  if (!fresh) {
    return;
  }
  const openOnSwitch = vscode.workspace
    .getConfiguration('worktreeManager')
    .get<boolean>('openTerminalOnSwitch', true);
  if (openOnSwitch || pending.command) {
    terminals.open(pending.path, { command: pending.command });
  }
}

/** Absolute path of the single folder this window is showing, if there is one. */
function currentFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const first = folders.find((folder) => folder.uri.scheme === 'file');
  return first ? path.resolve(first.uri.fsPath) : undefined;
}

async function pickWorktree(
  worktrees: Worktree[],
  placeHolder: string,
): Promise<Worktree | undefined> {
  if (worktrees.length === 0) {
    void vscode.window.showInformationMessage('No git worktrees found.');
    return undefined;
  }
  const current = currentFolder();
  const picked = await vscode.window.showQuickPick(
    worktrees.map((worktree) => ({
      label: `$(${worktree.isMain ? 'repo' : 'git-branch'}) ${path.basename(worktree.path)}`,
      description: [
        worktree.detached ? `detached @ ${worktree.head?.slice(0, 8) ?? '?'}` : worktree.branch,
        path.resolve(worktree.path) === current ? 'current' : undefined,
      ]
        .filter(Boolean)
        .join(' • '),
      detail: worktree.path,
      worktree,
    })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true },
  );
  return picked?.worktree;
}

async function updateStatus(
  status: vscode.StatusBarItem,
  provider: WorktreeTreeProvider,
): Promise<void> {
  const folder = currentFolder();
  if (!folder) {
    status.hide();
    return;
  }
  const worktrees = await provider.getWorktrees();
  const current = worktrees.find((worktree) => path.resolve(worktree.path) === folder);
  if (!current || worktrees.length < 2) {
    status.hide();
    return;
  }
  const branch = current.detached
    ? `detached @ ${current.head?.slice(0, 8) ?? '?'}`
    : (current.branch ?? path.basename(current.path));
  status.text = `$(git-branch) ${path.basename(current.path)}`;
  status.tooltip = `Worktree ${path.basename(current.path)} — ${branch}\nClick to switch worktree`;
  status.show();
}

export function deactivate(): void {
  // Terminals and views are disposed through context.subscriptions.
}
