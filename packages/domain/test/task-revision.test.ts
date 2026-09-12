import { describe, expect, it } from 'vitest';
import {
  appendTaskRevision, createSpecificationHistory, DomainError,
  type RevisionInput,
} from '../src/index.js';

const input = (overrides: Partial<RevisionInput> = {}): RevisionInput => ({
  id: 'revision-1',
  specification: '优化地图生成',
  constraints: [{ id: 'seed', text: '不能破坏 seed determinism' }],
  actor: 'user',
  reason: '创建任务',
  sourceIntentId: 'intent-1',
  createdAt: 1000,
  ...overrides,
});

describe('TaskRevision', () => {
  it('creates a full first revision without normalizing away the original specification', () => {
    const history = createSpecificationHistory('task-1', input({ specification: ' 优化地图生成\n' }));
    expect(history.version).toBe(0);
    expect(history.currentRevision.number).toBe(1);
    expect(history.currentRevision.previousRevisionId).toBeNull();
    expect(history.currentRevision.specification).toBe(' 优化地图生成\n');
  });

  it('appends a snapshot and preserves old revision and caller state', () => {
    const old = createSpecificationHistory('task-1', input());
    const next = appendTaskRevision(old, 0, input({ id: 'revision-2', reason: '新增约束' }));
    expect(next.version).toBe(1);
    expect(next.currentRevision.number).toBe(2);
    expect(next.currentRevision.previousRevisionId).toBe('revision-1');
    expect(next.revisions[0]).toBe(old.currentRevision);
    expect(old.revisions).toHaveLength(1);
    expect(old.currentRevision.id).toBe('revision-1');
  });

  it('defensively copies and freezes nested constraints', () => {
    const constraints = [{ id: 'seed', text: '原约束' }];
    const history = createSpecificationHistory('task-1', input({ constraints }));
    constraints[0]!.text = '外部修改';
    constraints.push({ id: 'new', text: '新约束' });
    expect(history.currentRevision.constraints).toEqual([{ id: 'seed', text: '原约束' }]);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history.revisions)).toBe(true);
    expect(Object.isFrozen(history.currentRevision)).toBe(true);
    expect(Object.isFrozen(history.currentRevision.constraints[0])).toBe(true);
  });

  it('rejects stale concurrent revisions without changing history', () => {
    const old = createSpecificationHistory('task-1', input());
    const current = appendTaskRevision(old, 0, input({ id: 'revision-2' }));
    expect(() => appendTaskRevision(current, 0, input({ id: 'revision-3' })))
      .toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(current.revisions).toHaveLength(2);
  });

  it('rejects reuse of any historical revision ID', () => {
    const current = appendTaskRevision(createSpecificationHistory('task-1', input()), 0,
      input({ id: 'revision-2' }));
    expect(() => appendTaskRevision(current, 1, input())).toThrow(DomainError);
  });

  it.each(['id', 'specification', 'actor', 'reason'] as const)('rejects empty %s', (field) => {
    expect(() => createSpecificationHistory('task-1', input({ [field]: ' \n' }))).toThrow(DomainError);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid timestamp %s', (createdAt) => {
    expect(() => createSpecificationHistory('task-1', input({ createdAt }))).toThrow(DomainError);
  });

  it('rejects duplicate constraint IDs and empty constraint text', () => {
    expect(() => createSpecificationHistory('task-1', input({ constraints: [
      { id: 'seed', text: 'a' }, { id: 'seed', text: 'b' },
    ] }))).toThrow(DomainError);
    expect(() => createSpecificationHistory('task-1', input({ constraints: [
      { id: 'seed', text: ' ' },
    ] }))).toThrow(DomainError);
  });
});
