import { createHash } from 'node:crypto';
const codeestraPermissionTitlePrefix = 'CODEESTRA_PERMISSION';

/** The question tool is a user-facing read of intent, not a side effect: STRICT never blocks it. */
const askUserQuestionTool = 'ask_user_question';

const automaticallyAllowedTools = new Set(['read', 'grep', 'find', 'ls', askUserQuestionTool]);
const approvalRequiredTools = new Set(['bash', 'powershell', 'edit', 'write']);

export type GateDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'REJECT_UNKNOWN';
export type PiPermissionMode = 'FULL' | 'STRICT';

export function classifyPiTool(toolName: string, mode: PiPermissionMode = 'FULL'): GateDecision {
  // Full mode deliberately permits every registered tool, including names Codeestra does not know.
  if (mode === 'FULL') return 'ALLOW';
  if (automaticallyAllowedTools.has(toolName)) return 'ALLOW';
  if (approvalRequiredTools.has(toolName)) return 'REQUIRE_APPROVAL';
  return 'REJECT_UNKNOWN';
}

interface ToolCallEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
}

interface GateContext {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
  };
}

interface GateExtensionApi {
  on(event: 'tool_call', handler: (
    event: ToolCallEvent,
    context: GateContext,
  ) => Promise<{ block: true; reason: string; terminate: true } | undefined>): void;
}

function serializedInput(input: unknown): string | null {
  try {
    const value = JSON.stringify(input);
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

/** Explicitly loaded with --no-extensions so no later extension can mutate an approved call. */
export default function codeestraGate(pi: GateExtensionApi): void {
  pi.on('tool_call', async (event, context) => {
    const mode: PiPermissionMode = process.env.CODEESTRA_PERMISSION_MODE === 'STRICT' ? 'STRICT' : 'FULL';
    const decision = classifyPiTool(event.toolName, mode);
    if (decision === 'ALLOW') return undefined;
    if (decision === 'REJECT_UNKNOWN') {
      return {
        block: true,
        reason: `Codeestra rejected unknown tool: ${event.toolName}`,
        terminate: true,
      };
    }
    if (context.mode !== 'rpc' || !context.hasUI) {
      return {
        block: true,
        reason: `Codeestra cannot approve ${event.toolName} without its RPC permission channel`,
        terminate: true,
      };
    }
    const input = serializedInput(event.input);
    if (input === null) {
      return {
        block: true,
        reason: `Codeestra rejected non-serializable input for ${event.toolName}`,
        terminate: true,
      };
    }
    const fingerprint = createHash('sha256').update(input).digest('hex');
    const title = `${codeestraPermissionTitlePrefix}:${event.toolCallId}:${event.toolName}:${fingerprint}`;
    const approved = await context.ui.confirm(title,
      `Allow this ${event.toolName} call once?\n\n${input}`);
    if (!approved) {
      return { block: true, reason: 'Codeestra permission denied by user', terminate: true };
    }
    return undefined;
  });
}
