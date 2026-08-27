import { describe, expect, test } from "bun:test"
import { daemonConnectErrorMessage } from "../cli/transport"

describe("daemon IPC connection diagnostics", () => {
  test("reports a blocked existing Unix socket instead of claiming the daemon is down", () => {
    const error = Object.assign(new Error("Operation not permitted"), { code: "EPERM" })

    expect(daemonConnectErrorMessage(error, {
      isWin: false,
      socketPath: "/tmp/interceptor.sock",
      socketExists: true,
    })).toContain("socket exists but this process cannot connect")
  })

  test("reports a genuinely missing daemon separately", () => {
    expect(daemonConnectErrorMessage(new Error("No such file"), {
      isWin: false,
      socketPath: "/tmp/interceptor.sock",
      socketExists: false,
    })).toContain("daemon is not reachable")
  })
})
