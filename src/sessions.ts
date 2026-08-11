import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type AgentKind = 'claude' | 'codex';

export interface AgentSession {
  kind: AgentKind;
  /** Session id accepted by `claude --resume <id>` / `codex resume <id>`. */
  id: string;
  /** Working directory the session was started in. */
  cwd: string;
  title: string;
  /** Last-modified time in epoch ms; used for ordering. */
  mtime: number;
  file: string;
}

const HEAD_BYTES = 128 * 1024;

/** Read at most `bytes` from the front of a file without slurping the whole thing. */
async function readHead(file: string, bytes = HEAD_BYTES): Promise<string> {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Parse whole JSONL lines, dropping a trailing partial line from a truncated read. */
function* jsonLines(text: string): Generator<any> {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // Last line of a bounded read is usually cut mid-object; earlier failures are
      // genuinely malformed records. Either way, skipping is the right move.
    }
  }
}

function firstLine(text: string): any | undefined {
  const newline = text.indexOf('\n');
  const line = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (!line) {
    return undefined;
  }
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function tidy(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Prompts injected by slash commands and hooks make useless titles. */
function isBoilerplate(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<') ||
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted') ||
    t.startsWith('DO NOT respond')
  );
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === 'object' && (block as any).type === 'text')
      .map((block) => String((block as any).text ?? ''))
      .join(' ');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Claude Code — ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl
// ---------------------------------------------------------------------------

/**
 * Claude Code names a project directory by replacing every non-alphanumeric
 * character in the absolute cwd with a dash.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

async function claudeSessionTitle(file: string): Promise<string | undefined> {
  const head = await readHead(file);
  for (const record of jsonLines(head)) {
    if (record.type === 'summary' && typeof record.summary === 'string') {
      return tidy(record.summary);
    }
    if (record.type === 'user' && !record.isMeta) {
      const text = extractText(record.message?.content);
      if (text.trim() && !isBoilerplate(text)) {
        return tidy(text);
      }
    }
  }
  return undefined;
}

export async function claudeSessionsFor(cwd: string, limit: number): Promise<AgentSession[]> {
  const dir = path.join(claudeProjectsRoot(), claudeProjectSlug(cwd));

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const stats = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(async (entry) => {
        const file = path.join(dir, entry.name);
        try {
          const stat = await fsp.stat(file);
          // Freshly-created or aborted sessions carry no usable history.
          if (stat.size < 512) {
            return undefined;
          }
          return { file, id: entry.name.replace(/\.jsonl$/, ''), mtime: stat.mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );

  const recent = stats
    .filter((s): s is { file: string; id: string; mtime: number } => s !== undefined)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  // Titles require reading file heads, so only pay for the ones actually shown.
  return Promise.all(
    recent.map(async (s) => ({
      kind: 'claude' as const,
      id: s.id,
      cwd,
      mtime: s.mtime,
      file: s.file,
      title: (await claudeSessionTitle(s.file)) ?? 'Claude Code session',
    })),
  );
}

// ---------------------------------------------------------------------------
// Codex — ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<id>.jsonl
// ---------------------------------------------------------------------------

export function codexSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

async function walkJsonl(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkJsonl(full, out);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }),
  );
}

/** Human-friendly thread names, keyed by session id, from Codex's session index. */
async function codexThreadNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const indexFile = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  let text: string;
  try {
    text = await fsp.readFile(indexFile, 'utf8');
  } catch {
    return names;
  }
  for (const record of jsonLines(text)) {
    if (typeof record?.id === 'string' && typeof record?.thread_name === 'string') {
      names.set(record.id, record.thread_name);
    }
  }
  return names;
}

function codexFallbackTitle(head: string): string | undefined {
  for (const record of jsonLines(head)) {
    const payload = record?.payload;
    if (payload?.type === 'message' && payload?.role === 'user') {
      const text = extractText(payload.content) || extractText(payload.text);
      if (text.trim() && !isBoilerplate(text)) {
        return tidy(text);
      }
    }
  }
  return undefined;
}

/**
 * Codex stores sessions by date rather than by project, so the only way to map a
 * worktree to its chats is to read the `session_meta` header of each rollout file.
 * The scan is cached and invalidated by directory mtime.
 */
export class CodexIndex {
  private cache?: Map<string, AgentSession[]>;
  private pending?: Promise<Map<string, AgentSession[]>>;

  invalidate(): void {
    this.cache = undefined;
    this.pending = undefined;
  }

  async sessionsFor(cwd: string, limit: number): Promise<AgentSession[]> {
    const index = await this.build();
    const sessions = index.get(path.resolve(cwd)) ?? [];
    return sessions.slice(0, limit);
  }

  private build(): Promise<Map<string, AgentSession[]>> {
    if (this.cache) {
      return Promise.resolve(this.cache);
    }
    this.pending ??= this.scan().then((index) => {
      this.cache = index;
      this.pending = undefined;
      return index;
    });
    return this.pending;
  }

  private async scan(): Promise<Map<string, AgentSession[]>> {
    const files: string[] = [];
    await walkJsonl(codexSessionsRoot(), files);

    const [names, records] = await Promise.all([
      codexThreadNames(),
      Promise.all(files.map((file) => this.readSession(file))),
    ]);

    const index = new Map<string, AgentSession[]>();
    for (const record of records) {
      if (!record) {
        continue;
      }
      record.title = names.get(record.id) ?? record.title;
      const key = path.resolve(record.cwd);
      const list = index.get(key);
      if (list) {
        list.push(record);
      } else {
        index.set(key, [record]);
      }
    }
    for (const list of index.values()) {
      list.sort((a, b) => b.mtime - a.mtime);
    }
    return index;
  }

  private async readSession(file: string): Promise<AgentSession | undefined> {
    const head = await readHead(file);
    const meta = firstLine(head);
    if (meta?.type !== 'session_meta') {
      return undefined;
    }
    const payload = meta.payload ?? {};
    // Subagent threads share their parent's cwd and are not independently resumable
    // in a way that makes sense from a worktree list.
    if (payload.thread_source === 'subagent') {
      return undefined;
    }
    const id = payload.id ?? payload.session_id;
    if (typeof id !== 'string' || typeof payload.cwd !== 'string') {
      return undefined;
    }

    let mtime = Date.parse(meta.timestamp ?? payload.timestamp ?? '');
    if (Number.isNaN(mtime)) {
      try {
        mtime = (await fsp.stat(file)).mtimeMs;
      } catch {
        mtime = 0;
      }
    }

    return {
      kind: 'codex',
      id,
      cwd: payload.cwd,
      mtime,
      file,
      title: codexFallbackTitle(head) ?? 'Codex session',
    };
  }
}

// ---------------------------------------------------------------------------

export async function sessionsForWorktree(
  cwd: string,
  codex: CodexIndex,
  limit: number,
): Promise<AgentSession[]> {
  const [claude, codexSessions] = await Promise.all([
    claudeSessionsFor(cwd, limit),
    codex.sessionsFor(cwd, limit),
  ]);
  return [...claude, ...codexSessions].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
