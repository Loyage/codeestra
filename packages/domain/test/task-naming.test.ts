import { describe, expect, it } from 'vitest';
import { taskWorkspaceName } from '../src/index.js';

const taskId = '9f1c0f0a-1111-4222-8333-444455556666';

describe('taskWorkspaceName (ADR-0065 D03)', () => {
  it('uses the display number and the naming title for a Task that has one', () => {
    expect(taskWorkspaceName({ taskId, displayNumber: 12, namingTitle: 'parser-crlf-case' }))
      .toBe('12-parser-crlf-case');
  });

  it('falls back to the internal identity for a Task created before the field existed', () => {
    expect(taskWorkspaceName({ taskId, displayNumber: 12, namingTitle: null })).toBe(taskId);
  });

  it('never renders a null naming title into the name', () => {
    const name = taskWorkspaceName({ taskId, displayNumber: 1, namingTitle: null });
    expect(name).not.toContain('null');
    expect(name).not.toContain('undefined');
  });
});
