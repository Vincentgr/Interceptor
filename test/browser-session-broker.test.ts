import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  acquireLease,
  backendFor,
  brokerStatus,
  heartbeatLease,
  initializeBroker,
  leaseEnvironment,
  reclaimStaleLease,
  releaseLease,
  slug,
} from "../scripts/browser-session-broker"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "browser-broker-"))
  roots.push(root)
  const config = initializeBroker({
    root,
    extensionPath: join(root, "extension"),
    guardScript: join(root, "profile-context-guard.sh"),
    leaseTtlSeconds: 60,
  })
  config.brave.slots.forEach((slot) => { slot.ready = true })
  return config
}

const ready = () => ({ ok: true })

describe("browser session broker", () => {
  test("routes ordinary work to named Playwright sessions and sensitive work to Brave", () => {
    expect(backendFor("ordinary")).toBe("playwright")
    expect(backendFor("authenticated")).toBe("brave-interceptor")
    expect(backendFor("sensitive")).toBe("brave-interceptor")
    expect(slug("Workday / Plaintiff Portal")).toBe("workday-plaintiff-portal")
  })

  test("creates independent named persistent Playwright leases", () => {
    const config = fixture()
    const first = acquireLease(config, { task: "public research A", sensitivity: "ordinary" })
    const second = acquireLease(config, { task: "public research B", sensitivity: "ordinary" })

    expect(first.backend).toBe("playwright")
    expect(second.backend).toBe("playwright")
    expect(first.sessionName).not.toBe(second.sessionName)
    expect(first.profilePath).not.toBe(second.profilePath)
    expect(first.locks).toEqual([])
    const env = leaseEnvironment(config, first.id, first.token)
    expect(env.PLAYWRIGHT_CLI_SESSION).toBe(first.sessionName!)
    expect(env.PLAYWRIGHT_CLI_PROFILE).toBe(first.profilePath!)
  })

  test("leases the two Brave slots exclusively", () => {
    const config = fixture()
    const first = acquireLease(config, {
      task: "legal portal A", sensitivity: "sensitive", resource: "portal:case-a",
    }, { preflight: ready })
    const second = acquireLease(config, {
      task: "bank portal B", sensitivity: "authenticated", resource: "portal:case-b",
    }, { preflight: ready })

    expect(first.slotId).toBe("brave-1")
    expect(second.slotId).toBe("brave-2")
    expect(() => acquireLease(config, {
      task: "third portal", sensitivity: "sensitive", resource: "portal:case-c",
    }, { preflight: ready })).toThrow("no browser capacity")
    expect(brokerStatus(config).queue).toHaveLength(1)
  })

  test("account and resource locks prevent conflicting remote edits across backends", () => {
    const config = fixture()
    const first = acquireLease(config, {
      task: "account edit", sensitivity: "ordinary", domain: "example.test", account: "Greg",
    })
    expect(() => acquireLease(config, {
      task: "same account", sensitivity: "sensitive", domain: "EXAMPLE.TEST", account: "greg",
    }, { preflight: ready })).toThrow("no browser capacity")

    releaseLease(config, first.id, first.token)
    const next = acquireLease(config, {
      task: "same account after release", sensitivity: "sensitive", domain: "example.test", account: "greg",
    }, { preflight: ready })
    expect(next.slotId).toBe("brave-1")
  })

  test("requires an explicit remote lock for authenticated and sensitive work", () => {
    const config = fixture()
    expect(() => acquireLease(config, {
      task: "unsafe", sensitivity: "sensitive",
    }, { preflight: ready })).toThrow("require --account or --resource")
  })

  test("release requires the capability token and does not disturb other leases", () => {
    const config = fixture()
    const first = acquireLease(config, { task: "one", sensitivity: "ordinary", resource: "r1" })
    const second = acquireLease(config, { task: "two", sensitivity: "ordinary", resource: "r2" })

    expect(() => releaseLease(config, first.id, "wrong")).toThrow("invalid lease token")
    expect(brokerStatus(config).leases[0]).not.toHaveProperty("token")
    releaseLease(config, first.id, first.token)
    expect(brokerStatus(config).leases.map((lease) => lease.id)).toEqual([second.id])
  })

  test("heartbeat extends a lease and stale leases are never reclaimed automatically", () => {
    const config = fixture()
    const start = new Date("2026-08-26T12:00:00Z")
    const lease = acquireLease(config, { task: "long task", sensitivity: "ordinary" }, { now: () => start })
    expect(brokerStatus(config, new Date("2026-08-26T12:02:00Z")).leases[0].stale).toBe(true)

    heartbeatLease(config, lease.id, lease.token, new Date("2026-08-26T12:01:30Z"))
    expect(brokerStatus(config, new Date("2026-08-26T12:02:00Z")).leases[0].stale).toBe(false)
  })

  test("manual reclaim requires both staleness and an exact lease-ID confirmation", () => {
    const config = fixture()
    const start = new Date("2026-08-26T12:00:00Z")
    const lease = acquireLease(config, {
      task: "abandoned", sensitivity: "sensitive", resource: "stale-resource",
    }, { now: () => start, preflight: ready })

    expect(() => reclaimStaleLease(config, lease.id, "wrong", new Date("2026-08-26T12:02:00Z"))).toThrow("exactly match")
    expect(() => reclaimStaleLease(config, lease.id, lease.id, new Date("2026-08-26T12:00:30Z"))).toThrow("not stale")
    reclaimStaleLease(config, lease.id, lease.id, new Date("2026-08-26T12:02:00Z"))
    expect(brokerStatus(config).leases).toEqual([])
  })
})
