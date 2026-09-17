import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeRequestSchema, type RuntimeRequest } from '@codeestra/contracts';
import {
  commandIds,
  directChildIds,
  hasUnitAncestor,
  isChainId,
  nodeSpecOf,
  parentIdOf,
  resolveCommand,
  type CommandNodeSpec,
} from '../../cli/src/command-tree.js';

/**
 * The command tree is the one description of the CLI, so the things that used to drift by hand are
 * checked against it instead of against a second list written here (ADR-0068).
 *
 * What each check can and cannot prove is stated next to it. These are reachability and coverage
 * checks, not behavioural proofs: they say "a command exists and is pointed at", never "it works".
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliSource = readFileSync(join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts'), 'utf8');
const guidesDirectory = join(repositoryRoot, 'docs', 'guides', 'cli');
const guides = readdirSync(guidesDirectory)
  .filter((name) => name.endsWith('.md'))
  .map((name) => readFileSync(join(guidesDirectory, name), 'utf8'))
  .join('\n');

/** A resolution as plain data, so a union can be compared without tripping the matcher's overloads. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

const runtimeCommands = runtimeRequestSchema.options
  .map((option) => (option as unknown as { shape: { command: { value: RuntimeRequest['command'] } } })
    .shape.command.value);

describe('the CLI command surface', () => {
  test('every node has a summary, a parent, and the shape its kind promises', () => {
    for (const id of commandIds) {
      const node: CommandNodeSpec = nodeSpecOf(id);
      expect([id, node.summary.trim().length > 0]).toEqual([id, true]);
      const parent = parentIdOf(id);
      if (parent !== null) expect([id, commandIds.includes(parent)]).toEqual([id, true]);
      if (node.kind === 'COMMAND') expect([id, node.usage !== undefined]).toEqual([id, true]);
    }
    // The type-level ancestor walk is written out to this depth (see `Ancestors` in the tree).
    const deepest = Math.max(...commandIds.map((id) => id.split('.').length));
    expect(deepest).toBeLessThanOrEqual(4);
  });

  test('a unit really owns children, and no group is empty', () => {
    for (const id of commandIds) {
      const children = directChildIds(id);
      if (nodeSpecOf(id).unit === true) {
        expect([id, children.length > 0]).toEqual([id, true]);
      }
      if (nodeSpecOf(id).usage === undefined) {
        expect([id, children.length > 0]).toEqual([id, true]);
      }
    }
  });

  test('the resolver never fails on a path the tree declares', () => {
    const unitOwnerOf = (id: string): string | undefined => commandIds
      .filter((candidate) => nodeSpecOf(candidate).unit === true)
      .filter((candidate) => id.startsWith(`${candidate}.`))
      .sort((left, right) => right.length - left.length)[0];
    for (const id of commandIds) {
      const resolved = resolveCommand(id.split('.'));
      if (nodeSpecOf(id).resolverHandled === true) {
        // `help` is answered by the resolver itself, so `codeestra help help` is its own request.
        expect([id, resolveCommand([...id.split('.'), 'help'])])
          .toEqual([id, { kind: 'HELP', id }]);
        continue;
      }
      if (isChainId(id) && !hasUnitAncestor(id)) {
        // A node the chain branches on is resolved to itself.
        expect([id, plain(resolved)]).toEqual([id, { kind: 'DISPATCH', id, rest: [] }]);
        continue;
      }
      const owner = unitOwnerOf(id);
      if (owner !== undefined) {
        // A node inside a unit is handed to that unit's branch, which resolves it itself.
        expect([id, resolved.kind]).toEqual([id, 'DISPATCH']);
        if (resolved.kind === 'DISPATCH') expect(plain([id, resolved.id])).toEqual([id, owner]);
      } else {
        // A pure parent group (`task`, `session`, `task verification`) has nothing to run on its own.
        expect([id, plain(resolved)]).toEqual([id, { kind: 'BARE', parent: id }]);
      }
    }
    // `help` is answered by the resolver, never by the chain.
    expect(plain(resolveCommand(['help']))).toEqual({ kind: 'HELP', id: null });
    expect(plain(resolveCommand(['task', 'run', '--help']))).toEqual({ kind: 'HELP', id: 'task.run' });
    expect(plain(resolveCommand(['task', 'recoverr']))).toEqual({
      kind: 'UNKNOWN', parent: 'task', token: 'recoverr',
    });
  });

  test('every Runtime command is reachable from the CLI, and named in its code', () => {
    const declared = new Set<string>();
    for (const id of commandIds) {
      for (const name of nodeSpecOf(id).runtime ?? []) declared.add(name);
      if (runtimeCommands.includes(id as RuntimeRequest['command'])) declared.add(id);
    }
    // Reachability: the tree says which Runtime command each CLI command sends.
    expect(runtimeCommands.filter((name) => !declared.has(name))).toEqual([]);
    // And the code really names it. This is the check that would have caught `task recover`: the
    // command existed in the Runtime, the contract and the docs, but no CLI code ever sent it.
    const code = cliSource.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');
    expect(runtimeCommands.filter((name) => !code.includes(`'${name}'`))).toEqual([]);
  });

  test('every CLI command is documented in docs/guides/cli', () => {
    // Coverage, not freshness: this fails when a command has no section at all, and says nothing
    // about whether a section that exists is still accurate (that stays ADR-0050's human rule).
    const undocumented = commandIds
      .filter((id) => nodeSpecOf(id).kind === 'COMMAND')
      .filter((id) => !guides.includes(id.replaceAll('.', ' ')));
    expect(undocumented).toEqual([]);
  });
});
