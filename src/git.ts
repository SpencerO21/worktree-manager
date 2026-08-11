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
  locked: boolean;
  prunable: boolean;
  /** True for the repository's primary working tree (the one that owns .git). */
  isMain: boolean;
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

/**
 * Every worktree reachable from the given repositories, de-duplicated by real path.
 * Repositories that share a worktree set (any two worktrees of the same repo) each
 * report the whole family, so dedup is what makes multi-root scanning cheap.
 */
export async function listWorktrees(repos: string[]): Promise<Worktree[]> {
  const byPath = new Map<string, Worktree>();

  const results = await Promise.all(
    repos.map(async (repo) => {
      try {
        const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
          cwd: repo,
          maxBuffer: 8 * 1024 * 1024,
        });
        return parseWorktreePorcelain(stdout, repo);
      } catch {
        return [] as Worktree[];
      }
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
    // Prefer the record from the repo that actually owns the worktree.
    if (!existing || (!existing.isMain && worktree.isMain)) {
      byPath.set(key, worktree);
    }
  }

  return [...byPath.values()].sort(compareWorktrees);
}

function compareWorktrees(a: Worktree, b: Worktree): number {
  if (a.isMain !== b.isMain) {
    return a.isMain ? -1 : 1;
  }
  return path.basename(a.path).localeCompare(path.basename(b.path));
}

/** Run git in `cwd`, throwing an Error carrying git's own stderr for display. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (error: any) {
    const stderr = String(error?.stderr ?? '').trim();
    // git reports progress on stderr too, so the diagnosis is the fatal/error line
    // rather than whatever happened to be printed first.
    const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
    const diagnostic = lines.filter((line) => /^(fatal|error|warning):/i.test(line));
    const detail = (diagnostic.length ? diagnostic : lines.slice(-1)).join('\n');
    throw new Error(detail || String(error?.message ?? error) || `git ${args.join(' ')} failed`);
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
  await git(repo, args);
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

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
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
      case 'locked':
        if (current) {
          current.locked = true;
        }
        break;
      case 'prunable':
        if (current) {
          current.prunable = true;
        }
        break;
    }
  }
  flush();

  return worktrees;
}
