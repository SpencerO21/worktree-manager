# Worktree Manager

A VS Code extension that lists every git worktree you have, switches the current window
between them with a click, and gives each worktree its own terminal.

## Features

- **One list of every worktree.** Discovered from the folders open in the window plus the
  repositories under `worktreeManager.searchPaths`, deduplicated across repos, with the
  current worktree marked.
- **Click to switch.** Clicking a worktree points this window at it. VS Code has no way to
  change a window's folder without reloading it, so the window does reload — the extension
  hands the switch to the next activation and reopens the worktree's terminal on the way in.
- **A terminal per worktree.** Named `⑂ <folder>` and rooted in that worktree. It is created
  on first use and revealed on every later switch, so long-running processes are never
  interrupted. `worktreeManager.terminalStartupCommand` runs once, when the terminal is born.
- **New worktree in a few keystrokes.** The `+` button asks for a branch (existing branches are
  checked out, new ones are created off a base you pick), proposes a directory from
  `worktreeManager.newWorktreePath`, runs `git worktree add`, then switches to it — new
  terminal included.
- **Agent chats.** Each worktree lists its recent Claude Code and Codex sessions; clicking one
  switches to the worktree and resumes the chat in its terminal.

## Commands

| Command | What it does |
| --- | --- |
| `Worktrees: New Worktree` | Create a worktree and switch to it |
| `Worktrees: Switch Worktree` | Quick pick over every worktree |
| `Worktrees: Open Terminal` | Terminal for a worktree, without switching the window |
| `Worktrees: Remove Worktree` | `git worktree remove`, after a confirmation (branch is kept) |
| `Worktrees: Start Claude Code Here` / `Start Codex Here` | Launch an agent in the worktree terminal |

A status bar entry shows the current worktree and opens the switcher.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `worktreeManager.searchPaths` | `["~/projects"]` | Directories scanned one level deep for repos |
| `worktreeManager.openIn` | `currentWindow` | Where a click opens the worktree |
| `worktreeManager.openTerminalOnSwitch` | `true` | Reveal the worktree terminal after switching |
| `worktreeManager.terminalStartupCommand` | `""` | Run once in each new worktree terminal |
| `worktreeManager.newWorktreePath` | `{repoParent}/{repoName}-{branch}` | Proposed location for new worktrees |
| `worktreeManager.showSessions` | `true` | List agent chats under each worktree |
| `worktreeManager.claudeCommand` / `codexCommand` | `claude` / `codex` | Agent launch commands |

## Development

```sh
npm install
npm run watch     # esbuild in watch mode
```

Press `F5` to launch the Extension Development Host. `npm run compile` typechecks,
`npm run package` builds a `.vsix`.
