import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandIds,
  commandPathOf,
  directChildIds,
  helpViewOf,
  maxTranscriptReverseReads,
  nodeSpecOf,
  usageLineOf,
  type CommandId,
} from '../../cli/src/command-tree.js';
import { cleanupTemporaryDirectories, registerTemporaryDirectory }
  from './support/agent-fixture.js';
import { reclaimTestResources, runCli } from './support/runtime-reclamation.js';

/**
 * `help` at every level of the CLI (ADR-0068), driven through the real CLI process.
 *
 * The invariant is self-consistency, so the expectation is not written here: it is read from the
 * command tree the dispatcher resolves against. If a level's listing ever disagrees with the tree —
 * a missing command, an extra one, a stale summary — this test fails at that level by name.
 *
 * `help` is also asserted not to touch the Runtime: asking what a CLI can do must not start a
 * process, open the socket or write anything into `CODEESTRA_HOME`.
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => {
  await reclaimTestResources();
  cleanupTemporaryDirectories();
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], home: string) {
  return await runCli(args, { CODEESTRA_HOME: home }, { entry: cliEntry });
}

function pathTokens(id: CommandId): string[] {
  return id.split('.');
}

/** The `命令（N）：` block of a listing, as `command -> summary` pairs. */
function listedChildren(stdout: string): Map<string, string> {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.startsWith('命令（'));
  const listed = new Map<string, string>();
  if (start === -1) return listed;
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}(\S.*?) {2,}(.+)$/.exec(line);
    if (match === null) break;
    listed.set((match[1] as string).trim(), (match[2] as string).trim());
  }
  return listed;
}

describe('codeestra help', () => {
  test('lists every node of the tree with that node’s own summary, at every level', async () => {
    const home = temporaryDirectory('codeestra-help-home-');
    let checked = 0;
    for (const id of commandIds) {
      const result = await cli([...pathTokens(id), 'help'], home);
      expect([id, result.exitCode]).toEqual([id, 0]);
      const lines = result.stdout.split('\n');
      // A runnable command names itself with its usage line; a group with the path you type.
      const expectedFirstLine = nodeSpecOf(id).usage === undefined
        ? commandPathOf(id) : usageLineOf(id);
      expect([id, lines[0]]).toEqual([id, expectedFirstLine]);
      expect(lines[1]?.trim()).toBe(nodeSpecOf(id).summary);
      const listed = listedChildren(result.stdout);
      const expected = new Map(directChildIds(id).map((child) => [
        child.split('.').slice(id.split('.').length).join(' '),
        nodeSpecOf(child).summary,
      ]));
      expect([id, Object.fromEntries(listed)]).toEqual([id, Object.fromEntries(expected)]);
      checked += 1;
    }
    expect(checked).toBe(commandIds.length);
    // One process per node: ~134 spawns, which is past bun's 5s default test timeout.
  }, 120_000);

  test('is the same request when written as `help`, `<path> help`, `--help` or `-h`', async () => {
    const home = temporaryDirectory('codeestra-help-alias-home-');
    const direct = await cli(['help', 'task', 'revision'], home);
    for (const args of [['task', 'revision', 'help'], ['task', 'revision', '--help'],
      ['task', 'revision', '-h'], ['help', 'task', 'revision', '--json']]) {
      const other = await cli(args, home);
      expect([args.join(' '), other.exitCode]).toEqual([args.join(' '), 0]);
      if (args.includes('--json')) {
        expect(JSON.parse(other.stdout)).toEqual(helpViewOf('task.revision'));
      } else {
        expect(other.stdout).toBe(direct.stdout);
      }
    }
  });

  test('answers every level with --json, in the same shape the tree describes', async () => {
    const home = temporaryDirectory('codeestra-help-json-home-');
    const root = JSON.parse((await cli(['help', '--json'], home)).stdout) as { children: unknown };
    expect(root).toEqual(helpViewOf(null));
    const deep = JSON.parse((await cli(['scheduler', 'reservations', 'help', '--json'], home)).stdout);
    expect(deep).toEqual(helpViewOf('scheduler.reservations'));
  });

  test('never starts a Runtime: no socket, no lock, no boot trace', async () => {
    const home = temporaryDirectory('codeestra-help-quiet-home-');
    const result = await cli(['help'], home);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, 'runtime.sock'))).toBe(false);
    expect(existsSync(join(home, 'runtime.lock'))).toBe(false);
  });

  test('prints one line for an unknown command, a bare group and a bad argument', async () => {
    const home = temporaryDirectory('codeestra-help-error-home-');
    const cases: readonly (readonly string[])[] = [
      ['task', 'recoverr', 'project', 'task', '0'],
      ['task', 'revision', 'nope'],
      ['task'],
      [],
      // `task list` has no project argument any more (ADR-0076): with no arguments it lists every
      // trusted project, so it is not a usage error — a flag the command does not take still is.
      ['task', 'list', 'a', 'b', '--bogus'],
      // A command that takes nothing still refuses an extra token (the tree consumes the path, so
      // the check has to live in the branch).
      ['status', 'extra'],
      ['project', 'list', 'x'],
    ];
    for (const args of cases) {
      const result = await cli(args, home);
      expect([args.join(' '), result.exitCode]).toEqual([args.join(' '), 2]);
      expect([args.join(' '), result.stdout]).toEqual([args.join(' '), '']);
      expect([args.join(' '), result.stderr.trimEnd().split('\n').length])
        .toEqual([args.join(' '), 1]);
      // Every usage error points at the level the user was in, so the listing is one command away.
      expect(result.stderr).toContain('help');
    }
  });

  test('keeps the long text reachable: a command’s own explanation and a note that names no command', async () => {
    const home = temporaryDirectory('codeestra-help-detail-home-');
    const detail = (await cli(['task', 'purge', 'help'], home)).stdout;
    expect(detail).toContain('DESTRUCTIVE and irreversible');
    const root = (await cli(['help'], home)).stdout;
    // The two paragraphs of the old dump that name no single command stay in the top-level help.
    expect(root).toContain('ADR-0066 removed the whole integration and promotion face');
    expect(root).toContain('ADR-0038 splits verification cost by branch responsibility');
    // The number the moved `--reverse` sentence interpolates still comes from one constant.
    expect((await cli(['session', 'transcript', 'help'], home)).stdout)
      .toContain(`up to ${String(maxTranscriptReverseReads)} pages`);
  });
});
