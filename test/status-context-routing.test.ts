import { describe, expect, test } from "bun:test"
import { probeExtensionReachability } from "../cli/commands/meta"
import { sendCommand } from "../cli/transport"

describe("status extension probe context routing", () => {
  test("passes the selected browser context to the reachability probe", async () => {
    let observedContext: string | undefined
    const transport = (async (_action, _tabId, contextId) => {
      observedContext = contextId
      return { result: { success: true, data: [{}] } }
    }) as typeof sendCommand

    const result = await probeExtensionReachability("interceptor-test", transport)

    expect(observedContext).toBe("interceptor-test")
    expect(result).toEqual({ reachable: true })
  })
})
