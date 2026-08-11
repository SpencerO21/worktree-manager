import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorktreeManagerApi } from '../../extension';

const projects = path.join(process.env.WT_FIXTURE_ROOT ?? '', 'projects');

async function api(): Promise<WorktreeManagerApi> {
  const extension = vscode.extensions.getExtension<WorktreeManagerApi>('spencer.worktree-manager');
  assert.ok(extension, 'extension not found');
  return extension.isActive ? extension.exports : await extension.activate();
}

describe('Worktree Manager', () => {
  // Otherwise discovery also picks up whatever real repositories live in the
  // default ~/projects, which is right in practice but unassertable in a test.
  before(async () => {
    await vscode.workspace
      .getConfiguration('worktreeManager')
      .update('searchPaths', [], vscode.ConfigurationTarget.Global);
    await (await api()).refresh();
  });

  it('registers its commands', async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'worktreeManager.createWorktree',
      'worktreeManager.switchWorktree',
      'worktreeManager.openWorktree',
      'worktreeManager.openTerminal',
      'worktreeManager.removeWorktree',
      'worktreeManager.refresh',
    ]) {
      assert.ok(commands.includes(command), `${command} is not registered`);
    }
  });

  it('discovers every worktree of the open repository', async () => {
    const worktrees = (await api()).getWorktrees();
    const byName = new Map(
      (await worktrees).map((worktree) => [path.basename(worktree.path), worktree]),
    );

    assert.deepStrictEqual([...byName.keys()].sort(), ['demo', 'demo-feature-x']);
    assert.strictEqual(byName.get('demo')?.isMain, true);
    assert.strictEqual(byName.get('demo')?.branch, 'main');
    assert.strictEqual(byName.get('demo-feature-x')?.isMain, false);
    assert.strictEqual(byName.get('demo-feature-x')?.branch, 'feature/x');
  });

  it('opens a terminal for a worktree without switching the window', async () => {
    const { terminals } = await api();
    const folderBefore = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const feature = path.join(projects, 'demo-feature-x');
    await terminals.open(feature, { show: false, adopt: false });

    assert.strictEqual(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, folderBefore);
    assert.ok(
      vscode.window.terminals.some((t) => t.name.endsWith('demo-feature-x')),
      'no terminal was opened for the worktree',
    );

    terminals.close(feature);
  });
});
