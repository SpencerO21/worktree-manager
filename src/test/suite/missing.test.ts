import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorktreeManagerApi } from '../../extension';
import { listWorktrees, parseWorktreePorcelain, removeWorktree } from '../../git';
import { WorktreeNode } from '../../tree';

const repo = process.env.WT_FIXTURE_REPO ?? '';
// The fixture lives under the temporary directory, which is a symlink on macOS —
// git records the resolved path, so comparisons have to start from the same one.
const projects = path.join(fs.realpathSync(process.env.WT_FIXTURE_ROOT ?? '.'), 'projects');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

async function api(): Promise<WorktreeManagerApi> {
  const found = vscode.extensions.getExtension<WorktreeManagerApi>('spencer021.spencers-worktree-manager');
  assert.ok(found, 'extension not found');
  return found.isActive ? found.exports : await found.activate();
}

async function setConfig(values: Record<string, unknown>): Promise<void> {
  const config = vscode.workspace.getConfiguration('worktreeManager');
  for (const [key, value] of Object.entries(values)) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

/** A worktree whose directory has been deleted behind git's back. */
function abandonWorktree(name: string): string {
  const worktreePath = path.join(projects, name);
  git(['worktree', 'add', '-b', name, worktreePath]);
  fs.rmSync(worktreePath, { recursive: true, force: true });
  return worktreePath;
}

function forget(worktreePath: string, branch: string): void {
  if (fs.existsSync(worktreePath)) {
    git(['worktree', 'remove', '--force', worktreePath]);
  }
  git(['worktree', 'prune']);
  try {
    git(['branch', '-D', branch]);
  } catch {
    // Branch removal is best effort; the fixture is thrown away after the run.
  }
}

describe('worktrees whose directory is gone', () => {
  beforeEach(async () => {
    await setConfig({
      scope: 'currentRepository',
      searchPaths: [],
      pruneMissingWorktrees: true,
    });
  });

  it('is reported as prunable by git until something clears it', () => {
    const worktreePath = abandonWorktree('demo-abandoned');
    try {
      const parsed = parseWorktreePorcelain(git(['worktree', 'list', '--porcelain', '-z']), repo);
      const stale = parsed.find((worktree) => worktree.path === worktreePath);

      assert.ok(stale, 'git no longer lists the worktree');
      assert.strictEqual(stale.prunable, true);
      assert.ok(stale.prunableReason, 'git gave no reason for the stale record');
    } finally {
      forget(worktreePath, 'demo-abandoned');
    }
  });

  it('is pruned out of the listing when discovery is allowed to prune', async () => {
    const worktreePath = abandonWorktree('demo-pruned');
    try {
      const worktrees = await listWorktrees([repo], { prune: true });

      assert.ok(
        !worktrees.some((worktree) => worktree.path === worktreePath),
        'the missing worktree is still listed',
      );
      assert.ok(
        !git(['worktree', 'list', '--porcelain']).includes(worktreePath),
        'git still has a record of the missing worktree',
      );
    } finally {
      forget(worktreePath, 'demo-pruned');
    }
  });

  it('is left listed, and marked, when pruning is turned off', async () => {
    const worktreePath = abandonWorktree('demo-kept');
    try {
      const worktrees = await listWorktrees([repo], { prune: false });
      const stale = worktrees.find((worktree) => worktree.path === worktreePath);

      assert.ok(stale, 'the missing worktree was dropped from the listing');

      const node = new WorktreeNode(stale, false);
      assert.strictEqual(node.contextValue, 'missing-worktree');
      assert.match(String(node.description), /missing/);
      // Nothing to expand, and clicking offers to clear it rather than to open
      // a folder that is not there.
      assert.strictEqual(node.collapsibleState, vscode.TreeItemCollapsibleState.None);
      assert.strictEqual(node.command?.command, 'worktreeManager.removeWorktree');
    } finally {
      forget(worktreePath, 'demo-kept');
    }
  });

  // `git worktree remove --force` refuses outright once the directory is gone,
  // so the remove path has to fall back to pruning to finish the job.
  it('can still be removed through the remove path', async () => {
    const worktreePath = abandonWorktree('demo-removed');
    try {
      await removeWorktree(repo, worktreePath, true);

      assert.ok(
        !git(['worktree', 'list', '--porcelain']).includes(worktreePath),
        'git still has a record of the removed worktree',
      );
    } finally {
      forget(worktreePath, 'demo-removed');
    }
  });

  it('disappears from the view once the tree refreshes', async () => {
    const worktreePath = abandonWorktree('demo-refreshed');
    try {
      const { refresh, getWorktrees } = await api();
      await refresh();

      assert.ok(
        !(await getWorktrees()).some((worktree) => worktree.path === worktreePath),
        'the view still lists the missing worktree',
      );
    } finally {
      forget(worktreePath, 'demo-refreshed');
    }
  });

  it('registers the command that clears every missing worktree at once', async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('worktreeManager.pruneWorktrees'));
  });
});
