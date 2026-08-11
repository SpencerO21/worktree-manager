import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

function initRepo(dir: string): (args: string[]) => string {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  return git;
}

/**
 * `demo` with a second worktree, plus an unrelated `other` repository alongside
 * it — so scoping to the open repository is distinguishable from scanning the
 * whole search path.
 */
function buildFixture(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fixture-'));
  const projects = path.join(root, 'projects');

  const repo = path.join(projects, 'demo');
  const git = initRepo(repo);
  git(['worktree', 'add', '-b', 'feature/x', path.join(projects, 'demo-feature-x')]);

  initRepo(path.join(projects, 'other'));

  return { root, repo };
}

/** Prefer the locally installed VS Code over downloading another copy. */
function installedVSCode(): string | undefined {
  const candidates = [
    '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/MacOS/Code'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Running the tests from a terminal inside VS Code inherits that instance's
 * environment. ELECTRON_RUN_AS_NODE makes the test instance boot as plain node,
 * and VSCODE_IPC_HOOK would hand our launch to the editor already running.
 */
function unsetInheritedVSCodeEnv(): void {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VSCODE_')) {
      delete process.env[key];
    }
  }
}

async function main(): Promise<void> {
  unsetInheritedVSCodeEnv();
  const fixture = buildFixture();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-userdata-'));

  try {
    await runTests({
      vscodeExecutablePath: installedVSCode(),
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, './suite/index'),
      extensionTestsEnv: {
        WT_FIXTURE_ROOT: fixture.root,
        WT_FIXTURE_REPO: fixture.repo,
      },
      launchArgs: [
        fixture.repo,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--user-data-dir',
        userDataDir,
      ],
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Integration tests failed:', error);
  process.exit(1);
});
