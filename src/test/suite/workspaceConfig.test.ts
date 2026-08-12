import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  loadWorkspaceConfig,
  resolveLifecycle,
  workspaceEnvironment,
} from '../../workspaceConfig';

describe('worktree lifecycle configuration', () => {
  let fixture: string;
  let root: string;
  let worktree: string;

  beforeEach(async () => {
    fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'worktree-manager-config-'));
    root = path.join(fixture, 'main');
    worktree = path.join(fixture, 'feature-one');
    await Promise.all([
      fsp.mkdir(root, { recursive: true }),
      fsp.mkdir(worktree, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await fsp.rm(fixture, { recursive: true, force: true });
  });

  async function write(relative: string, contents: string, base = worktree): Promise<void> {
    const file = path.join(base, relative);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, contents);
  }

  it('loads Worktrees configuration and resolves its cwd', async () => {
    await write(
      '.worktrees/config.json',
      JSON.stringify({ setup: ['npm install'], run: ['npm run dev'], cwd: 'apps/web' }),
    );

    const config = await loadWorkspaceConfig(worktree, root);
    const run = await resolveLifecycle('run', worktree, root);

    assert.deepStrictEqual(config.setup, ['npm install']);
    assert.deepStrictEqual(run.commands, ['npm run dev']);
    assert.strictEqual(run.cwd, path.join(worktree, 'apps/web'));
  });

  it('uses an existing Superset config from the primary checkout', async () => {
    await write(
      '.superset/config.json',
      JSON.stringify({ setup: ['pnpm install'], run: ['pnpm dev'] }),
      root,
    );

    const setup = await resolveLifecycle('setup', worktree, root);

    assert.deepStrictEqual(setup.commands, ['pnpm install']);
    assert.strictEqual(setup.config.source, path.join(root, '.superset/config.json'));
  });

  it('uses lifecycle shell scripts when a command array is omitted', async () => {
    await write('.worktrees/setup.sh', '#!/bin/sh\ntrue\n', root);

    const setup = await resolveLifecycle('setup', worktree, root);

    assert.strictEqual(setup.commands.length, 1);
    assert.match(setup.commands[0], /^bash /);
    assert.match(setup.commands[0], /\.worktrees\/setup\.sh/);
  });

  it('infers the package manager dev command when run is omitted', async () => {
    await write('package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
    await write('pnpm-lock.yaml', 'lockfileVersion: 9\n');

    const run = await resolveLifecycle('run', worktree, root);

    assert.deepStrictEqual(run.commands, ['pnpm dev']);
  });

  it('treats an explicit empty run array as disabled', async () => {
    await write('.worktrees/config.json', JSON.stringify({ run: [] }));
    await write('package.json', JSON.stringify({ scripts: { dev: 'vite' } }));

    const run = await resolveLifecycle('run', worktree, root);

    assert.deepStrictEqual(run.commands, []);
  });

  it('provides native and Superset-compatible environment variables', () => {
    const env = workspaceEnvironment(worktree, root);

    assert.strictEqual(env.WORKTREE_ROOT_PATH, root);
    assert.strictEqual(env.WORKTREE_WORKSPACE_NAME, 'feature-one');
    assert.strictEqual(env.WORKTREE_WORKSPACE_PATH, worktree);
    assert.strictEqual(env.SUPERSET_ROOT_PATH, root);
    assert.strictEqual(env.SUPERSET_WORKSPACE_NAME, 'feature-one');
    assert.strictEqual(env.SUPERSET_WORKSPACE_PATH, worktree);
  });

  it('reports malformed command arrays with the config path', async () => {
    await write('.worktrees/config.json', JSON.stringify({ setup: 'npm install' }));

    await assert.rejects(
      loadWorkspaceConfig(worktree, root),
      /`setup`.*\.worktrees\/config\.json.*array of shell commands/,
    );
  });
});
