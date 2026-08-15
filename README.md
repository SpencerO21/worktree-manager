# TreeHugger - Worktree Manager

A VS Code extension that lists the git worktrees of the repository you are working in and
opens each one in its own window with a click.

## Features

- **The worktrees of this repository.** Discovered from the folder open in the window, whether
  that folder is the main working tree or a linked one. The globe button in the view title
  widens the list to every repository under `worktreeManager.searchPaths`; the filter button
  narrows it back.
- **Click to open.** Clicking a worktree opens it in a new window, leaving your current editors,
  terminals, and agents untouched. To replace the folder in the current window instead,
  right-click the worktree and specifically choose **Open in This Window**.
- **See which windows are open.** A worktree that is open in any VS Code window gets a green
  open-folder icon and an `open` label; the worktree in the active window is labeled `current`.
- **See what needs attention.** Rows summarize dirty files, upstream divergence, setup problems,
  and running apps or agents. Tooltips include staged/untracked counts and the latest commit.
- **Stay organized at scale.** The all-repositories view groups worktrees by repository. Filter by
  operational state, sort by name/activity/status, and pin the worktrees or repositories you use
  most often.
- **New worktree in a few keystrokes.** The `+` button asks for a branch (existing branches are
  checked out, new ones are created off a base you pick), proposes a directory from
  `worktreeManager.newWorktreePath`, runs `git worktree add`, then opens it in a new window so
  the window you started from is left as it was.
- **Start from the task.** Paste an issue or pull-request URL, or describe the work. TreeHugger
  proposes an editable branch name, creates and sets up the worktree, then can open it, run the
  app, and launch Codex or Claude Code with the task prompt.
- **Keep local configuration.** Files matched by VS Code's `git.worktreeIncludeFiles` setting are
  copied from the primary checkout after creation, including ignored `.env` files and tool caches.
- **Use VS Code's Git UI.** A worktree can be revealed in Source Control, and supported VS Code
  versions can hand off change migration to the built-in Git worktree command.
- **Terminals only when you ask.** Nothing is opened automatically. `Open Terminal` gives a
  worktree a terminal without switching the window, and starting an agent runs in it.
- **Setup once, run with one click.** A repository can commit setup, teardown, and run commands.
  New worktrees are initialized automatically; the play button starts the app in a dedicated
  terminal and reveals that terminal instead of accidentally starting a duplicate.
- **Project-owned ports.** Setup scripts receive the primary checkout and worktree paths, so a
  project can allocate stable ports and write worktree-local environment files before the app
  starts. Existing Superset lifecycle configurations work without modification.
- **Agent chats.** Each worktree lists its recent Claude Code and Codex sessions; clicking one
  opens the worktree in a new window and resumes the chat there.
- **Runtime control center.** Declared local services appear below each worktree with ports,
  clickable URLs, and optional health checks. TreeHugger-managed apps can be revealed, restarted,
  or stopped without affecting another worktree.
- **Live agents.** Active TreeHugger-launched agents are visually distinct from chat history and
  can be focused or stopped. Optional initial prompts are passed through the terminal environment,
  so prompt text is never interpolated into a shell command.
- **Deleted worktrees stay deleted.** Removing a worktree's directory by hand leaves git still
  listing it; the view runs `git worktree prune` when it finds such a record, so those rows go
  away on their own. With `worktreeManager.pruneMissingWorktrees` turned off they are kept and
  marked `missing`, with a trash button on the row and a button in the view title that clears
  all of them at once. The list also refreshes itself when the view comes back into view.

## Commands

| Command | What it does |
| --- | --- |
| `Worktrees: New Worktree` | Create a worktree and open it in a new window |
| `Worktrees: Start Task in New Worktree` | Derive an editable branch from a task, create and set up the worktree, then choose launch actions |
| `Worktrees: Switch Worktree` | Quick pick over the listed worktrees |
| `Worktrees: Open Terminal` | Terminal for a worktree, without switching the window |
| `Worktrees: Run App` | Run the repository's configured app command in a dedicated terminal |
| `Worktrees: Setup Worktree` | Re-run setup for an existing worktree |
| `Worktrees: Remove Worktree` | `git worktree remove`, after a confirmation (branch is kept) |
| `Worktrees: Remove Missing Worktrees` | Clear git's record of every worktree whose directory is gone |
| `Worktrees: Start Claude Code Here` / `Start Codex Here` | Launch an agent in the worktree |
| `Worktrees: Show Diagnostics` | Open a sanitized report of discovery roots, lifecycle config sources, Git commands, failures, and timings |
| `Worktrees: Filter Worktrees` / `Clear Worktree Filter` | Narrow the tree to open, dirty, running, missing, or stale worktrees |
| `Worktrees: Toggle Pin` | Keep a worktree or repository above its siblings |
| `Worktrees: Reveal in Source Control` | Open VS Code's Source Control view for a worktree |
| `Worktrees: Migrate Worktree Changes with VS Code` | Hand off uncommitted-change migration to VS Code's built-in Git command when available |
| `Worktrees: Reveal App Terminal` / `Restart App` / `Stop App` | Control only the selected worktree's managed app terminals |
| `Worktrees: Focus Active Agent` / `Stop Active Agent` | Control a TreeHugger-launched agent terminal |
| `Worktrees: Open Service` | Open a configured local service URL |

A status bar entry shows the current worktree and opens the switcher.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `worktreeManager.scope` | `currentRepository` | List this repository's worktrees, or every one under the search paths |
| `worktreeManager.searchPaths` | `["~/projects"]` | Directories scanned one level deep for repos, when scope is `searchPaths` |
| `worktreeManager.revealViewOnSwitch` | `true` | Reopen the Worktrees view after the window reloads |
| `worktreeManager.newWorktreePath` | `~/projects/{repoName}-{branch}` | Proposed location for new worktrees |
| `worktreeManager.pruneMissingWorktrees` | `true` | Prune worktrees whose directory no longer exists instead of listing them |
| `worktreeManager.filter` | `all` | Show all worktrees or only one operational state |
| `worktreeManager.sortBy` | `name` | Sort worktrees by name, recent commit activity, or status |
| `worktreeManager.showSessions` | `true` | List agent chats under each worktree |
| `worktreeManager.claudeCommand` / `codexCommand` | `claude` / `codex` | Agent launch commands |

## Automatic worktree setup and local apps

Commit `.worktrees/config.json` to tell TreeHugger how to prepare, run, and clean up every
worktree:

```json
{
  "setup": [
    "npm install",
    "./scripts/setup-worktree-ports.sh --path ."
  ],
  "teardown": [
    "./scripts/release-worktree-ports.sh"
  ],
  "run": [
    "npm run dev"
  ]
}
```

Services and their worktree-local environment inputs can be declared alongside the lifecycle
commands:

```json
{
  "environment": {
    "files": [".env", ".env.ports"],
    "secrets": ["ADMIN_TOKEN"]
  },
  "services": [
    {
      "name": "Web",
      "url": "http://localhost:${PORT}",
      "healthcheck": "/health"
    }
  ]
}
```

TreeHugger reads declared environment files only to resolve service URLs. A URL referencing a key
listed under `environment.secrets` is hidden completely. Health checks are limited to localhost
and use a short timeout.

- `setup` commands run in order after **New Worktree**. **Run App** also ensures setup has
  completed, which makes existing worktrees just as easy to start. Successful setup is remembered
  until the configured commands or working directory change. Use **Setup Worktree** to force it to
  run again.
- Each `run` command starts in its own dedicated app terminal. Clicking **Run App** again reveals
  the existing app instead of starting another copy.
- `teardown` commands run before a worktree is removed. If teardown fails, TreeHugger keeps
  the worktree unless you explicitly choose **Remove Anyway**.
- `cwd` optionally runs every command below a subdirectory, such as `"cwd": "apps/web"`.
- An explicit empty array disables that lifecycle action. If `run` is omitted, TreeHugger
  looks for `.worktrees/run.sh`, then falls back to a `dev` or `start` package script and detects
  npm, pnpm, Yarn, or Bun from the lockfile.
- Instead of arrays, a repository can provide `.worktrees/setup.sh`, `teardown.sh`, or `run.sh` as
  a fallback. Complex environment and port allocation logic is usually easier to maintain in
  these scripts.

Every lifecycle command and app terminal receives:

| Variable | Meaning |
| --- | --- |
| `WORKTREE_ROOT_PATH` | Primary checkout for the repository |
| `WORKTREE_WORKSPACE_PATH` | Working directory of the selected worktree |
| `WORKTREE_WORKSPACE_NAME` | Directory name of the selected worktree |

### Avoiding local port conflicts

Frameworks disagree about how ports are configured, so TreeHugger leaves the allocation
policy with the repository. Put that policy in an idempotent setup script and write the selected
ports into worktree-local `.env` files. A typical script keeps a small registry outside the
repository, assigns each worktree an index, derives service ports from base ports plus that index,
and releases the assignment during teardown. The example above then makes the entire flow:

1. Create a worktree.
2. Setup installs dependencies and assigns its ports automatically.
3. Click the play button beside the worktree to start the app.

Do not edit a shared or symlinked `.env` in place. Copy it into the new worktree before applying
port changes so one worktree cannot change another's environment.

### Superset compatibility

Repositories already using Superset do not need a second configuration. When
`.worktrees/config.json` is absent, TreeHugger reads `.superset/config.json` and the
`.superset/setup.sh`, `teardown.sh`, and `run.sh` fallbacks. It also provides the compatible
`SUPERSET_ROOT_PATH`, `SUPERSET_WORKSPACE_PATH`, and `SUPERSET_WORKSPACE_NAME` variables.

For example, an existing Superset configuration can install dependencies, copy untracked
environment files from `SUPERSET_ROOT_PATH`, and run a per-worktree port allocator. **New
Worktree** followed by **Run App** uses that setup unchanged. If the config omits `run`, Spencer's
Worktree Manager detects a conventional root `dev` or `start` script automatically.

## Development

```sh
npm install
npm run watch     # esbuild in watch mode
npm test          # integration tests in a real VS Code instance
```

Press `F5` to launch the Extension Development Host. `npm run compile` typechecks,
`npm run package` builds a `.vsix`.

## Install a build

Grab the `.vsix` from the [latest release](https://github.com/SpencerO21/worktree-manager/releases/latest)
and install it — it is self-contained, so there is nothing to build:

```sh
code --install-extension spencers-worktree-manager-0.0.9.vsix
```

Reload the window afterwards.

## License

[MIT](LICENSE).
