import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  branchFromTask,
  copyIncludedFiles,
  resolveWorktreePath,
  worktreeIncludePatterns,
} from '../../create';
import * as vscode from 'vscode';

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

describe('task-first creation', () => {
  it('resolves the resource-scoped VS Code worktree include setting', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const config = vscode.workspace.getConfiguration('git', folder.uri);
    const previous = config.inspect<string[]>('worktreeIncludeFiles')?.workspaceFolderValue;
    try {
      await config.update(
        'worktreeIncludeFiles',
        ['.env', 'cache/**'],
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      assert.deepStrictEqual(worktreeIncludePatterns(folder.uri.fsPath), ['.env', 'cache/**']);
    } finally {
      await config.update(
        'worktreeIncludeFiles',
        previous,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    }
  });

  it('derives editable branch names from tasks and GitHub URLs', () => {
    assert.strictEqual(branchFromTask('Fix flaky setup state'), 'task/fix-flaky-setup-state');
    assert.strictEqual(
      branchFromTask('https://github.com/acme/repo/issues/42'),
      'task/issue-42',
    );
    assert.strictEqual(
      branchFromTask('https://github.com/acme/repo/pull/17'),
      'task/pr-17',
    );
  });

  it('copies only ignored files matched by VS Code include patterns', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'worktree-copy-source-'));
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'worktree-copy-target-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      await fsp.writeFile(path.join(root, '.gitignore'), '.env\ncache/\nignored.txt\n');
      await fsp.writeFile(path.join(root, '.env'), 'PORT=1234\n');
      await fsp.writeFile(path.join(root, 'ignored.txt'), 'not selected\n');
      await fsp.mkdir(path.join(root, 'cache', 'nested'), { recursive: true });
      await fsp.writeFile(path.join(root, 'cache', 'nested', 'data.txt'), 'cached\n');

      const copied = await copyIncludedFiles(root, target, ['.env', 'cache/**']);

      assert.strictEqual(copied, 2);
      assert.strictEqual(await fsp.readFile(path.join(target, '.env'), 'utf8'), 'PORT=1234\n');
      assert.strictEqual(
        await fsp.readFile(path.join(target, 'cache', 'nested', 'data.txt'), 'utf8'),
        'cached\n',
      );
      await assert.rejects(fsp.stat(path.join(target, 'ignored.txt')));
    } finally {
      await Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(target, { recursive: true, force: true }),
      ]);
    }
  });
});
