import * as path from 'path';
import * as vscode from 'vscode';
import { createWorktree } from './create';
import { pruneWorktrees, removeWorktree, Worktree } from './git';
import { LifecycleManager } from './lifecycle';
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
  /** Run in the worktree once the window has come back up, if anything. */
  command?: string;
  at: number;
}

/** Returned from `activate` so integration tests can drive the live objects. */
export interface WorktreeManagerApi {
  getWorktrees(): Promise<Worktree[]>;
  refresh(): Promise<void>;
  terminals: TerminalManager;
  lifecycle: LifecycleManager;
}

export async function activate(context: vscode.ExtensionContext): Promise<WorktreeManagerApi> {
  const terminals = new TerminalManager();
  const lifecycle = new LifecycleManager(context, terminals);
  const provider = new WorktreeTreeProvider();
  const view = vscode.window.createTreeView('worktreeManager.tree', {
    treeDataProvider: provider,
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'worktreeManager.switchWorktree';
  context.subscriptions.push(terminals, view, status, provider);

  const config = () => vscode.workspace.getConfiguration('worktreeManager');

  let refreshedAt = 0;
  const AUTO_REFRESH_INTERVAL_MS = 5000;

  const refresh = async (): Promise<void> => {
    refreshedAt = Date.now();
    provider.refresh();
    const worktrees = await provider.getWorktrees();
    // Drives the "Remove Missing Worktrees" button, which is only worth a slot in
    // the title bar when there is something for it to clear.
    await vscode.commands.executeCommand(
      'setContext',
      'worktreeManager.hasMissingWorktrees',
      worktrees.some((worktree) => worktree.prunable),
    );
    await updateStatus(status, provider);
  };

  /** A refresh for events that fire in bursts, skipped when one just happened. */
  const autoRefresh = (): void => {
    if (Date.now() - refreshedAt >= AUTO_REFRESH_INTERVAL_MS) {
      void refresh();
    }
  };

  /** Drives which of the two scope buttons the view title shows. */
  const syncScopeContext = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      'setContext',
      'worktreeManager.allRepositories',
      config().get<string>('scope', 'currentRepository') === 'searchPaths',
    );
  };

  const setScope = async (scope: 'currentRepository' | 'searchPaths'): Promise<void> => {
    await config().update('scope', scope, vscode.ConfigurationTarget.Global);
    await syncScopeContext();
    // The configuration listener refreshes the tree.
  };

  /** Open a worktree in its own window unless the caller explicitly opts in to reuse. */
  const switchTo = async (
    worktreePath: string,
    options: { command?: string; reuseWindow?: boolean } = {},
  ): Promise<void> => {
    const { command } = options;
    const target = path.resolve(worktreePath);

    if (currentFolder() === target) {
      if (command) {
        terminals.run(target, command);
      }
      return;
    }

    await context.globalState.update(PENDING_KEY, {
      path: target,
      command,
      at: Date.now(),
    } satisfies PendingSwitch);

    try {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(target),
        options.reuseWindow ? { forceReuseWindow: true } : { forceNewWindow: true },
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

  register('worktreeManager.showAllRepositories', () => setScope('searchPaths'));
  register('worktreeManager.showThisRepository', () => setScope('currentRepository'));

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
    if (worktree) {
      await switchTo(worktree.path, { reuseWindow: true });
    }
  });

  register('worktreeManager.openWorktreeNewWindow', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      await switchTo(worktree.path);
    }
  });

  register('worktreeManager.openTerminal', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      terminals.open(worktree.path);
    }
  });

  register('worktreeManager.setupWorktree', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (!worktree) {
      return;
    }
    const result = await lifecycle.setup(worktree.path, { force: true });
    if (result.ok) {
      void vscode.window.showInformationMessage(
        result.ran
          ? `Setup completed for ${path.basename(worktree.path)}.`
          : `No setup commands are configured for ${path.basename(worktree.path)}.`,
      );
    } else {
      void vscode.window.showErrorMessage(
        `Setup failed for ${path.basename(worktree.path)}. Review the setup terminal for details.`,
      );
    }
  });

  register('worktreeManager.runWorktree', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      await lifecycle.runApp(worktree.path);
    }
  });

  register('worktreeManager.createWorktree', async () => {
    const created = await createWorktree(await provider.getWorktrees());
    if (!created) {
      return;
    }
    await refresh();
    const setup = await lifecycle.setup(created);
    if (!setup.ok) {
      const choice = await vscode.window.showErrorMessage(
        `Setup failed for ${path.basename(created)}. The worktree was kept so you can inspect and retry it.`,
        'Open Anyway',
      );
      if (choice !== 'Open Anyway') {
        return;
      }
    }
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

    // Nothing can be lost by clearing a worktree whose directory is already gone,
    // so it asks once and does not offer a force variant.
    const choice = worktree.prunable
      ? await vscode.window.showWarningMessage(
          `Remove missing worktree ${path.basename(worktree.path)}?`,
          {
            modal: true,
            detail: `${worktree.path}\n\nThe directory is already gone. This clears git's record of it; the branch is kept.`,
          },
          'Remove',
        )
      : await vscode.window.showWarningMessage(
          `Remove worktree ${path.basename(worktree.path)}?`,
          { modal: true, detail: `${worktree.path}\n\nThe branch itself is kept.` },
          'Remove',
          'Force Remove',
        );
    if (!choice) {
      return;
    }
    if (!worktree.prunable) {
      const teardown = await lifecycle.teardown(worktree.path);
      if (!teardown.ok) {
        const removeAnyway = await vscode.window.showWarningMessage(
          `Teardown failed for ${path.basename(worktree.path)}. Remove the worktree anyway?`,
          { modal: true },
          'Remove Anyway',
        );
        if (removeAnyway !== 'Remove Anyway') {
          return;
        }
      }
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
    await lifecycle.forget(worktree.path);
    await refresh();
  });

  register('worktreeManager.pruneWorktrees', async () => {
    const missing = (await provider.getWorktrees()).filter((worktree) => worktree.prunable);
    if (missing.length === 0) {
      void vscode.window.showInformationMessage('No missing worktrees to remove.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      missing.length === 1
        ? `Remove missing worktree ${path.basename(missing[0].path)}?`
        : `Remove ${missing.length} missing worktrees?`,
      {
        modal: true,
        detail: `${missing.map((worktree) => worktree.path).join('\n')}\n\nThese directories are already gone. This clears git's record of them; their branches are kept.`,
      },
      'Remove',
    );
    if (choice !== 'Remove') {
      return;
    }

    const failures: string[] = [];
    for (const repo of new Set(missing.map((worktree) => worktree.repoRoot))) {
      try {
        await pruneWorktrees(repo);
      } catch (error) {
        failures.push(`${path.basename(repo)}: ${(error as Error).message}`);
      }
    }
    for (const worktree of missing) {
      terminals.close(worktree.path);
      await lifecycle.forget(worktree.path);
    }
    await refresh();

    if (failures.length > 0) {
      void vscode.window.showErrorMessage(`git worktree prune failed — ${failures.join('; ')}`);
    }
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
    await switchTo(session.cwd, { command });
  });

  register('worktreeManager.newClaudeSession', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      terminals.run(worktree.path, config().get<string>('claudeCommand', 'claude'));
    }
  });

  register('worktreeManager.newCodexSession', async (node?: WorktreeNode) => {
    const worktree = await targetWorktree(node);
    if (worktree) {
      terminals.run(worktree.path, config().get<string>('codexCommand', 'codex'));
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
    // Worktrees come and go from terminals and from other windows. Re-reading git
    // whenever the view is looked at again is what stops the list going stale
    // without polling; the throttle keeps a burst of focus events to one read.
    view.onDidChangeVisibility((event) => {
      if (event.visible) {
        autoRefresh();
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && view.visible) {
        autoRefresh();
      }
    }),
  );

  await syncScopeContext();
  await resumePendingSwitch(context, terminals);
  await updateStatus(status, provider);

  return { getWorktrees: () => provider.getWorktrees(), refresh, terminals, lifecycle };
}

/**
 * Finish a switch started before the reload: the window is now showing the
 * worktree, so bring the view back up and run anything that was queued.
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

  // Reveal first: a queued command opens a terminal, and that should end up
  // with the focus rather than the view.
  const config = vscode.workspace.getConfiguration('worktreeManager');
  if (config.get<boolean>('revealViewOnSwitch', true)) {
    await vscode.commands.executeCommand('workbench.view.extension.worktreeManager');
  }
  if (pending.command) {
    terminals.run(pending.path, pending.command);
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
      label: `$(${worktree.prunable ? 'warning' : worktree.isMain ? 'repo' : 'git-branch'}) ${path.basename(worktree.path)}`,
      description: [
        worktree.detached ? `detached @ ${worktree.head?.slice(0, 8) ?? '?'}` : worktree.branch,
        worktree.prunable ? 'missing' : undefined,
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
