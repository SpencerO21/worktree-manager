import * as path from 'path';
import * as vscode from 'vscode';
import {
  expandHome,
  findRepositories,
  listWorktrees,
  repoRootFor,
  Worktree,
} from './git';
import { WorktreeHealth, WorktreeHealthIndex, worktreeChangeCount } from './health';
import { LifecycleManager } from './lifecycle';
import { AgentSession, CodexIndex, sessionsForWorktree } from './sessions';
import { ResolvedService, resolveServices } from './services';
import { ManagedAgent, TerminalManager } from './terminals';
import { OpenWindowRegistry } from './windows';
import { loadWorkspaceConfig } from './workspaceConfig';

const PINNED_KEY = 'worktreeManager.pinned';

export class WorktreeNode extends vscode.TreeItem {
  constructor(
    readonly worktree: Worktree,
    readonly isCurrent: boolean,
    readonly isOpen: boolean = isCurrent,
    readonly health?: WorktreeHealth,
    readonly pinned = false,
  ) {
    // A worktree git has flagged as prunable has nothing left to open, so it is
    // listed only so it can be cleared — flat, and clicking it offers removal.
    const missing = worktree.prunable;
    super(
      path.basename(worktree.path) || worktree.path,
      missing
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );

    const branch = worktree.bare
      ? 'bare repository'
      : worktree.detached
        ? `detached @ ${worktree.head?.slice(0, 8) ?? '?'}`
        : (worktree.branch ?? '(no branch)');

    const states = [branch];
    if (missing) {
      states.push('missing');
    } else {
      if (isCurrent) {
        states.push('current');
      } else if (isOpen) {
        states.push('open');
      }
      const changes = health ? worktreeChangeCount(health) : 0;
      if (changes > 0) {
        states.push(`${changes} change${changes === 1 ? '' : 's'}`);
      }
      if (health?.ahead) {
        states.push(`↑${health.ahead}`);
      }
      if (health?.behind) {
        states.push(`↓${health.behind}`);
      }
      if (health?.appRunning) {
        states.push('app running');
      }
      if (health?.agentKind) {
        states.push(`${health.agentKind} active`);
      }
      if (health?.setup === 'failed' || health?.setup === 'stale') {
        states.push(`setup ${health.setup}`);
      }
    }
    this.description = states.join(' • ');
    this.iconPath = missing
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(
          isOpen
            ? 'folder-opened'
            : pinned
              ? 'star-full'
              : worktree.isMain
                ? 'repo'
                : 'git-branch',
          isOpen ? new vscode.ThemeColor('charts.green') : undefined,
        );
    if (!missing) {
      // Pointing at a directory that is gone leaves the row to file decorations
      // for a path nothing can resolve.
      this.resourceUri = vscode.Uri.file(worktree.path);
    }
    this.contextValue = missing
      ? 'missing-worktree'
      : worktree.locked
        ? 'worktree-locked'
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
        worktree.locked
          ? `- 🔒 Locked${worktree.lockReason ? `: ${worktree.lockReason}` : ''}`
          : '',
        pinned ? '- Pinned' : '',
        health ? `- Changes: ${health.changedFiles} tracked, ${health.untrackedFiles} untracked, ${health.stagedFiles} staged` : '',
        health?.upstream
          ? `- Upstream: \`${health.upstream}\` (↑${health.ahead ?? 0} ↓${health.behind ?? 0})`
          : '',
        health?.lastCommit
          ? `- Last commit: ${relativeTime(health.lastCommit.at)} — ${health.lastCommit.subject}`
          : '',
        health ? `- Setup: ${health.setup}` : '',
        health?.appRunning ? '- App terminal is running' : '',
        health?.agentKind ? `- Active agent terminal: ${health.agentKind}` : '',
        health?.error ? `- Git status unavailable: ${health.error}` : '',
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

export class RepositoryNode extends vscode.TreeItem {
  constructor(
    readonly repoRoot: string,
    readonly children: WorktreeNode[],
    readonly pinned: boolean,
  ) {
    super(path.basename(repoRoot) || repoRoot, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${children.length} worktree${children.length === 1 ? '' : 's'}`;
    this.iconPath = new vscode.ThemeIcon(pinned ? 'star-full' : 'repo');
    this.contextValue = 'repository';
    this.tooltip = new vscode.MarkdownString(
      [`**${path.basename(repoRoot)}**`, '', `- Path: \`${repoRoot}\``, pinned ? '- Pinned' : '']
        .filter(Boolean)
        .join('\n'),
    );
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

export class ActiveAgentNode extends vscode.TreeItem {
  constructor(readonly worktreePath: string, readonly agent: ManagedAgent) {
    super(`${agent.kind} agent`, vscode.TreeItemCollapsibleState.None);
    this.description = 'active';
    this.iconPath = new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.green'));
    this.contextValue = 'active-agent';
    this.tooltip = `Active ${agent.kind} terminal in ${worktreePath}`;
    this.command = {
      command: 'worktreeManager.focusAgent',
      title: 'Focus Agent Terminal',
      arguments: [this],
    };
  }
}

export class ServiceNode extends vscode.TreeItem {
  constructor(readonly worktreePath: string, readonly service: ResolvedService) {
    super(service.name, vscode.TreeItemCollapsibleState.None);
    const address = service.port ? `port ${service.port}` : service.url ? new URL(service.url).host : '';
    this.description = [service.health, address].filter(Boolean).join(' • ');
    const error = service.health === 'unhealthy' || service.health === 'malformed';
    const icon = service.health === 'healthy'
      ? 'pass-filled'
      : error
        ? 'error'
        : service.health === 'stopped'
          ? 'debug-stop'
          : 'globe';
    const color = service.health === 'healthy'
      ? new vscode.ThemeColor('charts.green')
      : error
        ? new vscode.ThemeColor('list.errorForeground')
        : undefined;
    this.iconPath = new vscode.ThemeIcon(icon, color);
    this.contextValue = service.url ? 'worktree-service' : 'worktree-service-unavailable';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${service.name}**`,
        '',
        `- Health: ${service.health}`,
        service.url ? `- URL: ${service.url}` : '',
        service.detail ? `- ${service.detail}` : '',
      ].filter(Boolean).join('\n'),
    );
    if (service.url) {
      this.command = {
        command: 'worktreeManager.openService',
        title: 'Open Service',
        arguments: [this],
      };
    }
  }
}

export class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}

type Node = RepositoryNode | WorktreeNode | SessionNode | ActiveAgentNode | ServiceNode | MessageNode;

export interface WorktreeDiscoveryContext {
  scope: 'currentRepository' | 'searchPaths';
  workspaceFolders: string[];
  searchPaths: string[];
  repositories: string[];
}

export class WorktreeTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly codex = new CodexIndex();
  private readonly health: WorktreeHealthIndex;
  private worktrees?: Promise<Worktree[]>;

  constructor(
    private readonly openWindows: OpenWindowRegistry,
    lifecycle: LifecycleManager,
    private readonly terminals: TerminalManager,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.health = new WorktreeHealthIndex(lifecycle, terminals);
  }

  refresh(): void {
    this.worktrees = undefined;
    this.codex.invalidate();
    this.health.invalidate();
    this.emitter.fire(undefined);
  }

  refreshRuntime(worktreePath: string): void {
    this.health.invalidate(worktreePath);
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

  /** The exact roots and repositories used by discovery, for user diagnostics. */
  getDiscoveryContext(): Promise<WorktreeDiscoveryContext> {
    return this.discoveryContext();
  }

  async togglePinned(node: RepositoryNode | WorktreeNode): Promise<void> {
    const key = node instanceof RepositoryNode
      ? `repository:${path.resolve(node.repoRoot)}`
      : `worktree:${path.resolve(node.worktree.path)}`;
    const pinned = this.pinnedKeys();
    if (pinned.has(key)) {
      pinned.delete(key);
    } else {
      pinned.add(key);
    }
    await this.context.globalState.update(PINNED_KEY, [...pinned].sort());
    this.emitter.fire(undefined);
  }

  private async discover(): Promise<Worktree[]> {
    const context = await this.discoveryContext();
    const config = vscode.workspace.getConfiguration('worktreeManager');
    const options = { prune: config.get<boolean>('pruneMissingWorktrees', true) };
    return listWorktrees(context.repositories, options);
  }

  private async discoveryContext(): Promise<WorktreeDiscoveryContext> {
    const config = vscode.workspace.getConfiguration('worktreeManager');
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => path.resolve(folder.uri.fsPath));
    const searchPaths = config
      .get<string[]>('searchPaths', [])
      .map((searchPath) => path.resolve(expandHome(searchPath)));
    const scope = config.get<string>('scope', 'currentRepository') === 'searchPaths'
      ? 'searchPaths'
      : 'currentRepository';

    // Scoped to the open repository, discovery is just its own worktree family —
    // `git worktree list` reports every sibling from any one of them.
    if (scope === 'currentRepository') {
      const roots = await Promise.all(workspaceFolders.map(repoRootFor));
      return {
        scope,
        workspaceFolders,
        searchPaths,
        repositories: [...new Set(roots.filter((root): root is string => !!root))].sort(),
      };
    }

    const roots = new Set<string>([...searchPaths, ...workspaceFolders]);
    return {
      scope,
      workspaceFolders,
      searchPaths,
      repositories: (await findRepositories([...roots])).sort(),
    };
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
    if (element instanceof RepositoryNode) {
      return element.children;
    }
    if (element instanceof WorktreeNode) {
      return this.worktreeChildren(element.worktree);
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
    const [health, discovery] = await Promise.all([
      this.health.getMany(worktrees),
      this.getDiscoveryContext(),
    ]);
    const pinned = this.pinnedKeys();
    let nodes = worktrees.map((worktree) => {
      const resolved = path.resolve(worktree.path);
      return new WorktreeNode(
        worktree,
        current.has(resolved),
        open.has(resolved),
        health.get(resolved),
        pinned.has(`worktree:${resolved}`),
      );
    });
    nodes = this.filterNodes(nodes);
    nodes.sort((a, b) => this.compareNodes(a, b));

    if (discovery.scope === 'currentRepository') {
      return nodes;
    }

    const byRepository = new Map<string, WorktreeNode[]>();
    for (const node of nodes) {
      const key = path.resolve(node.worktree.repoRoot);
      const siblings = byRepository.get(key);
      if (siblings) {
        siblings.push(node);
      } else {
        byRepository.set(key, [node]);
      }
    }
    return [...byRepository]
      .map(([repoRoot, children]) => new RepositoryNode(
        repoRoot,
        children,
        pinned.has(`repository:${repoRoot}`),
      ))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(a.label).localeCompare(String(b.label)));
  }

  private filterNodes(nodes: WorktreeNode[]): WorktreeNode[] {
    const filter = vscode.workspace.getConfiguration('worktreeManager').get<string>('filter', 'all');
    switch (filter) {
      case 'open':
        return nodes.filter((node) => node.isOpen);
      case 'dirty':
        return nodes.filter((node) => !!node.health && worktreeChangeCount(node.health) > 0);
      case 'running':
        return nodes.filter((node) => node.health?.appRunning || node.health?.agentKind);
      case 'missing':
        return nodes.filter((node) => node.worktree.prunable);
      case 'stale':
        return nodes.filter((node) => node.health?.setup === 'stale' || node.health?.setup === 'failed');
      default:
        return nodes;
    }
  }

  private compareNodes(a: WorktreeNode, b: WorktreeNode): number {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    const sortBy = vscode.workspace.getConfiguration('worktreeManager').get<string>('sortBy', 'name');
    if (sortBy === 'recentActivity') {
      const byActivity = (b.health?.lastCommit?.at ?? 0) - (a.health?.lastCommit?.at ?? 0);
      if (byActivity !== 0) {
        return byActivity;
      }
    } else if (sortBy === 'status') {
      const byStatus = statusScore(b) - statusScore(a);
      if (byStatus !== 0) {
        return byStatus;
      }
    }
    return (path.basename(a.worktree.path) || a.worktree.path)
      .localeCompare(path.basename(b.worktree.path) || b.worktree.path);
  }

  private pinnedKeys(): Set<string> {
    return new Set(this.context.globalState.get<string[]>(PINNED_KEY, []));
  }

  private async worktreeChildren(worktree: Worktree): Promise<Node[]> {
    const config = vscode.workspace.getConfiguration('worktreeManager');
    const nodes: Node[] = [];
    const active = this.terminals.agentState(worktree.path);
    if (active) {
      nodes.push(new ActiveAgentNode(worktree.path, active));
    }

    try {
      const workspace = await loadWorkspaceConfig(worktree.path, worktree.repoRoot);
      const services = await resolveServices(
        workspace,
        worktree.path,
        worktree.repoRoot,
        this.terminals.hasApp(worktree.path),
      );
      nodes.push(...services.map((service) => new ServiceNode(worktree.path, service)));
    } catch (error) {
      nodes.push(new MessageNode(`Services unavailable: ${(error as Error).message}`, 'warning'));
    }

    if (config.get<boolean>('showSessions', true)) {
      const limit = config.get<number>('maxSessionsPerWorktree', 10);
      try {
        const sessions = await sessionsForWorktree(worktree.path, this.codex, limit);
        nodes.push(...sessions.map((session) => new SessionNode(session)));
        if (sessions.length === 0 && !active) {
          nodes.push(new MessageNode('No Claude Code or Codex chats yet', 'circle-slash'));
        }
      } catch {
        nodes.push(new MessageNode('Agent history is unavailable', 'warning'));
      }
    }
    return nodes;
  }
}

function statusScore(node: WorktreeNode): number {
  if (node.worktree.prunable) {
    return 50_000;
  }
  const health = node.health;
  if (!health) {
    return 0;
  }
  const setup = health.setup === 'failed' ? 20_000 : health.setup === 'stale' ? 10_000 : 0;
  const running = health.appRunning || health.agentKind ? 5_000 : 0;
  return setup + running + worktreeChangeCount(health);
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
