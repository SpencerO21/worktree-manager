import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  addWorktree,
  branchExists,
  currentBranch,
  expandHome,
  listBranches,
  Worktree,
} from './git';

export interface RepoChoice {
  /** Primary working tree of the repository — the cwd git commands run in. */
  root: string;
  name: string;
}

/** One entry per repository, derived from the worktrees already on screen. */
export function reposFromWorktrees(worktrees: Worktree[]): RepoChoice[] {
  const byRoot = new Map<string, RepoChoice>();
  for (const worktree of worktrees) {
    const root = worktree.isMain ? worktree.path : worktree.repoRoot;
    const resolved = path.resolve(root);
    if (!byRoot.has(resolved)) {
      byRoot.set(resolved, { root: resolved, name: path.basename(resolved) });
    }
  }
  return [...byRoot.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Branch names become directory names, so `feature/x` has to flatten to `feature-x`. */
function slugify(branch: string): string {
  return branch.replace(/[\\/\s]+/g, '-').replace(/^-+|-+$/g, '');
}

export function resolveWorktreePath(template: string, repo: RepoChoice, branch: string): string {
  const filled = template
    .replace(/\{repoPath\}/g, repo.root)
    .replace(/\{repoParent\}/g, path.dirname(repo.root))
    .replace(/\{repoName\}/g, repo.name)
    .replace(/\{branch\}/g, slugify(branch));
  return path.resolve(expandHome(filled));
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function pickRepo(repos: RepoChoice[]): Promise<RepoChoice | undefined> {
  if (repos.length <= 1) {
    return repos[0];
  }
  const picked = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: repo.name, description: repo.root, repo })),
    { title: 'New Worktree', placeHolder: 'Which repository?' },
  );
  return picked?.repo;
}

async function pickBase(repo: RepoChoice, branch: string): Promise<string | undefined> {
  const [{ local, remote }, head] = await Promise.all([
    listBranches(repo.root),
    currentBranch(repo.root),
  ]);

  const items: Array<vscode.QuickPickItem & { ref: string }> = [];
  const branchIcon = new vscode.ThemeIcon('git-branch');
  if (head) {
    items.push({ label: head, description: 'current branch', ref: head, iconPath: branchIcon });
  }
  for (const name of local) {
    if (name !== head) {
      items.push({ label: name, ref: name, iconPath: branchIcon });
    }
  }
  for (const name of remote) {
    items.push({
      label: name,
      description: 'remote',
      ref: name,
      iconPath: new vscode.ThemeIcon('cloud'),
    });
  }
  if (items.length === 0) {
    return 'HEAD';
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `New Worktree — branch off for ${branch}`,
    placeHolder: 'Start the new branch from…',
    matchOnDescription: true,
  });
  return picked?.ref;
}

/**
 * Prompt for a branch, a starting point and a location, then `git worktree add`.
 * Returns the new worktree's path, or undefined if the user backed out.
 */
export async function createWorktree(worktrees: Worktree[]): Promise<string | undefined> {
  const repos = reposFromWorktrees(worktrees);
  if (repos.length === 0) {
    void vscode.window.showErrorMessage(
      'Worktree Manager found no git repositories. Add one to this window or to the worktreeManager.searchPaths setting.',
    );
    return undefined;
  }

  const repo = await pickRepo(repos);
  if (!repo) {
    return undefined;
  }

  const branch = (
    await vscode.window.showInputBox({
      title: `New Worktree in ${repo.name}`,
      prompt: 'Branch name — an existing branch is checked out, a new one is created',
      placeHolder: 'feature/my-change',
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Enter a branch name';
        }
        if (/[\s~^:?*[\\]/.test(trimmed) || trimmed.includes('..')) {
          return 'Not a valid branch name';
        }
        return undefined;
      },
    })
  )?.trim();
  if (!branch) {
    return undefined;
  }

  const reuseBranch = await branchExists(repo.root, branch);
  let base: string | undefined;
  if (!reuseBranch) {
    base = await pickBase(repo, branch);
    if (!base) {
      return undefined;
    }
  }

  const template = vscode.workspace
    .getConfiguration('worktreeManager')
    .get<string>('newWorktreePath', '~/projects/{repoName}-{branch}');

  const target = await vscode.window.showInputBox({
    title: 'New Worktree — location',
    prompt: 'Directory for the new working tree',
    value: resolveWorktreePath(template, repo, branch),
    valueSelection: undefined,
    validateInput: async (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Enter a directory';
      }
      if (!path.isAbsolute(expandHome(trimmed))) {
        return 'Enter an absolute path';
      }
      return (await exists(expandHome(trimmed))) ? 'That directory already exists' : undefined;
    },
  });
  if (!target) {
    return undefined;
  }
  const worktreePath = path.resolve(expandHome(target.trim()));

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree ${branch}…` },
      () =>
        addWorktree(repo.root, {
          path: worktreePath,
          branch,
          base,
          createBranch: !reuseBranch,
        }),
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`git worktree add failed: ${(error as Error).message}`);
    return undefined;
  }

  return worktreePath;
}
