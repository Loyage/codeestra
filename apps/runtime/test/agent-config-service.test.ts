import { afterEach, describe, expect, test } from 'bun:test';
import {
  agentConfigurationPayload,
  AgentConfigurationError,
  environmentAgentConfiguration,
  resolveAgentConfiguration,
} from '../src/agent-config-service.js';
import { cleanupTemporaryDirectories, createAgentFixture } from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

describe('Agent configuration resolution', () => {
  test('reports the Adapter default when no scope overrides anything', async () => {
    const fixture = await createAgentFixture();
    try {
      const resolution = resolveAgentConfiguration({
        storage: fixture.storage, adapterId: 'pi', projectId: fixture.projectId,
      });
      expect(resolution.effective).toEqual({});
      expect(resolution.sources).toEqual({
        provider: 'DEFAULT', model: 'DEFAULT', thinkingLevel: 'DEFAULT',
      });
      expect(agentConfigurationPayload(resolution).effective).toEqual({
        provider: null, model: null, thinkingLevel: null,
      });
    } finally {
      fixture.storage.close();
    }
  });

  test('lets a project override one field while inheriting the global scope for the rest', async () => {
    const fixture = await createAgentFixture();
    try {
      fixture.storage.setAgentConfiguration({ id: 'cfg-global', scope: 'GLOBAL', projectId: null,
        adapterId: 'pi', provider: 'deepseek', model: 'deepseek-chat', thinkingLevel: 'low',
        updatedAt: 5, updatedBy: 'local-user' });
      fixture.storage.setAgentConfiguration({ id: 'cfg-project', scope: 'PROJECT',
        projectId: fixture.projectId, adapterId: 'pi', model: 'deepseek-flash',
        updatedAt: 6, updatedBy: 'local-user' });
      const { effective, sources } = resolveAgentConfiguration({
        storage: fixture.storage, adapterId: 'pi', projectId: fixture.projectId,
      });
      expect(effective).toEqual({
        provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'low',
      });
      expect(sources).toEqual({
        provider: 'GLOBAL', model: 'PROJECT', thinkingLevel: 'GLOBAL',
      });
    } finally {
      fixture.storage.close();
    }
  });

  test('gives environment overrides the highest precedence and never consults a project for them', async () => {
    const fixture = await createAgentFixture();
    try {
      fixture.storage.setAgentConfiguration({ id: 'cfg-global', scope: 'GLOBAL', projectId: null,
        adapterId: 'pi', provider: 'global-provider', model: 'global-model',
        thinkingLevel: 'low', updatedAt: 5, updatedBy: 'local-user' });
      fixture.storage.setAgentConfiguration({ id: 'cfg-project', scope: 'PROJECT',
        projectId: fixture.projectId, adapterId: 'pi', model: 'project-model',
        updatedAt: 6, updatedBy: 'local-user' });
      const { effective, sources } = resolveAgentConfiguration({
        storage: fixture.storage,
        adapterId: 'pi',
        projectId: fixture.projectId,
        environment: { CODEESTRA_PI_MODEL: 'env-model', CODEESTRA_PI_THINKING: 'max' },
      });
      expect(effective).toEqual({
        provider: 'global-provider', model: 'env-model', thinkingLevel: 'max',
      });
      expect(sources).toEqual({
        provider: 'GLOBAL', model: 'ENVIRONMENT', thinkingLevel: 'ENVIRONMENT',
      });
    } finally {
      fixture.storage.close();
    }
  });

  test('treats blank environment variables as unset and rejects an unusable thinking level', () => {
    expect(environmentAgentConfiguration('pi', {
      CODEESTRA_PI_PROVIDER: '   ', CODEESTRA_PI_MODEL: '',
    })).toBeNull();
    expect(environmentAgentConfiguration('codex', { CODEESTRA_PI_MODEL: 'x' })).toBeNull();
    // Silently ignoring a malformed thinking level would run a different model than requested.
    expect(() => environmentAgentConfiguration('pi', { CODEESTRA_PI_THINKING: 'extreme' }))
      .toThrow(AgentConfigurationError);
  });

  test('keeps an unusable thinking level out of the database even on a direct write', async () => {
    const fixture = await createAgentFixture();
    try {
      // The Runtime validates before writing; the column constraint is the second layer, so a
      // row that would make every resolution fail cannot be introduced by an out-of-band write.
      expect(() => fixture.storage.sqlite.query(`INSERT INTO agent_configurations
        (id,scope,project_id,adapter_id,provider,model,thinking_level,updated_at,updated_by)
        VALUES ('bad','GLOBAL',NULL,'pi',NULL,NULL,'extreme',1,'local-user')`).run()).toThrow();
    } finally {
      fixture.storage.close();
    }
  });
});
