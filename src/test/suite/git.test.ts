import * as assert from 'assert';
import { redactGitArgument } from '../../diagnostics';
import { parseWorktreePorcelain } from '../../git';

describe('git worktree porcelain parsing', () => {
  it('preserves NUL-delimited paths and all worktree metadata', () => {
    const unusualPath = '/tmp/feature\n雪 ';
    const stdout = [
      'worktree /repo/main',
      'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'branch refs/heads/main',
      '',
      `worktree ${unusualPath}`,
      'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'detached',
      'locked portable drive is offline',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /repo/bare.git',
      'bare',
      '',
    ].join('\0');

    const worktrees = parseWorktreePorcelain(stdout, '/repo/main');

    assert.strictEqual(worktrees.length, 3);
    assert.deepStrictEqual(worktrees[0], {
      path: '/repo/main',
      repoRoot: '/repo/main',
      branch: 'main',
      head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      isMain: true,
    });
    assert.strictEqual(worktrees[1].path, unusualPath);
    assert.strictEqual(worktrees[1].detached, true);
    assert.strictEqual(worktrees[1].lockReason, 'portable drive is offline');
    assert.strictEqual(
      worktrees[1].prunableReason,
      'gitdir file points to non-existent location',
    );
    assert.strictEqual(worktrees[2].bare, true);
    assert.strictEqual(worktrees[2].isMain, false);
  });

  it('continues to accept legacy newline-delimited porcelain output', () => {
    const [worktree] = parseWorktreePorcelain(
      'worktree /repo/main\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n',
      '/repo/main',
    );

    assert.strictEqual(worktree.path, '/repo/main');
    assert.strictEqual(worktree.branch, 'main');
    assert.strictEqual(worktree.head, 'abc');
  });
});

describe('Git diagnostic redaction', () => {
  it('removes URL credentials and sensitive config values', () => {
    assert.strictEqual(
      redactGitArgument('https://secret@example.com/repo.git'),
      'https://[redacted]@example.com/repo.git',
    );
    assert.strictEqual(
      redactGitArgument('http.extraHeader=Authorization: Bearer secret'),
      'http.extraHeader=[redacted]',
    );
    assert.strictEqual(
      redactGitArgument('Authorization:Bearer-secret'),
      'Authorization:[redacted]',
    );
  });
});
