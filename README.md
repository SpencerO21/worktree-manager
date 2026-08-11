# Worktree Manager

A VS Code extension that lists the git worktrees of the repository you are working in and
switches the current window between them with a click.

## Features

- **The worktrees of this repository.** Discovered from the folder open in the window, whether
  that folder is the main working tree or a linked one. The globe button in the view title
  widens the list to every repository under `worktreeManager.searchPaths`; the filter button
  narrows it back.
- **Click to switch.** Clicking a worktree points this window at it. VS Code has no way to
  change a window's folder without reloading it, so the window does reload — the extension
  hands the switch to the next activation, which brings the Worktrees view back up.
- **New worktree in a few keystrokes.** The `+` button asks for a branch (existing branches are
  checked out, new ones are created off a base you pick), proposes a directory from
  `worktreeManager.newWorktreePath`, runs `git worktree add`, then switches to it.
- **Terminals only when you ask.** Nothing is opened automatically. `Open Terminal` gives a
  worktree a terminal without switching the window, and starting an agent runs in it.
- **Agent chats.** Each worktree lists its recent Claude Code and Codex sessions; clicking one
  switches to the worktree and resumes the chat there.
- **Deleted worktrees stay deleted.** Removing a worktree's directory by hand leaves git still
  listing it; the view runs `git worktree prune` when it finds such a record, so those rows go
  away on their own. With `worktreeManager.pruneMissingWorktrees` turned off they are kept and
  marked `missing`, with a trash button on the row and a button in the view title that clears
  all of them at once. The list also refreshes itself when the view comes back into view.

## Commands

| Command | What it does |
| --- | --- |
| `Worktrees: New Worktree` | Create a worktree and switch to it |
| `Worktrees: Switch Worktree` | Quick pick over the listed worktrees |
| `Worktrees: Open Terminal` | Terminal for a worktree, without switching the window |
| `Worktrees: Remove Worktree` | `git worktree remove`, after a confirmation (branch is kept) |
| `Worktrees: Remove Missing Worktrees` | Clear git's record of every worktree whose directory is gone |
| `Worktrees: Start Claude Code Here` / `Start Codex Here` | Launch an agent in the worktree |

A status bar entry shows the current worktree and opens the switcher.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `worktreeManager.scope` | `currentRepository` | List this repository's worktrees, or every one under the search paths |
| `worktreeManager.searchPaths` | `["~/projects"]` | Directories scanned one level deep for repos, when scope is `searchPaths` |
| `worktreeManager.openIn` | `currentWindow` | Where a click opens the worktree |
| `worktreeManager.revealViewOnSwitch` | `true` | Reopen the Worktrees view after the window reloads |
| `worktreeManager.newWorktreePath` | `~/projects/{repoName}-{branch}` | Proposed location for new worktrees |
| `worktreeManager.pruneMissingWorktrees` | `true` | Prune worktrees whose directory no longer exists instead of listing them |
| `worktreeManager.showSessions` | `true` | List agent chats under each worktree |
| `worktreeManager.claudeCommand` / `codexCommand` | `claude` / `codex` | Agent launch commands |

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
code --install-extension worktree-manager-0.0.6.vsix
```

Reload the window afterwards.

## License

[MIT](LICENSE).
