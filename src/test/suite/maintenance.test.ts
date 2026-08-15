import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  listWorktrees,
  lockWorktree,
  moveWorktree,
  repairWorktrees,
  syncDivergence,
  syncWorktree,
  unlockWorktree,
  worktreeHasSubmodules,
} from '../../git';

describe('advanced worktree maintenance', () => {
  let fixture: string;
  let root: string;
  let linked: string;

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(async () => {
    fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'worktree-maintenance-'));
    root = path.join(fixture, 'main');
    linked = path.join(fixture, 'feature');
    await fsp.mkdir(root);
    run(root, 'init', '-q', '-b', 'main');
    run(root, 'config', 'user.email', 'tests@example.com');
    run(root, 'config', 'user.name', 'TreeHugger Tests');
    await fsp.writeFile(path.join(root, 'shared.txt'), 'initial\n');
    run(root, 'add', 'shared.txt');
    run(root, 'commit', '-q', '-m', 'initial');
    run(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
  });

  afterEach(async () => {
    await fsp.rm(fixture, { recursive: true, force: true });
  });

  it('locks with a persistent reason and unlocks again', async () => {
    await lockWorktree(root, linked, 'keep for release validation');
    let worktree = (await listWorktrees([root])).find((candidate) => candidate.branch === 'feature');

    assert.strictEqual(worktree?.locked, true);
    assert.strictEqual(worktree?.lockReason, 'keep for release validation');

    await unlockWorktree(root, linked);
    worktree = (await listWorktrees([root])).find((candidate) => candidate.branch === 'feature');
    assert.strictEqual(worktree?.locked, false);
  });

  it('moves and repairs linked worktree administration', async () => {
    const moved = path.join(fixture, 'moved-by-git');
    await moveWorktree(root, linked, moved);
    assert.ok((await listWorktrees([root])).some((candidate) => candidate.branch === 'feature' && path.basename(candidate.path) === 'moved-by-git'));

    const movedByHand = path.join(fixture, 'moved-by-hand');
    await fsp.rename(moved, movedByHand);
    await repairWorktrees(root, [movedByHand]);
    assert.ok((await listWorktrees([root])).some((candidate) => candidate.branch === 'feature' && path.basename(candidate.path) === 'moved-by-hand'));
  });

  it('detects the submodule restriction before a move', async () => {
    assert.strictEqual(await worktreeHasSubmodules(linked), false);
    await fsp.writeFile(path.join(linked, '.gitmodules'), '[submodule "demo"]\n');
    assert.strictEqual(await worktreeHasSubmodules(linked), true);
  });

  it('previews and rebases a worktree that is behind its base', async () => {
    await fsp.writeFile(path.join(root, 'base.txt'), 'from main\n');
    run(root, 'add', 'base.txt');
    run(root, 'commit', '-q', '-m', 'advance main');

    assert.deepStrictEqual(await syncDivergence(linked, 'main'), { ahead: 0, behind: 1 });
    await syncWorktree(linked, 'main', 'rebase');
    assert.deepStrictEqual(await syncDivergence(linked, 'main'), { ahead: 0, behind: 0 });
  });

  it('requires explicit autostash support to preserve dirty changes', async () => {
    await fsp.writeFile(path.join(linked, 'shared.txt'), 'dirty worktree\n');
    await fsp.writeFile(path.join(root, 'base.txt'), 'advance\n');
    run(root, 'add', 'base.txt');
    run(root, 'commit', '-q', '-m', 'advance main');

    await syncWorktree(linked, 'main', 'rebase', true);

    assert.strictEqual(await fsp.readFile(path.join(linked, 'shared.txt'), 'utf8'), 'dirty worktree\n');
    assert.match(run(linked, 'status', '--porcelain'), /shared\.txt/);
  });

  it('leaves a normal abortable state when a rebase conflicts', async () => {
    await fsp.writeFile(path.join(linked, 'shared.txt'), 'feature\n');
    run(linked, 'add', 'shared.txt');
    run(linked, 'commit', '-q', '-m', 'feature change');
    await fsp.writeFile(path.join(root, 'shared.txt'), 'main\n');
    run(root, 'add', 'shared.txt');
    run(root, 'commit', '-q', '-m', 'main change');

    await assert.rejects(syncWorktree(linked, 'main', 'rebase'), /conflict|could not apply/i);
    assert.strictEqual(await fsp.stat(path.join(linked, '.git')).then(() => true), true);
    run(linked, 'rebase', '--abort');
    assert.strictEqual(run(linked, 'status', '--porcelain'), '');
  });
});
