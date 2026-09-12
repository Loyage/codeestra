import { describe, expect, test } from 'bun:test';
import { runtimeRequestSchema } from '../src/index.js';

const base = {
  requestId: '11111111-1111-4111-8111-111111111111',
  schemaVersion: 1 as const,
  command: 'task.create' as const,
  commandId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  specification: 'Keep the original task text',
  kind: 'DEVELOPMENT' as const,
};

describe('Runtime task request boundary', () => {
  test('defaults constraints without rewriting specification text', () => {
    const request = runtimeRequestSchema.parse({ ...base, specification: '  exact spacing  ' });
    expect(request).toMatchObject({ specification: '  exact spacing  ', constraints: [] });
  });

  test('rejects blank specifications and duplicate constraint IDs', () => {
    expect(runtimeRequestSchema.safeParse({ ...base, specification: '   ' }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...base,
      constraints: [{ id: 'same', text: 'first' }, { id: 'same', text: 'second' }],
    }).success).toBe(false);
  });
});
