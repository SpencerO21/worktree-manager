import * as path from 'path';
import { GitWorktreeHealth, Worktree, worktreeGitHealth } from './git';
import { LifecycleManager, SetupStatus } from './lifecycle';
import { TerminalManager } from './terminals';

export interface WorktreeHealth extends GitWorktreeHealth {
  setup: SetupStatus;
  appRunning: boolean;
  agentKind?: string;
}

/** Cached, concurrency-limited state used to decorate and sort the tree. */
export class WorktreeHealthIndex {
  private readonly cache = new Map<string, Promise<WorktreeHealth>>();

  constructor(
    private readonly lifecycle: LifecycleManager,
    private readonly terminals: TerminalManager,
  ) {}

  invalidate(worktreePath?: string): void {
    if (worktreePath) {
      this.cache.delete(path.resolve(worktreePath));
    } else {
      this.cache.clear();
    }
  }

  async getMany(worktrees: Worktree[]): Promise<Map<string, WorktreeHealth>> {
    const health = new Map<string, WorktreeHealth>();
    const queue = [...worktrees];
    const workers = Array.from(
      { length: Math.min(6, queue.length) },
      async () => {
        while (queue.length > 0) {
          const worktree = queue.shift();
          if (!worktree) {
            return;
          }
          health.set(path.resolve(worktree.path), await this.get(worktree));
        }
      },
    );
    await Promise.all(workers);
    return health;
  }

  private get(worktree: Worktree): Promise<WorktreeHealth> {
    const key = path.resolve(worktree.path);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.read(worktree);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async read(worktree: Worktree): Promise<WorktreeHealth> {
    if (worktree.prunable || worktree.bare) {
      return {
        changedFiles: 0,
        stagedFiles: 0,
        untrackedFiles: 0,
        setup: 'not-run',
        appRunning: false,
      };
    }
    const [gitHealth, setup] = await Promise.all([
      worktreeGitHealth(worktree.path),
      this.lifecycle.setupStatus(worktree.path, worktree.repoRoot),
    ]);
    return {
      ...gitHealth,
      setup,
      appRunning: this.terminals.hasApp(worktree.path),
      agentKind: this.terminals.agentKind(worktree.path),
    };
  }
}

export function worktreeChangeCount(health: WorktreeHealth): number {
  return health.changedFiles + health.untrackedFiles;
}
