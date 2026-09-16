import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimeStreamFrame } from '@codeestra/contracts';
import type { Phase1Database } from '@codeestra/storage';
import { EventSubscriptionHub, type EventSubscriptionStopReason } from '../src/event-subscription-service.js';
import { cleanupTemporaryDirectories, createAgentFixture } from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

interface Recorder {
  readonly frames: RuntimeStreamFrame[];
  readonly stopReasons: EventSubscriptionStopReason[];
  readonly send: (frame: RuntimeStreamFrame) => boolean;
  readonly onStop: (reason: EventSubscriptionStopReason) => void;
}

function recorder(accept = true): Recorder {
  const frames: RuntimeStreamFrame[] = [];
  const stopReasons: EventSubscriptionStopReason[] = [];
  return {
    frames,
    stopReasons,
    send: (frame) => { if (accept) frames.push(frame); return accept; },
    onStop: (reason: EventSubscriptionStopReason) => { stopReasons.push(reason); },
  };
}

function eventFrames(frames: readonly RuntimeStreamFrame[]): readonly { cursor: number; eventType: string }[] {
  return frames.flatMap((frame) => frame.type === 'event'
    ? [{ cursor: frame.cursor, eventType: frame.event.eventType }] : []);
}

function createTask(storage: Phase1Database, projectId: string, suffix: string): void {
  storage.createTask({
    projectId,
    commandId: `command-${suffix}`,
    payloadHash: `hash-${suffix}`,
    intentId: `intent-${suffix}`,
    taskId: `task-${suffix}`,
    revisionId: `revision-${suffix}`,
    intentEventId: `intent-event-${suffix}`,
    taskEventId: `task-event-${suffix}`,
    specification: `Task ${suffix}`,
    displayTitle: 'fixture task',
    namingTitle: null,
    actor: 'local-user',
    createdAt: 10,
  });
}

describe('event subscription hub', () => {
  test('reports the snapshot cursor and then only events committed after it', async () => {
    const value = await createAgentFixture();
    const hub = new EventSubscriptionHub({ storage: value.storage });
    const peer = recorder();
    const requestId = crypto.randomUUID();
    const handle = hub.subscribe({ requestId, send: peer.send, onStop: peer.onStop });
    // Events committed before the subscription are part of the snapshot the client already has.
    expect(peer.frames).toEqual([{
      schemaVersion: 1, type: 'subscribed', requestId,
      cursor: value.storage.latestEventSequence(), projectId: null,
    }]);
    expect(handle.cursor).toBe(value.storage.latestEventSequence());
    createTask(value.storage, value.projectId, 'after-subscribe');
    hub.flush();
    expect(eventFrames(peer.frames).map((frame) => frame.eventType))
      .toEqual(['IntentRecorded', 'TaskCreated']);
    expect(eventFrames(peer.frames).map((frame) => frame.cursor))
      .toEqual([handle.cursor - 1, handle.cursor]);
    // A second round must not repeat what was already delivered.
    hub.flush();
    expect(eventFrames(peer.frames)).toHaveLength(2);
    hub.close();
    value.storage.close();
  });

  test('replays from an explicit cursor and resumes without a gap or a duplicate', async () => {
    const value = await createAgentFixture();
    const hub = new EventSubscriptionHub({ storage: value.storage });
    const peer = recorder();
    const handle = hub.subscribe({
      requestId: crypto.randomUUID(), sinceSequence: 0, send: peer.send, onStop: peer.onStop,
    });
    hub.flush();
    const firstPass = eventFrames(peer.frames);
    expect(firstPass.map((frame) => frame.cursor)).toEqual([1, 2, 3]);
    expect(handle.cursor).toBe(3);
    createTask(value.storage, value.projectId, 'second');
    hub.flush();
    const secondPass = eventFrames(peer.frames).slice(firstPass.length);
    expect(secondPass.map((frame) => frame.cursor)).toEqual([4, 5]);
    // Reconnecting from the persisted cursor repeats nothing and skips nothing.
    const resumed = recorder();
    const resumedHandle = hub.subscribe({
      requestId: crypto.randomUUID(), sinceSequence: 3, send: resumed.send, onStop: resumed.onStop,
    });
    hub.flush();
    expect(eventFrames(resumed.frames).map((frame) => frame.cursor)).toEqual([4, 5]);
    expect(resumedHandle.cursor).toBe(5);
    resumedHandle.close();
    handle.close();
    hub.close();
    value.storage.close();
  });

  test('filters by project while still advancing the cursor past other projects', async () => {
    const value = await createAgentFixture();
    const otherProjectId = '10000000-0000-4000-8000-000000000009';
    value.storage.trustProject({
      id: otherProjectId,
      trustId: '30000000-0000-4000-8000-000000000009',
      name: 'Other',
      repoRoot: `${value.repo}-other`,
      gitCommonDir: `${value.repo}-other/.git`,
      mainRef: 'refs/heads/main',
      objectFormat: 'sha1',
      policyVersion: 1,
      verificationPolicyConfirmationId: 'b0000000-0000-4000-8000-000000000009',
      verificationPolicy: {
        state: value.verificationPolicy.state,
        digest: value.verificationPolicy.digest,
        mainRef: 'refs/heads/main',
        mainCommit: value.mainCommit,
      },
      trustedAt: 3,
      actor: 'local-user',
    });
    const hub = new EventSubscriptionHub({ storage: value.storage });
    const peer = recorder();
    const handle = hub.subscribe({
      requestId: crypto.randomUUID(), sinceSequence: 0, projectId: value.projectId, send: peer.send, onStop: peer.onStop,
    });
    hub.flush();
    const before = eventFrames(peer.frames).length;
    createTask(value.storage, otherProjectId, 'other');
    hub.flush();
    // The other project's events are not delivered, but they are behind the cursors afterwards.
    expect(eventFrames(peer.frames)).toHaveLength(before);
    expect(handle.cursor).toBe(value.storage.latestEventSequence());
    createTask(value.storage, value.projectId, 'mine');
    hub.flush();
    expect(eventFrames(peer.frames).slice(before).map((frame) => frame.eventType))
      .toEqual(['IntentRecorded', 'TaskCreated']);
    expect(peer.frames.flatMap((frame) => frame.type === 'event' ? [frame.event.projectId] : []))
      .toEqual(Array.from({ length: eventFrames(peer.frames).length }, () => value.projectId));
    handle.close();
    hub.close();
    value.storage.close();
  });

  test('delivers a Runtime global event to a Project-filtered subscriber with no gap or repeat', async () => {
    const value = await createAgentFixture();
    const hub = new EventSubscriptionHub({ storage: value.storage });
    const peer = recorder();
    const handle = hub.subscribe({
      requestId: crypto.randomUUID(), sinceSequence: value.storage.latestEventSequence(),
      projectId: value.projectId, send: peer.send, onStop: peer.onStop,
    });
    const start = handle.cursor;
    // A global capacity fact is written with `project_id = NULL`; a Project-filtered subscriber must
    // still receive it, because a Runtime-wide limit affects every Project (ADR-0061 D10).
    value.storage.setRuntimeCapacityLimit({
      limit: 3, commandId: 'cmd-global', payloadHash: 'p', eventId: 'evt-global-capacity',
      actor: 'local-user', updatedAt: 20,
    });
    hub.flush();
    expect(eventFrames(peer.frames).map((frame) => frame.eventType))
      .toEqual(['SchedulerGlobalCapacityChanged']);
    expect(peer.frames.flatMap((frame) => frame.type === 'event' ? [frame.event.projectId] : []))
      .toEqual([null]);
    // The cursor advances over the same single sequence, so a reconnect repeats nothing.
    expect(handle.cursor).toBe(start + 1);
    const resumed = recorder();
    hub.subscribe({
      requestId: crypto.randomUUID(), sinceSequence: handle.cursor, projectId: value.projectId,
      send: resumed.send, onStop: resumed.onStop,
    });
    hub.flush();
    expect(eventFrames(resumed.frames)).toEqual([]);
    // A Project's own events keep arriving after the global one, in sequence order.
    createTask(value.storage, value.projectId, 'after-global');
    hub.flush();
    expect(eventFrames(peer.frames).slice(1).map((frame) => frame.eventType))
      .toEqual(['IntentRecorded', 'TaskCreated']);
    handle.close();
    hub.close();
    value.storage.close();
  });

  test('rejects a cursor ahead of the log instead of silently clamping it', async () => {
    const value = await createAgentFixture();
    const hub = new EventSubscriptionHub({ storage: value.storage });
    const peer = recorder();
    const handle = hub.subscribe({
      requestId: crypto.randomUUID(), sinceSequence: 5_000, send: peer.send, onStop: peer.onStop,
    });
    expect(peer.frames).toEqual([{
      schemaVersion: 1, type: 'error', code: 'INVALID_CURSOR',
      message: `Event cursor 5000 is ahead of the Runtime log (${value.storage.latestEventSequence()})`,
    }]);
    expect(peer.stopReasons).toEqual(['INVALID_CURSOR']);
    expect(handle.active).toBe(false);
    expect(hub.subscriberCount()).toBe(0);
    hub.close();
    value.storage.close();
  });

  test('drops a subscription whose peer stopped reading', async () => {
    const value = await createAgentFixture();
    const hub = new EventSubscriptionHub({ storage: value.storage });
    const peer = recorder(false);
    hub.subscribe({ requestId: crypto.randomUUID(), send: peer.send, onStop: peer.onStop });
    // The handshake frame already failed, so no subscription was registered.
    expect(hub.subscriberCount()).toBe(0);
    const live = recorder();
    const handle = hub.subscribe({ requestId: crypto.randomUUID(), send: live.send, onStop: live.onStop });
    expect(hub.subscriberCount()).toBe(1);
    handle.close();
    expect(hub.subscriberCount()).toBe(0);
    hub.close();
    value.storage.close();
  });

  test('reports the current cursor on heartbeats', async () => {
    const value = await createAgentFixture();
    const hub = new EventSubscriptionHub({ storage: value.storage });
    const peer = recorder();
    const handle = hub.subscribe({ requestId: crypto.randomUUID(), sinceSequence: 0, send: peer.send, onStop: peer.onStop });
    hub.flush();
    hub.heartbeat();
    expect(peer.frames.at(-1)).toEqual({ schemaVersion: 1, type: 'heartbeat', cursor: handle.cursor });
    handle.close();
    hub.close();
    value.storage.close();
  });

  test('delivers without an explicit flush once the poll interval fires', async () => {
    const value = await createAgentFixture();
    const hub = new EventSubscriptionHub({ storage: value.storage, intervalMs: 10, heartbeatMs: 5_000 });
    const peer = recorder();
    hub.subscribe({ requestId: crypto.randomUUID(), send: peer.send, onStop: peer.onStop });
    createTask(value.storage, value.projectId, 'polled');
    for (let attempt = 0; attempt < 200 && eventFrames(peer.frames).length === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(eventFrames(peer.frames).map((frame) => frame.eventType))
      .toEqual(['IntentRecorded', 'TaskCreated']);
    hub.close();
    expect(hub.subscriberCount()).toBe(0);
    value.storage.close();
  });

  test('stops a subscription when the event log cannot be read', async () => {
    const value = await createAgentFixture();
    const failing = {
      latestEventSequence: () => 3,
      listEventsAfter: () => { throw new Error('log unreadable'); },
    } as unknown as Phase1Database;
    const hub = new EventSubscriptionHub({ storage: failing });
    const peer = recorder();
    const handle = hub.subscribe({ requestId: crypto.randomUUID(), sinceSequence: 0, send: peer.send, onStop: peer.onStop });
    hub.flush();
    expect(peer.frames.at(-1)).toEqual({
      schemaVersion: 1, type: 'error', code: 'EVENT_READ_FAILED', message: 'log unreadable',
    });
    expect(peer.stopReasons).toEqual(['EVENT_READ_FAILED']);
    expect(handle.active).toBe(false);
    expect(hub.subscriberCount()).toBe(0);
    hub.close();
    value.storage.close();
  });
});
