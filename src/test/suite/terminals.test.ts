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

  // Terminals from earlier suites linger until VS Code finishes disposing them.
  beforeEach(closeAllTerminals);

  afterEach(async () => {
    while (managers.length) {
      managers.pop()?.dispose();
    }
    await closeAllTerminals();
  });

  it('opens a terminal rooted in the worktree', () => {
    const terminal = make().open(featureWorktree, { show: false });

    assert.strictEqual(terminal.name, terminalName(featureWorktree));
    assert.strictEqual(named(featureWorktree).length, 1);

    const cwd = (terminal.creationOptions as vscode.TerminalOptions).cwd;
    assert.strictEqual(cwd, featureWorktree);
  });

  it('reveals the same terminal instead of opening a second one', () => {
    const manager = make();
    const first = manager.open(featureWorktree, { show: false });
    const second = manager.open(featureWorktree, { show: false });

    assert.strictEqual(second, first);
    assert.strictEqual(named(featureWorktree).length, 1);
  });

  it('keeps worktrees on separate terminals', () => {
    const manager = make();
    const feature = manager.open(featureWorktree, { show: false });
    const main = manager.open(mainWorktree, { show: false });

    assert.notStrictEqual(feature, main);
    assert.strictEqual(named(featureWorktree).length, 1);
    assert.strictEqual(named(mainWorktree).length, 1);
  });

  it('runs launched commands in the worktree terminal', () => {
    const manager = make();
    const opened = manager.open(featureWorktree, { show: false });
    const used = manager.run(featureWorktree, 'true');

    assert.strictEqual(used, opened);
    assert.strictEqual(named(featureWorktree).length, 1);
  });

  it('leaves terminals it did not open alone', () => {
    const stranger = vscode.window.createTerminal({
      name: terminalName(featureWorktree),
      cwd: featureWorktree,
    });
    const manager = make();

    assert.strictEqual(manager.get(featureWorktree), undefined);
    assert.notStrictEqual(manager.open(featureWorktree, { show: false }), stranger);
  });

  it('closes a worktree terminal on request', async () => {
    const manager = make();
    manager.open(featureWorktree, { show: false });
    manager.close(featureWorktree);
    await delay(200);

    assert.strictEqual(named(featureWorktree).length, 0);
    assert.strictEqual(manager.get(featureWorktree), undefined);
  });
});
