import * as path from 'path';
import * as vscode from 'vscode';
import { findRepositories, listWorktrees, Worktree } from './git';
import { AgentSession, CodexIndex, sessionsForWorktree } from './sessions';

export class WorktreeNode extends vscode.TreeItem {
  constructor(
    readonly worktree: Worktree,
    readonly isCurrent: boolean,
  ) {
    super(
      path.basename(worktree.path) || worktree.path,
      vscode.TreeItemCollapsibleState.Collapsed,
    );

    const branch = worktree.detached
      ? `detached @ ${worktree.head?.slice(0, 8) ?? '?'}`
      : (worktree.branch ?? '(no branch)');

    this.description = isCurrent ? `${branch} • current` : branch;
    this.iconPath = new vscode.ThemeIcon(
      worktree.isMain ? 'repo' : 'git-branch',
      isCurrent ? new vscode.ThemeColor('charts.green') : undefined,
    );
    this.resourceUri = vscode.Uri.file(worktree.path);
    this.contextValue = worktree.isMain ? 'worktree-main' : 'worktree';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${path.basename(worktree.path)}**`,
        '',
        `- Branch: \`${branch}\``,
        `- Path: \`${worktree.path}\``,
        `- Repository: \`${worktree.repoRoot}\``,
        worktree.isMain ? '- Primary working tree' : '',
        worktree.locked ? '- 🔒 Locked' : '',
        worktree.prunable ? '- ⚠️ Prunable (directory missing)' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    this.command = {
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

  refresh(): void {
    this.worktrees = undefined;
    this.codex.invalidate();
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
    const searchPaths = vscode.workspace
      .getConfiguration('worktreeManager')
      .get<string[]>('searchPaths', []);

    const roots = new Set<string>(searchPaths);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === 'file') {
        roots.add(folder.uri.fsPath);
      }
    }

    return listWorktrees(await findRepositories([...roots]));
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
    return worktrees.map(
      (worktree) => new WorktreeNode(worktree, current.has(path.resolve(worktree.path))),
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
