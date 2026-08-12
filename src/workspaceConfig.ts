import * as fsp from 'fs/promises';
import * as path from 'path';

export type LifecycleKind = 'setup' | 'teardown' | 'run';

export interface WorkspaceConfig {
  setup?: string[];
  teardown?: string[];
  run?: string[];
  cwd?: string;
  /** The config file that supplied these values, when one exists. */
  source?: string;
}

export interface ResolvedLifecycle {
  commands: string[];
  cwd: string;
  config: WorkspaceConfig;
}

const CONFIG_DIRS = ['.worktrees', '.superset'] as const;

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function firstFile(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function configCandidates(worktreePath: string, rootPath: string): string[] {
  const roots = [path.resolve(worktreePath)];
  if (path.resolve(rootPath) !== roots[0]) {
    roots.push(path.resolve(rootPath));
  }

  // Prefer the Worktrees-native name, but make existing Superset projects work
  // without asking the team to maintain two copies of the same configuration.
  return CONFIG_DIRS.flatMap((directory) =>
    roots.map((root) => path.join(root, directory, 'config.json')),
  );
}

function parseCommands(value: unknown, key: LifecycleKind, source: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((command) => typeof command !== 'string')) {
    throw new Error(`\`${key}\` in ${source} must be an array of shell commands`);
  }
  return value as string[];
}

/** Load the first project lifecycle config visible to this worktree. */
export async function loadWorkspaceConfig(
  worktreePath: string,
  rootPath: string,
): Promise<WorkspaceConfig> {
  const source = await firstFile(configCandidates(worktreePath, rootPath));
  if (!source) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(source, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${source}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }

  const raw = parsed as Record<string, unknown>;
  if (raw.cwd !== undefined && typeof raw.cwd !== 'string') {
    throw new Error(`\`cwd\` in ${source} must be a string`);
  }

  return {
    setup: parseCommands(raw.setup, 'setup', source),
    teardown: parseCommands(raw.teardown, 'teardown', source),
    run: parseCommands(raw.run, 'run', source),
    cwd: raw.cwd as string | undefined,
    source,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function fallbackScript(
  kind: LifecycleKind,
  worktreePath: string,
  rootPath: string,
): Promise<string | undefined> {
  const roots = [path.resolve(worktreePath)];
  if (path.resolve(rootPath) !== roots[0]) {
    roots.push(path.resolve(rootPath));
  }
  const script = await firstFile(
    CONFIG_DIRS.flatMap((directory) =>
      roots.map((root) => path.join(root, directory, `${kind}.sh`)),
    ),
  );
  return script ? `bash ${shellQuote(script)}` : undefined;
}

async function packageManager(cwd: string, worktreePath: string): Promise<string> {
  const roots = [cwd, worktreePath].filter(
    (candidate, index, values) => values.indexOf(candidate) === index,
  );
  const lockfiles: Array<[string, string]> = [
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];
  for (const [lockfile, manager] of lockfiles) {
    if (await firstFile(roots.map((root) => path.join(root, lockfile)))) {
      return manager;
    }
  }
  return 'npm';
}

async function inferredRunCommand(cwd: string, worktreePath: string): Promise<string | undefined> {
  const packageFile = path.join(cwd, 'package.json');
  if (!(await isFile(packageFile))) {
    return undefined;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(await fsp.readFile(packageFile, 'utf8'));
  } catch {
    return undefined;
  }
  const script = typeof parsed?.scripts?.dev === 'string'
    ? 'dev'
    : typeof parsed?.scripts?.start === 'string'
      ? 'start'
      : undefined;
  if (!script) {
    return undefined;
  }

  const manager = await packageManager(cwd, worktreePath);
  if (manager === 'npm' && script === 'start') {
    return 'npm start';
  }
  return `${manager} ${manager === 'bun' ? 'run ' : ''}${script}`;
}

/** Resolve configured commands, script fallbacks, and the conventional dev-script fallback. */
export async function resolveLifecycle(
  kind: LifecycleKind,
  worktreePath: string,
  rootPath: string,
): Promise<ResolvedLifecycle> {
  const config = await loadWorkspaceConfig(worktreePath, rootPath);
  const cwd = path.resolve(worktreePath, config.cwd || '.');

  let commands = config[kind];
  if (commands === undefined) {
    const script = await fallbackScript(kind, worktreePath, rootPath);
    commands = script ? [script] : [];
  }
  if (kind === 'run' && commands.length === 0 && config.run === undefined) {
    const inferred = await inferredRunCommand(cwd, worktreePath);
    if (inferred) {
      commands = [inferred];
    }
  }

  return { commands, cwd, config };
}

/** Variables available to every lifecycle command and app terminal. */
export function workspaceEnvironment(
  worktreePath: string,
  rootPath: string,
): Record<string, string> {
  const workspacePath = path.resolve(worktreePath);
  const root = path.resolve(rootPath);
  const name = path.basename(workspacePath) || workspacePath;

  return {
    WORKTREE_ROOT_PATH: root,
    WORKTREE_WORKSPACE_NAME: name,
    WORKTREE_WORKSPACE_PATH: workspacePath,
    // Compatibility aliases let projects already configured for Superset use
    // this extension without duplicate setup files.
    SUPERSET_ROOT_PATH: root,
    SUPERSET_WORKSPACE_NAME: name,
    SUPERSET_WORKSPACE_PATH: workspacePath,
  };
}
