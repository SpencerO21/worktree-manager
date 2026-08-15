import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface Worktree {
  /** Absolute path to the worktree's working directory. */
  path: string;
  /** Absolute path of the repository whose `git worktree list` reported this. */
  repoRoot: string;
  /** Short branch name, or undefined when detached. */
  branch?: string;
  head?: string;
  detached: boolean;
  /** True when the record describes a bare repository rather than a checkout. */
  bare: boolean;
  locked: boolean;
  /** Optional explanation recorded by `git worktree lock --reason`. */
  lockReason?: string;
  /** git considers the record stale — usually because the directory is gone. */
  prunable: boolean;
  /** git's own explanation for `prunable`, e.g. "gitdir file points to non-existent location". */
  prunableReason?: string;
  /** True for the repository's primary working tree (the one that owns .git). */
  isMain: boolean;
}

export interface GitDiagnosticEvent {
  args: string[];
  cwd?: string;
  durationMs: number;
  error?: string;
}

export type GitDiagnosticListener = (event: GitDiagnosticEvent) => void;

let diagnosticListener: GitDiagnosticListener | undefined;

/** Install the per-extension-host listener used by the TreeHugger output channel. */
export function setGitDiagnosticListener(listener: GitDiagnosticListener | undefined): void {
  diagnosticListener = listener;
}

export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Locate git repositories to interrogate: the given roots themselves, plus their
 * immediate children. One level is enough for the usual `~/projects/<repo>` layout
 * without turning discovery into a full-disk crawl.
 */
export async function findRepositories(roots: string[]): Promise<string[]> {
  const candidates = new Set<string>();

  await Promise.all(
    roots.map(async (raw) => {
      const root = path.resolve(expandHome(raw));
      if (await isGitDir(root)) {
        candidates.add(root);
      }
      let entries;
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        return;
      }
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isDirectory() || entry.name.startsWith('.')) {
            return;
          }
          const child = path.join(root, entry.name);
          if (await isGitDir(child)) {
            candidates.add(child);
          }
        }),
      );
    }),
  );

  return [...candidates];
}

async function isGitDir(dir: string): Promise<boolean> {
  try {
    await fsp.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

export interface ListWorktreeOptions {
  /**
   * Clear stale records as they are found. Deleting a worktree's directory by hand
   * leaves git still listing it forever; pruning is how git itself expects that to
   * be cleaned up, and doing it here is what keeps the view honest.
   */
  prune?: boolean;
}

/**
 * Every worktree reachable from the given repositories, de-duplicated by real path.
 * Repositories that share a worktree set (any two worktrees of the same repo) each
 * report the whole family, so dedup is what makes multi-root scanning cheap.
 */
export async function listWorktrees(
  repos: string[],
  options: ListWorktreeOptions = {},
): Promise<Worktree[]> {
  const byPath = new Map<string, Worktree>();

  const results = await Promise.all(
    repos.map(async (repo) => {
      let worktrees = await readWorktrees(repo);
      if (options.prune && worktrees.some((worktree) => worktree.prunable)) {
        // git only prunes what it already reported as prunable, and never a locked
        // worktree, so this cannot take out a tree that is merely inconvenient.
        if (await tryPrune(repo)) {
          worktrees = await readWorktrees(repo);
        }
      }
      return worktrees;
    }),
  );

  for (const worktree of results.flat()) {
    let key = worktree.path;
    try {
      key = await fsp.realpath(worktree.path);
    } catch {
      // Worktree directory is gone (prunable) — fall back to the reported path.
    }
    const existing = byPath.get(key);
    // Prefer the record from the repo that actually owns the worktree, and a live
    // record over a stale one (another repo may not have been pruned yet).
    if (!existing || (existing.prunable && !worktree.prunable) || (!existing.isMain && worktree.isMain)) {
      byPath.set(key, worktree);
    }
  }

  return [...byPath.values()].sort(compareWorktrees);
}

async function readWorktrees(repo: string): Promise<Worktree[]> {
  try {
    const stdout = await executeGit(repo, ['worktree', 'list', '--porcelain', '-z']);
    return parseWorktreePorcelain(stdout, repo);
  } catch {
    // Discovery is intentionally isolated per repository. The diagnostic listener
    // has the actionable failure; callers still receive every healthy repository.
    return [];
  }
}

/** `git worktree prune`, reporting whether it got the chance to do anything. */
export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune']);
}

async function tryPrune(repo: string): Promise<boolean> {
  try {
    await pruneWorktrees(repo);
    return true;
  } catch {
    return false;
  }
}

function compareWorktrees(a: Worktree, b: Worktree): number {
  if (a.isMain !== b.isMain) {
    return a.isMain ? -1 : 1;
  }
  return path.basename(a.path).localeCompare(path.basename(b.path));
}

/** Run git in `cwd`, throwing an Error carrying git's own stderr for display. */
export async function git(cwd: string, args: string[]): Promise<string> {
  return executeGit(cwd, args);
}

/** Git version used by the diagnostics report. */
export async function gitVersion(): Promise<string> {
  return (await executeGit(undefined, ['--version'])).trim();
}

async function executeGit(cwd: string | undefined, args: string[]): Promise<string> {
  const startedAt = Date.now();
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    diagnosticListener?.({ args: [...args], cwd, durationMs: Date.now() - startedAt });
    return stdout;
  } catch (error: any) {
    const failure = gitError(error, args);
    diagnosticListener?.({
      args: [...args],
      cwd,
      durationMs: Date.now() - startedAt,
      error: failure.message,
    });
    throw failure;
  }
}

function gitError(error: any, args: string[]): Error {
  const stderr = String(error?.stderr ?? '').trim();
  // Git reports progress on stderr too, so the diagnosis is the fatal/error line
  // rather than whatever happened to be printed first.
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const diagnostic = lines.filter((line) => /^(fatal|error|warning):/i.test(line));
  const detail = (diagnostic.length ? diagnostic : lines.slice(-1)).join('\n');
  return new Error(detail || String(error?.message ?? error) || `git ${args.join(' ')} failed`);
}

/**
 * The working-tree root containing `dir`, or undefined when it is not in a repo.
 * A linked worktree reports its own root, which is all `git worktree list` needs
 * to report the whole family.
 */
export async function repoRootFor(dir: string): Promise<string | undefined> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Short name of the checked-out branch, or undefined when HEAD is detached. */
export async function currentBranch(repo: string): Promise<string | undefined> {
  try {
    const name = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

export interface Branches {
  local: string[];
  remote: string[];
}

export interface LastCommit {
  at: number;
  subject: string;
}

export interface GitWorktreeHealth {
  changedFiles: number;
  stagedFiles: number;
  untrackedFiles: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
  lastCommit?: LastCommit;
  error?: string;
}

/** Fast, machine-readable Git state used by worktree rows and sorting. */
export async function worktreeGitHealth(worktreePath: string): Promise<GitWorktreeHealth> {
  const [status, lastCommit] = await Promise.allSettled([
    git(worktreePath, ['status', '--porcelain=v2', '--branch', '-z']),
    git(worktreePath, ['log', '-1', '--format=%ct%x00%s']),
  ]);

  const health = status.status === 'fulfilled'
    ? parseWorktreeStatus(status.value)
    : emptyGitHealth(status.reason);
  if (lastCommit.status === 'fulfilled') {
    health.lastCommit = parseLastCommit(lastCommit.value);
  }
  return health;
}

export function parseWorktreeStatus(stdout: string): GitWorktreeHealth {
  const health: GitWorktreeHealth = {
    changedFiles: 0,
    stagedFiles: 0,
    untrackedFiles: 0,
  };

  for (const field of stdout.split('\0')) {
    if (field.startsWith('# branch.upstream ')) {
      health.upstream = field.slice('# branch.upstream '.length);
      continue;
    }
    if (field.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(field);
      if (match) {
        health.ahead = Number(match[1]);
        health.behind = Number(match[2]);
      }
      continue;
    }
    if (field.startsWith('? ')) {
      health.untrackedFiles++;
      continue;
    }
    if (/^[12u] /.test(field)) {
      health.changedFiles++;
      const xy = field.slice(2, 4);
      if (xy[0] && xy[0] !== '.') {
        health.stagedFiles++;
      }
    }
  }
  return health;
}

function emptyGitHealth(error: unknown): GitWorktreeHealth {
  return {
    changedFiles: 0,
    stagedFiles: 0,
    untrackedFiles: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}

function parseLastCommit(stdout: string): LastCommit | undefined {
  const separator = stdout.indexOf('\0');
  if (separator === -1) {
    return undefined;
  }
  const seconds = Number(stdout.slice(0, separator));
  if (!Number.isFinite(seconds)) {
    return undefined;
  }
  return {
    at: seconds * 1000,
    subject: stdout.slice(separator + 1).replace(/[\r\n]+$/, ''),
  };
}

export async function listBranches(repo: string): Promise<Branches> {
  const read = async (pattern: string) => {
    try {
      const stdout = await git(repo, ['for-each-ref', '--format=%(refname:short)', pattern]);
      return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };
  const [local, remote] = await Promise.all([read('refs/heads'), read('refs/remotes')]);
  // `origin/HEAD` is a symref alias, never something to branch from directly.
  return { local, remote: remote.filter((r) => !r.endsWith('/HEAD')) };
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export interface AddWorktreeOptions {
  /** Where the new working tree is created. */
  path: string;
  branch: string;
  /** Starting point for a new branch. Ignored when checking out an existing one. */
  base?: string;
  /** False checks out `branch` as-is instead of creating it. */
  createBranch: boolean;
}

export async function addWorktree(repo: string, options: AddWorktreeOptions): Promise<void> {
  const args = ['worktree', 'add'];
  if (options.createBranch) {
    args.push('-b', options.branch, options.path);
    if (options.base) {
      args.push(options.base);
    }
  } else {
    args.push(options.path, options.branch);
  }
  await git(repo, args);
}

export async function removeWorktree(repo: string, worktreePath: string, force: boolean): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) {
    args.push('--force');
  }
  args.push(worktreePath);

  try {
    await git(repo, args);
    return;
  } catch (error) {
    // `git worktree remove` wants a working tree that is actually there; when the
    // directory has already been deleted by hand, some versions refuse outright
    // (notably with --force). Pruning reaches the same end state — git forgets it.
    if (await exists(worktreePath)) {
      throw error;
    }
    await pruneWorktrees(repo);
    if (await isRegistered(repo, worktreePath)) {
      throw error;
    }
  }
}

export async function lockWorktree(repo: string, worktreePath: string, reason?: string): Promise<void> {
  const args = ['worktree', 'lock'];
  if (reason?.trim()) {
    args.push('--reason', reason.trim());
  }
  args.push(worktreePath);
  await git(repo, args);
}

export async function unlockWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ['worktree', 'unlock', worktreePath]);
}

export async function moveWorktree(repo: string, worktreePath: string, destination: string): Promise<void> {
  await git(repo, ['worktree', 'move', worktreePath, destination]);
}

export async function repairWorktrees(repo: string, worktreePaths: string[]): Promise<string> {
  return git(repo, ['worktree', 'repair', ...worktreePaths]);
}

export async function worktreeHasSubmodules(worktreePath: string): Promise<boolean> {
  return exists(path.join(worktreePath, '.gitmodules'));
}

export async function deleteLocalBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-d', branch]);
}

export type SyncStrategy = 'rebase' | 'merge';

export interface SyncDivergence {
  ahead: number;
  behind: number;
}

export async function fetchRepository(repo: string): Promise<void> {
  await git(repo, ['fetch', '--all', '--prune']);
}

export async function syncDivergence(worktreePath: string, base: string): Promise<SyncDivergence> {
  const output = (await git(worktreePath, ['rev-list', '--left-right', '--count', `HEAD...${base}`])).trim();
  const match = /^(\d+)\s+(\d+)$/.exec(output);
  if (!match) {
    throw new Error(`Could not calculate divergence from ${base}`);
  }
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

export async function syncWorktree(
  worktreePath: string,
  base: string,
  strategy: SyncStrategy,
  autostash = false,
): Promise<void> {
  const args: string[] = [strategy];
  if (autostash) {
    args.push('--autostash');
  }
  args.push(base);
  await git(worktreePath, args);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Whether `git worktree list` still reports `worktreePath` for this repository. */
async function isRegistered(repo: string, worktreePath: string): Promise<boolean> {
  const wanted = path.resolve(worktreePath);
  return (await readWorktrees(repo)).some((worktree) => path.resolve(worktree.path) === wanted);
}

export function parseWorktreePorcelain(stdout: string, repoRoot: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  let first = true;

  const flush = () => {
    if (current) {
      worktrees.push(current);
      current = undefined;
    }
  };

  // `-z` makes every field NUL-delimited and inserts an empty field between
  // records. Keep newline support for callers parsing output from older code.
  const delimiter = stdout.includes('\0') ? '\0' : '\n';
  for (const rawField of stdout.split(delimiter)) {
    // `execFile` can preserve CRLF when parsing legacy, non-NUL output. Do not
    // trim any other whitespace: it may be part of a valid worktree path.
    const line = delimiter === '\n' && rawField.endsWith('\r')
      ? rawField.slice(0, -1)
      : rawField;
    if (line === '') {
      flush();
      continue;
    }
    const spaceAt = line.indexOf(' ');
    const key = spaceAt === -1 ? line : line.slice(0, spaceAt);
    const value = spaceAt === -1 ? '' : line.slice(spaceAt + 1);

    switch (key) {
      case 'worktree':
        flush();
        current = {
          path: value,
          repoRoot,
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
          isMain: first,
        };
        first = false;
        break;
      case 'HEAD':
        if (current) {
          current.head = value;
        }
        break;
      case 'branch':
        if (current) {
          current.branch = value.replace(/^refs\/heads\//, '');
        }
        break;
      case 'detached':
        if (current) {
          current.detached = true;
        }
        break;
      case 'bare':
        if (current) {
          current.bare = true;
        }
        break;
      case 'locked':
        if (current) {
          current.locked = true;
          current.lockReason = value || undefined;
        }
        break;
      case 'prunable':
        if (current) {
          current.prunable = true;
          current.prunableReason = value || undefined;
        }
        break;
    }
  }
  flush();

  // The first porcelain record is Git's primary worktree (or bare repository).
  // Use it as the stable family root even when discovery was initiated from a
  // linked worktree, so grouping and follow-up Git commands share one identity.
  const primaryPath = worktrees[0]?.path;
  if (primaryPath) {
    for (const worktree of worktrees) {
      worktree.repoRoot = primaryPath;
    }
  }

  return worktrees;
}
