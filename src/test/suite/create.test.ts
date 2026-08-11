import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { resolveWorktreePath } from '../../create';

const repo = { root: '/Users/someone/worktree-manager', name: 'worktree-manager' };

describe('resolveWorktreePath', () => {
  // Worktrees under one parent keep VS Code's workspace trust to a single grant.
  it('puts new worktrees under the configured parent, not beside the repo', () => {
    const resolved = resolveWorktreePath('~/projects/{repoName}-{branch}', repo, 'test');

    assert.strictEqual(resolved, path.join(os.homedir(), 'projects/worktree-manager-test'));
  });

  it('flattens slashes in the branch into the directory name', () => {
    const resolved = resolveWorktreePath('~/projects/{repoName}-{branch}', repo, 'feature/x');

    assert.strictEqual(resolved, path.join(os.homedir(), 'projects/worktree-manager-feature-x'));
  });

  it('still supports placing a worktree beside its repository', () => {
    const resolved = resolveWorktreePath('{repoParent}/{repoName}-{branch}', repo, 'test');

    assert.strictEqual(resolved, '/Users/someone/worktree-manager-test');
  });
});
