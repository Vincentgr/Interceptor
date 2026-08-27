export const CONTEXT_INSTANCE_STORAGE_KEY = "contextInstanceId"

export type ContextInstanceStorage = {
  get: (key: string) => Promise<Record<string, unknown>>
  set: (value: { contextInstanceId: string }) => Promise<void>
}

export async function getOrCreateContextInstanceId(
  storage: ContextInstanceStorage | undefined,
  createId: () => string = () => crypto.randomUUID(),
): Promise<string | undefined> {
  if (!storage) return undefined

  try {
    const stored = await storage.get(CONTEXT_INSTANCE_STORAGE_KEY)
    if (typeof stored.contextInstanceId === "string" && stored.contextInstanceId.length > 0) {
      return stored.contextInstanceId
    }

    const instanceId = createId()
    await storage.set({ contextInstanceId: instanceId })

    const verified = await storage.get(CONTEXT_INSTANCE_STORAGE_KEY)
    return verified.contextInstanceId === instanceId ? instanceId : undefined
  } catch {
    return undefined
  }
}
