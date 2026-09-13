import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitInspectionError } from './errors.js';

function gitEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined) continue;
    // Ambient GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE must never redirect our commands.
    if (key.startsWith('GIT_')) continue;
    environment[key] = value;
  }
  return { ...environment, ...extra };
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<GitResult> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: gitEnvironment(extraEnv),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout: new Uint8Array(stdout), stderr };
}

async function gitOrThrow(
  cwd: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<Uint8Array> {
  const result = await runGit(cwd, args, extraEnv);
  if (result.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      result.stderr.trim() || `git ${args[0] ?? ''} exited with ${result.exitCode}`);
  }
  return result.stdout;
}

function trimText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

function splitNull(bytes: Uint8Array): readonly Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      parts.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < bytes.length) parts.push(bytes.subarray(start));
  return parts;
}

function decodePath(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitInspectionError('COMMAND_FAILED', 'Change set contains a non-UTF-8 path');
  }
}

export type ChangeSetStatus = 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED' | 'TYPE_CHANGED';

export interface ChangeSetEntry {
  readonly status: ChangeSetStatus;
  readonly path: string;
  /** Set for RENAMED and COPIED entries. */
  readonly previousPath?: string;
}

export interface ChangeSet {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly entries: readonly ChangeSetEntry[];
  /** Content-inclusive fingerprint: any HEAD or working-tree change moves it. */
  readonly treeFingerprint: string;
}

function normalizeStatus(raw: string, path: string): ChangeSetStatus {
  switch (raw[0]) {
    case 'A': return 'ADDED';
    case 'M': return 'MODIFIED';
    case 'D': return 'DELETED';
    case 'R': return 'RENAMED';
    case 'C': return 'COPIED';
    case 'T': return 'TYPE_CHANGED';
    default:
      throw new GitInspectionError('UNRESOLVED_CHANGE',
        `Unsupported change status ${raw} for ${path}; resolve conflicts and index state first`);
  }
}

function parseNameStatus(bytes: Uint8Array): readonly ChangeSetEntry[] {
  const fields = splitNull(bytes);
  const entries: ChangeSetEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const statusField = fields[index];
    if (statusField === undefined || statusField.length === 0) break;
    const raw = trimText(statusField);
    if (raw.length === 0) break;
    index += 1;
    const kind = normalizeStatus(raw, raw);
    if (kind === 'RENAMED' || kind === 'COPIED') {
      const previousField = fields[index];
      const pathField = fields[index + 1];
      if (previousField === undefined || pathField === undefined) {
        throw new GitInspectionError('COMMAND_FAILED', 'git reported an incomplete rename record');
      }
      index += 2;
      entries.push({ status: kind, path: decodePath(pathField), previousPath: decodePath(previousField) });
    } else {
      const pathField = fields[index];
      if (pathField === undefined) {
        throw new GitInspectionError('COMMAND_FAILED', 'git reported an incomplete change record');
      }
      index += 1;
      entries.push({ status: kind, path: decodePath(pathField) });
    }
  }
  return entries;
}

function compareEntries(left: ChangeSetEntry, right: ChangeSetEntry): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.status !== right.status) return left.status < right.status ? -1 : 1;
  return 0;
}

export function sameChangeSetEntries(
  left: readonly ChangeSetEntry[],
  right: readonly ChangeSetEntry[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareEntries);
  const sortedRight = [...right].sort(compareEntries);
  return sortedLeft.every((entry, index) => {
    const other = sortedRight[index];
    return other !== undefined && entry.status === other.status && entry.path === other.path
      && (entry.previousPath ?? '') === (other.previousPath ?? '');
  });
}

export function changeSetPaths(changeSet: ChangeSet): readonly string[] {
  const paths = new Set<string>();
  for (const entry of changeSet.entries) {
    paths.add(entry.path);
    if (entry.previousPath !== undefined) paths.add(entry.previousPath);
  }
  return [...paths].sort();
}

/**
 * The tree the worktree would produce if it were committed right now, computed in a private
 * temporary index so the user's real index and staging state never influence the answer.
 */
async function worktreeTree(workspacePath: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-index-'));
  const indexPath = join(directory, 'index');
  try {
    const environment = { GIT_INDEX_FILE: indexPath };
    await gitOrThrow(workspacePath, ['add', '--all', '--', '.'], environment);
    const tree = trimText(await gitOrThrow(workspacePath, ['write-tree'], environment));
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new GitInspectionError('COMMAND_FAILED', 'Could not compute the worktree tree object');
    }
    return tree;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Reads the complete change set of an owned task worktree relative to its fixed base:
 * tracked additions, modifications, deletions, renames, and untracked files that are not
 * ignored. The fingerprint is the tree the worktree would commit, so identical status lists
 * with different contents differ, and staging files does not change the answer.
 */
export async function inspectChangeSet(input: {
  readonly workspacePath: string;
  readonly baseCommit: string;
}): Promise<ChangeSet> {
  const headCommit = trimText(await gitOrThrow(input.workspacePath, ['rev-parse', '--verify', 'HEAD']));
  const statusBytes = await gitOrThrow(input.workspacePath,
    ['diff', '--name-status', '-z', '-M', '--no-color', input.baseCommit, '--', '.']);
  const entries: ChangeSetEntry[] = [...parseNameStatus(statusBytes)];
  const untrackedBytes = await gitOrThrow(input.workspacePath,
    ['ls-files', '--others', '--exclude-standard', '-z']);
  const untrackedPaths = splitNull(untrackedBytes)
    .filter((field) => field.length > 0)
    .map(decodePath)
    .sort();
  for (const path of untrackedPaths) entries.push({ status: 'ADDED', path });
  const sorted = [...entries].sort(compareEntries);

  const tree = await worktreeTree(input.workspacePath);
  const digest = createHash('sha256');
  digest.update(`base\0${input.baseCommit}\0head\0${headCommit}\0tree\0${tree}\0`);
  return {
    baseCommit: input.baseCommit,
    headCommit,
    entries: sorted,
    treeFingerprint: digest.digest('hex'),
  };
}

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/** Reads the current HEAD of a worktree without judging whether it is authorized. */
export async function readHeadCommit(workspacePath: string): Promise<string> {
  return trimText(await gitOrThrow(workspacePath, ['rev-parse', '--verify', 'HEAD']));
}

/** Uses only the identity this repository already resolves. It never writes Git config. */
export async function resolveCommitIdentity(workspacePath: string): Promise<CommitIdentity> {
  const name = await runGit(workspacePath, ['config', '--get', 'user.name']);
  if (name.exitCode !== 0 || trimText(name.stdout).length === 0) {
    throw new GitInspectionError('IDENTITY_NOT_CONFIGURED',
      'Repository user.name is not configured; configure it before creating a result commit');
  }
  const email = await runGit(workspacePath, ['config', '--get', 'user.email']);
  if (email.exitCode !== 0 || trimText(email.stdout).length === 0) {
    throw new GitInspectionError('IDENTITY_NOT_CONFIGURED',
      'Repository user.email is not configured; configure it before creating a result commit');
  }
  return { name: trimText(name.stdout), email: trimText(email.stdout) };
}

/** Stages every change relative to the fixed base inside the owned worktree. */
export async function stageResultChangeSet(workspacePath: string): Promise<void> {
  await gitOrThrow(workspacePath, ['add', '--all', '--', '.']);
}

export interface ResultCommitOutcome {
  /** True when the commit object exists, even if Git reported a failure afterwards. */
  readonly commitExists: boolean;
  readonly detail?: string;
}

/**
 * Creates the result commit with the repository's own hooks enabled. `--no-verify` is
 * never used. A non-zero exit is reported together with whether HEAD actually moved, so
 * the caller never assumes that a failed command created nothing.
 */
export async function createResultCommit(input: {
  readonly workspacePath: string;
  readonly expectedHead: string;
  readonly message: string;
}): Promise<ResultCommitOutcome> {
  const result = await runGit(input.workspacePath, ['commit', '--message', input.message]);
  if (result.exitCode === 0) return { commitExists: true };
  const detail = (result.stderr.trim() || trimText(result.stdout)).slice(0, 2_000);
  const head = trimText(await gitOrThrow(input.workspacePath, ['rev-parse', '--verify', 'HEAD']));
  return {
    commitExists: head !== input.expectedHead,
    detail: detail.length === 0
      ? `git commit exited with ${result.exitCode}`
      : detail,
  };
}

export interface InspectedResultCommit {
  readonly commit: string;
  readonly parent: string;
  readonly tree: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
}

/**
 * Confirms whether HEAD is exactly the result commit the Runtime was authorized to create:
 * one commit on top of the authorized head with the deterministic message and the
 * authorized entry list. Returns null when HEAD is anything else; it never throws for a
 * mismatch, so callers decide between adopting and recovery.
 */
export async function inspectResultCommit(input: {
  readonly workspacePath: string;
  readonly expectedHead: string;
  readonly expectedMessage: string;
  readonly expectedEntries?: readonly ChangeSetEntry[];
}): Promise<InspectedResultCommit | null> {
  const observedHead = trimText(await gitOrThrow(input.workspacePath, ['rev-parse', '--verify', 'HEAD']));
  if (observedHead === input.expectedHead) return null;
  const parent = await runGit(input.workspacePath, ['rev-parse', '--verify', 'HEAD^']);
  if (parent.exitCode !== 0 || trimText(parent.stdout) !== input.expectedHead) return null;
  const message = trimText(await gitOrThrow(input.workspacePath, ['log', '-1', '--format=%B', 'HEAD']));
  if (message !== input.expectedMessage.trim()) return null;
  if (input.expectedEntries !== undefined) {
    const statusBytes = await gitOrThrow(input.workspacePath,
      ['diff', '--name-status', '-z', '-M', '--no-color', input.expectedHead, 'HEAD', '--', '.']);
    if (!sameChangeSetEntries(parseNameStatus(statusBytes), input.expectedEntries)) return null;
  }
  const tree = trimText(await gitOrThrow(input.workspacePath, ['rev-parse', '--verify', 'HEAD^{tree}']));
  const authorFields = splitNull(await gitOrThrow(input.workspacePath,
    ['log', '-1', '--format=%an%x00%ae', 'HEAD']));
  const authorNameField = authorFields[0];
  const authorEmailField = authorFields[1];
  if (authorNameField === undefined || authorEmailField === undefined) {
    throw new GitInspectionError('COMMAND_FAILED', 'Could not read the result commit author identity');
  }
  return {
    commit: observedHead,
    parent: input.expectedHead,
    tree,
    message,
    authorName: trimText(authorNameField),
    authorEmail: trimText(authorEmailField),
  };
}
