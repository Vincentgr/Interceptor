import { describe, expect, test } from "bun:test"
import { getOrCreateContextInstanceId } from "../extension/src/background/context-identity"

function storage(initial?: string) {
  let value = initial
  return {
    get: async () => value ? { contextInstanceId: value } : {},
    set: async (next: { contextInstanceId: string }) => { value = next.contextInstanceId },
    value: () => value,
  }
}

describe("browser-profile context instance identity", () => {
  test("reuses the stable stored identity", async () => {
    const local = storage("atlas-instance")

    expect(await getOrCreateContextInstanceId(local, () => "new-instance")).toBe("atlas-instance")
  })

  test("creates and persists an identity exactly once", async () => {
    const local = storage()

    expect(await getOrCreateContextInstanceId(local, () => "atlas-instance")).toBe("atlas-instance")
    expect(local.value()).toBe("atlas-instance")
    expect(await getOrCreateContextInstanceId(local, () => "other-instance")).toBe("atlas-instance")
  })

  test("fails closed when profile-local storage cannot persist the identity", async () => {
    const local = {
      get: async () => ({}),
      set: async () => { throw new Error("storage unavailable") },
    }

    expect(await getOrCreateContextInstanceId(local, () => "ephemeral-instance")).toBeUndefined()
  })
})
