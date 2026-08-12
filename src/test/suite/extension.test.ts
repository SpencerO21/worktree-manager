import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorktreeManagerApi } from '../../extension';

const projects = path.join(process.env.WT_FIXTURE_ROOT ?? '', 'projects');

function extension(): vscode.Extension<WorktreeManagerApi> {
  const found = vscode.extensions.getExtension<WorktreeManagerApi>('spencer.worktree-manager');
  assert.ok(found, 'extension not found');
  return found;
}

async function api(): Promise<WorktreeManagerApi> {
  const found = extension();
  return found.isActive ? found.exports : await found.activate();
}

/** Settings are global in the test instance, so every test restores them. */
async function setConfig(values: Record<string, unknown>): Promise<void> {
  const config = vscode.workspace.getConfiguration('worktreeManager');
  for (const [key, value] of Object.entries(values)) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }
  await (await api()).refresh();
}

async function worktreeNames(): Promise<string[]> {
  const worktrees = await (await api()).getWorktrees();
  return worktrees.map((worktree) => path.basename(worktree.path)).sort();
}

describe('Worktree Manager', () => {
  // The default search path is the real ~/projects, which would make discovery
  // depend on whatever the developer happens to have checked out.
  beforeEach(async () => {
    await setConfig({ scope: 'currentRepository', searchPaths: [] });
  });

  it('registers its commands', async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'worktreeManager.createWorktree',
      'worktreeManager.switchWorktree',
      'worktreeManager.openWorktree',
      'worktreeManager.openTerminal',
      'worktreeManager.runWorktree',
      'worktreeManager.setupWorktree',
      'worktreeManager.removeWorktree',
      'worktreeManager.refresh',
    ]) {
      assert.ok(commands.includes(command), `${command} is not registered`);
    }
  });

  it('offers the current-window override only in a worktree right-click menu', async () => {
    const { contributes } = extension().packageJSON;
    const contextItems = contributes.menus['view/item/context'].filter(
      (item: { command: string }) => item.command === 'worktreeManager.openWorktreeCurrentWindow',
    );
    const paletteItems = contributes.menus.commandPalette.filter(
      (item: { command: string }) => item.command === 'worktreeManager.openWorktreeCurrentWindow',
    );

    assert.strictEqual(contextItems.length, 1);
    assert.ok(!contextItems[0].group.startsWith('inline'), 'current-window action is inline');
    assert.match(contextItems[0].when, /viewItem =~ \/\^worktree\//);
    assert.deepStrictEqual(paletteItems, [
      { command: 'worktreeManager.openWorktreeCurrentWindow', when: 'false' },
    ]);
  });

  it('does not expose a setting that can make ordinary clicks reuse the window', async () => {
    const { contributes } = extension().packageJSON;
    assert.strictEqual(contributes.configuration.properties['worktreeManager.openIn'], undefined);
  });

  // A menu entry pointing at a command that was never registered silently
  // renders an item that does nothing when clicked.
  it('backs every menu entry with a registered command', async () => {
    await api();
    const { contributes } = extension().packageJSON;
    const declared = new Set<string>(
      contributes.commands.map((command: { command: string }) => command.command),
    );
    const registered = new Set(await vscode.commands.getCommands(true));

    for (const menu of Object.values<Array<{ command: string }>>(contributes.menus)) {
      for (const { command } of menu) {
        assert.ok(declared.has(command), `${command} is in a menu but not contributed`);
        assert.ok(registered.has(command), `${command} is in a menu but not registered`);
      }
    }
  });

  it('lists only the open repository, not its neighbours', async () => {
    // `other` sits beside `demo` in the same parent directory.
    assert.deepStrictEqual(await worktreeNames(), ['demo', 'demo-feature-x']);
  });

  it('lists neighbouring repositories once widened to the search paths', async () => {
    await setConfig({ scope: 'searchPaths', searchPaths: [projects] });
    assert.deepStrictEqual(await worktreeNames(), ['demo', 'demo-feature-x', 'other']);
  });

  it('narrows back to the open repository from the title button', async () => {
    await setConfig({ scope: 'searchPaths', searchPaths: [projects] });
    await vscode.commands.executeCommand('worktreeManager.showThisRepository');
    await (await api()).refresh();

    assert.deepStrictEqual(await worktreeNames(), ['demo', 'demo-feature-x']);
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
    terminals.open(feature, { show: false });

    assert.strictEqual(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, folderBefore);
    assert.ok(
      vscode.window.terminals.some((t) => t.name.endsWith('demo-feature-x')),
      'no terminal was opened for the worktree',
    );

    terminals.close(feature);
  });

  it('runs configured setup in a real linked worktree with compatibility environment', async () => {
    const manager = await api();
    const feature = (await manager.getWorktrees()).find(
      (worktree) => path.basename(worktree.path) === 'demo-feature-x',
    );
    assert.ok(feature, 'feature worktree was not discovered');

    const setup = await manager.lifecycle.setup(feature.path, { force: true });

    const marker = path.join(feature.path, '.setup-ran');
    assert.deepStrictEqual(setup, { ok: true, ran: true });
    assert.strictEqual(await fs.readFile(marker, 'utf8'), await fs.realpath(path.join(projects, 'demo')));
    await fs.unlink(marker);
  });
});
