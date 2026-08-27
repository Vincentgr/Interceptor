export type ContextSocket = {
  send: (data: string) => void
  __contextId?: string
  __contextInstanceId?: string
  __native?: boolean
}

export type ContextDescriptor = {
  contextId: string
  instanceId?: string
  kind: "browser" | "runtime"
}

export type ContextConflictMessage = {
  type: "context_conflict"
  contextId: string
  error: string
}

export type ContextRegisteredMessage = {
  type: "context_registered"
  contextId: string
}

export type ContextClaimResult =
  | {
      status: "registered"
      contextId: string
      previousContextId?: string
      message: ContextRegisteredMessage
    }
  | {
      status: "conflict"
      contextId: string
      message: ContextConflictMessage
    }

export function contextConflictMessage(contextId: string): ContextConflictMessage {
  return {
    type: "context_conflict",
    contextId,
    error: `context '${contextId}' is already in use`,
  }
}

export function contextRegisteredMessage(contextId: string): ContextRegisteredMessage {
  return {
    type: "context_registered",
    contextId,
  }
}

export function contextDescriptor(contextId: string, socket: ContextSocket): ContextDescriptor {
  return {
    contextId,
    ...(socket.__contextInstanceId ? { instanceId: socket.__contextInstanceId } : {}),
    kind: contextId.startsWith("runtime:") ? "runtime" : "browser",
  }
}

export function claimContextId(
  contextMap: Map<string, ContextSocket>,
  ws: ContextSocket,
  contextId: string,
  instanceId?: string,
): ContextClaimResult {
  const existing = contextMap.get(contextId)
  if (existing && existing !== ws) {
    return {
      status: "conflict",
      contextId,
      message: contextConflictMessage(contextId),
    }
  }

  if (instanceId) {
    for (const [claimedContextId, claimedSocket] of contextMap.entries()) {
      if (claimedSocket !== ws && claimedSocket.__contextInstanceId === instanceId) {
        return {
          status: "conflict",
          contextId,
          message: {
            type: "context_conflict",
            contextId,
            error: `browser profile instance '${instanceId}' is already registered as context '${claimedContextId}'`,
          },
        }
      }
    }
  }

  const previousContextId = ws.__contextId
  if (previousContextId && previousContextId !== contextId && contextMap.get(previousContextId) === ws) {
    contextMap.delete(previousContextId)
  }

  ws.__contextId = contextId
  if (instanceId) ws.__contextInstanceId = instanceId
  contextMap.set(contextId, ws)

  return {
    status: "registered",
    contextId,
    previousContextId: previousContextId && previousContextId !== contextId ? previousContextId : undefined,
    message: contextRegisteredMessage(contextId),
  }
}
