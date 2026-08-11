import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { TerminalManager, terminalName } from '../../terminals';

const projects = path.join(process.env.WT_FIXTURE_ROOT ?? '', 'projects');
const featureWorktree = path.join(projects, 'demo-feature-x');
const mainWorktree = path.join(projects, 'demo');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function named(worktreePath: string): vscode.Terminal[] {
  return vscode.window.terminals.filter((t) => t.name === terminalName(worktreePath));
}

/** Terminals disappear from window.terminals asynchronously, so poll for empty. */
async function closeAllTerminals(): Promise<void> {
  for (const terminal of vscode.window.terminals) {
    terminal.dispose();
  }
  for (let i = 0; i < 100 && vscode.window.terminals.length > 0; i++) {
    await delay(50);
  }
  assert.strictEqual(vscode.window.terminals.length, 0, 'terminals did not close');
}

describe('TerminalManager', () => {
  const managers: TerminalManager[] = [];
  const make = () => {
    const manager = new TerminalManager();
    managers.push(manager);
    return manager;
  };

  afterEach(async () => {
    while (managers.length) {
      managers.pop()?.dispose();
    }
    await closeAllTerminals();
  });

  it('creates one terminal per worktree, rooted in it', async () => {
    const manager = make();
    const terminal = await manager.open(featureWorktree, { show: false });

    assert.strictEqual(terminal.name, terminalName(featureWorktree));
    assert.strictEqual(named(featureWorktree).length, 1);

    const cwd = (terminal.creationOptions as vscode.TerminalOptions).cwd;
    assert.strictEqual(cwd, featureWorktree);
  });

  it('reuses the terminal instead of opening a second one', async () => {
    const manager = make();
    const first = await manager.open(featureWorktree, { show: false });
    const second = await manager.open(featureWorktree, { show: false });

    assert.strictEqual(second, first);
    assert.strictEqual(named(featureWorktree).length, 1);
  });

  it('keeps worktrees on separate terminals', async () => {
    const manager = make();
    const feature = await manager.open(featureWorktree, { show: false });
    const main = await manager.open(mainWorktree, { show: false });

    assert.notStrictEqual(feature, main);
    assert.strictEqual(named(featureWorktree).length, 1);
    assert.strictEqual(named(mainWorktree).length, 1);
  });

  // The reload case: a new manager comes up in a window that already has the
  // worktree's terminal, and must take it over rather than open a duplicate.
  it('adopts a terminal that is already present', async () => {
    const existing = vscode.window.createTerminal({
      name: terminalName(featureWorktree),
      cwd: featureWorktree,
    });
    await delay(100);

    const manager = make();
    const opened = await manager.open(featureWorktree, { show: false });

    assert.strictEqual(opened, existing);
    assert.strictEqual(named(featureWorktree).length, 1);
  });

  // The race the grace period exists for: VS Code finishes restoring the
  // terminal *after* the extension has activated and asked for it.
  it('adopts a terminal restored after activation', async () => {
    await closeAllTerminals();
    const manager = make();

    const pending = manager.open(featureWorktree, { show: false });
    await delay(200);
    const restored = vscode.window.createTerminal({
      name: terminalName(featureWorktree),
      cwd: featureWorktree,
    });

    const opened = await pending;
    assert.strictEqual(opened, restored, 'did not adopt the restored terminal');
    assert.strictEqual(named(featureWorktree).length, 1, 'opened a duplicate terminal');
  });

  it('creates its own terminal when no restore arrives', async () => {
    await closeAllTerminals();
    const manager = make();

    const opened = await manager.open(featureWorktree, { show: false });
    assert.strictEqual(opened.name, terminalName(featureWorktree));
    assert.strictEqual(named(featureWorktree).length, 1);
  });

  it('skips the restore wait for a freshly created worktree', async () => {
    await closeAllTerminals();
    const manager = make();

    const started = Date.now();
    await manager.open(featureWorktree, { show: false, adopt: false });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 300, `waited ${elapsed}ms before opening a terminal`);
  });

  it('closes a worktree terminal on request', async () => {
    const manager = make();
    await manager.open(featureWorktree, { show: false });
    manager.close(featureWorktree);
    await delay(200);

    assert.strictEqual(named(featureWorktree).length, 0);
    assert.strictEqual(manager.get(featureWorktree), undefined);
  });
});
