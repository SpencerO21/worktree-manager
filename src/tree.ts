import * as path from 'path';
import * as vscode from 'vscode';
import { findRepositories, listWorktrees, repoRootFor, Worktree } from './git';
import { AgentSession, CodexIndex, sessionsForWorktree } from './sessions';
import { OpenWindowRegistry } from './windows';

export class WorktreeNode extends vscode.TreeItem {
  constructor(
    readonly worktree: Worktree,
    readonly isCurrent: boolean,
    readonly isOpen: boolean = isCurrent,
  ) {
    // A worktree git has flagged as prunable has nothing left to open, so it is
    // listed only so it can be cleared — flat, and clicking it offers removal.
    const missing = worktree.prunable;
    const name = path.basename(worktree.path) || worktree.path;
    const label: string | vscode.TreeItemLabel = isCurrent
      ? { label: name, highlights: [[0, name.length]] }
      : name;
    super(
      label,
      missing
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );

    const branch = worktree.detached
      ? `detached @ ${worktree.head?.slice(0, 8) ?? '?'}`
      : (worktree.branch ?? '(no branch)');

    this.description = missing
      ? `${branch} • missing`
      : isCurrent
        ? `${branch} • current`
        : isOpen
          ? `${branch} • open`
          : branch;
    this.iconPath = missing
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(
          isOpen ? 'folder-opened' : worktree.isMain ? 'repo' : 'git-branch',
          isOpen ? new vscode.ThemeColor('charts.green') : undefined,
        );
    if (!missing) {
      // Pointing at a directory that is gone leaves the row to file decorations
      // for a path nothing can resolve.
      this.resourceUri = vscode.Uri.file(worktree.path);
    }
    this.contextValue = missing
      ? 'missing-worktree'
      : worktree.isMain
        ? 'worktree-main'
        : 'worktree';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${path.basename(worktree.path)}**`,
        '',
        `- Branch: \`${branch}\``,
        `- Path: \`${worktree.path}\``,
        `- Repository: \`${worktree.repoRoot}\``,
        isCurrent
          ? '- Open in this VS Code window'
          : isOpen
            ? '- Open in another VS Code window'
            : '',
        worktree.isMain ? '- Primary working tree' : '',
        worktree.locked ? '- 🔒 Locked' : '',
        missing
          ? `- ⚠️ Directory is gone${worktree.prunableReason ? ` (${worktree.prunableReason})` : ''}. Only git's record of it is left — click to clear it.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    this.command = missing
      ? {
          command: 'worktreeManager.removeWorktree',
          title: 'Remove Missing Worktree',
          arguments: [this],
        }
      : {
          command: 'worktreeManager.openWorktree',
          title: 'Open Worktree',
          arguments: [this],
        };
  }
}

export class SessionNode extends vscode.TreeItem {
  constructor(readonly session: AgentSession) {
    super(session.title, vscode.TreeItemCollapsibleState.None);

    const agent = session.kind === 'claude' ? 'Claude Code' : 'Codex';
    this.description = `${agent} • ${relativeTime(session.mtime)}`;
    this.iconPath = new vscode.ThemeIcon(
      session.kind === 'claude' ? 'comment-discussion' : 'terminal',
    );
    this.contextValue = 'session';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.title}**`,
        '',
        `- Agent: ${agent}`,
        `- Session: \`${session.id}\``,
        `- Last active: ${new Date(session.mtime).toLocaleString()}`,
        '',
        '_Click to open the worktree and resume this chat._',
      ].join('\n'),
    );

    this.command = {
      command: 'worktreeManager.resumeSession',
      title: 'Resume Chat',
      arguments: [this],
    };
  }
}

export class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}

type Node = WorktreeNode | SessionNode | MessageNode;

export class WorktreeTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly codex = new CodexIndex();
  private worktrees?: Promise<Worktree[]>;

  constructor(private readonly openWindows: OpenWindowRegistry) {}

  refresh(): void {
    this.worktrees = undefined;
    this.codex.invalidate();
    this.emitter.fire(undefined);
  }

  /** Repaint presence without doing another git and agent-session scan. */
  refreshOpenWindows(): void {
    this.emitter.fire(undefined);
  }

  /**
   * The discovered worktrees, shared with commands that work off the same list.
   * Cached until the next refresh so a click does not re-scan every repository.
   */
  getWorktrees(): Promise<Worktree[]> {
    this.worktrees ??= this.discover();
    return this.worktrees;
  }

  private async discover(): Promise<Worktree[]> {
    const config = vscode.workspace.getConfiguration('worktreeManager');
    const options = { prune: config.get<boolean>('pruneMissingWorktrees', true) };
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);

    // Scoped to the open repository, discovery is just its own worktree family —
    // `git worktree list` reports every sibling from any one of them.
    if (config.get<string>('scope', 'currentRepository') === 'currentRepository') {
      const roots = await Promise.all(folders.map(repoRootFor));
      return listWorktrees(
        [...new Set(roots.filter((root): root is string => !!root))],
        options,
      );
    }

    const roots = new Set<string>([...config.get<string[]>('searchPaths', []), ...folders]);
    return listWorktrees(await findRepositories([...roots]), options);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      return this.rootNodes();
    }
    if (element instanceof WorktreeNode) {
      return this.sessionNodes(element.worktree);
    }
    return [];
  }

  private async rootNodes(): Promise<Node[]> {
    const worktrees = await this.getWorktrees();
    if (worktrees.length === 0) {
      // Returning nothing lets the viewsWelcome content take over.
      return [];
    }

    const current = currentWorkspacePaths();
    const open = await this.openWindows.getOpenPaths();
    return worktrees.map(
      (worktree) => {
        const resolved = path.resolve(worktree.path);
        return new WorktreeNode(worktree, current.has(resolved), open.has(resolved));
      },
    );
  }

  private async sessionNodes(worktree: Worktree): Promise<Node[]> {
    const config = vscode.workspace.getConfiguration('worktreeManager');
    if (!config.get<boolean>('showSessions', true)) {
      return [];
    }

    const limit = config.get<number>('maxSessionsPerWorktree', 10);
    const sessions = await sessionsForWorktree(worktree.path, this.codex, limit);

    if (sessions.length === 0) {
      return [new MessageNode('No Claude Code or Codex chats yet', 'circle-slash')];
    }
    return sessions.map((session) => new SessionNode(session));
  }
}

function currentWorkspacePaths(): Set<string> {
  const paths = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') {
      paths.add(path.resolve(folder.uri.fsPath));
    }
  }
  return paths;
}

function relativeTime(epochMs: number): string {
  const seconds = Math.round((Date.now() - epochMs) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const units: Array<[number, string]> = [
    [60, 'm'],
    [3600, 'h'],
    [86400, 'd'],
  ];
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, suffix] = units[i];
    if (seconds >= size) {
      return `${Math.floor(seconds / size)}${suffix} ago`;
    }
  }
  return 'just now';
}
