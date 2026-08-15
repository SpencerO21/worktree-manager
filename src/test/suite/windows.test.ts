import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Worktree } from '../../git';
import { WorktreeNode } from '../../tree';
import { OpenWindowRegistry } from '../../windows';

describe('open worktree windows', () => {
  it('shares the worktree paths registered by separate VS Code windows', async () => {
    const storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'worktree-windows-'));
    const first = new OpenWindowRegistry(vscode.Uri.file(storage));
    const second = new OpenWindowRegistry(vscode.Uri.file(storage));
    const firstPath = path.join(storage, 'first');
    const secondPath = path.join(storage, 'second');

    try {
      await first.start([firstPath]);
      await second.start([secondPath]);

      assert.deepStrictEqual(
        [...(await first.getOpenPaths())].sort(),
        [firstPath, secondPath].map((workspacePath) => path.resolve(workspacePath)).sort(),
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
      await fsp.rm(storage, { recursive: true, force: true });
    }
  });

  it('makes an open worktree visibly distinct from a closed one', () => {
    const worktree: Worktree = {
      path: '/repo/feature',
      repoRoot: '/repo/main',
      branch: 'feature',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      isMain: false,
    };

    const open = new WorktreeNode(worktree, false, true);
    const closed = new WorktreeNode(worktree, false, false);

    assert.match(String(open.description), /open/);
    assert.strictEqual((open.iconPath as vscode.ThemeIcon).id, 'folder-opened');
    assert.strictEqual((open.iconPath as vscode.ThemeIcon).color?.id, 'charts.green');
    assert.doesNotMatch(String(closed.description), /open/);
    assert.strictEqual((closed.iconPath as vscode.ThemeIcon).id, 'git-branch');
  });
});
