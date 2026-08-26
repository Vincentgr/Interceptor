#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createHash, randomBytes, randomUUID } from "node:crypto"

export type BrowserBackend = "playwright" | "brave-interceptor"
export type BrowserSensitivity = "ordinary" | "authenticated" | "sensitive"

export type BraveSlot = {
  id: string
  ready: boolean
  profileRoot: string
  profileDirectory: string
  guardPrefs: string
  contextId?: string
  instanceId?: string
}

export type BrokerConfig = {
  schema: "browser-session-broker-config-v1"
  root: string
  leaseTtlSeconds: number
  playwright: {
    command: string
    profilesRoot: string
  }
  brave: {
    appName: string
    extensionPath: string
    interceptorBin: string
    guardScript: string
    temp: string
    wsPort: number
    slots: BraveSlot[]
  }
}

export type Lease = {
  schema: "browser-session-broker-lease-v1"
  id: string
  token: string
  task: string
  backend: BrowserBackend
  sensitivity: BrowserSensitivity
  domain?: string
  account?: string
  resource?: string
  slotId?: string
  sessionName?: string
  profilePath?: string
  guardPrefs?: string
  locks: string[]
  pid: number
  acquiredAt: string
  heartbeatAt: string
}

export type AcquireOptions = {
  task: string
  sensitivity: BrowserSensitivity
  domain?: string
  account?: string
  resource?: string
}

export type BrokerStatus = {
  root: string
  leases: Array<Omit<Lease, "token"> & { stale: boolean; ageSeconds: number }>
  queue: QueueEntry[]
  braveSlots: Array<BraveSlot & { leasedBy?: string }>
}

type QueueEntry = {
  schema: "browser-session-broker-queue-v1"
  id: string
  requestedAt: string
  request: AcquireOptions
  conflicts: string[]
}

type BrokerDeps = {
  now?: () => Date
  pid?: number
  preflight?: (config: BrokerConfig, slot: BraveSlot) => { ok: boolean; reason?: string }
}

const DEFAULT_ROOT = join(homedir(), "Library", "Application Support", "Codex Browser Broker")

function fail(message: string, code = 1): never {
  const error = new Error(message) as Error & { exitCode?: number }
  error.exitCode = code
  throw error
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return normalized || "session"
}

export function backendFor(sensitivity: BrowserSensitivity): BrowserBackend {
  return sensitivity === "ordinary" ? "playwright" : "brave-interceptor"
}

function brokerRoot(explicit?: string): string {
  return resolve(explicit || process.env.BROWSER_BROKER_HOME || DEFAULT_ROOT)
}

function statePaths(root: string) {
  const state = join(root, "state")
  return {
    config: join(root, "config.json"),
    state,
    leases: join(state, "leases"),
    locks: join(state, "locks"),
    queue: join(state, "queue"),
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try { chmodSync(path, 0o700) } catch {}
}

function atomicJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path))
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(temp, path)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function listJson<T>(directory: string): T[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson<T>(join(directory, name)))
}

export function loadConfig(root?: string): BrokerConfig {
  const path = statePaths(brokerRoot(root)).config
  if (!existsSync(path)) fail(`browser broker is not initialized: ${path}`, 2)
  const config = readJson<BrokerConfig>(path)
  if (config.schema !== "browser-session-broker-config-v1") fail(`unsupported broker config: ${path}`, 2)
  return config
}

export function initializeBroker(options: {
  root?: string
  extensionPath: string
  interceptorBin?: string
  guardScript: string
  playwrightCommand?: string
  braveAppName?: string
  interceptorTemp?: string
  wsPort?: number
  leaseTtlSeconds?: number
}): BrokerConfig {
  const root = brokerRoot(options.root)
  const paths = statePaths(root)
  if (existsSync(paths.config)) fail(`broker is already initialized: ${paths.config}`, 2)
  for (const path of [root, paths.state, paths.leases, paths.locks, paths.queue]) ensurePrivateDirectory(path)
  const profilesRoot = join(root, "profiles")
  const slotsRoot = join(root, "slots")
  ensurePrivateDirectory(profilesRoot)
  ensurePrivateDirectory(slotsRoot)
  const slots = [1, 2].map((number): BraveSlot => {
    const id = `brave-${number}`
    const profileRoot = join(profilesRoot, "brave", id)
    ensurePrivateDirectory(profileRoot)
    return {
      id,
      ready: false,
      profileRoot,
      profileDirectory: "Profile 1",
      guardPrefs: join(slotsRoot, `${id}.env`),
    }
  })
  const config: BrokerConfig = {
    schema: "browser-session-broker-config-v1",
    root,
    leaseTtlSeconds: options.leaseTtlSeconds ?? 7_200,
    playwright: {
      command: options.playwrightCommand || "playwright-cli",
      profilesRoot: join(profilesRoot, "playwright"),
    },
    brave: {
      appName: options.braveAppName || "Brave Browser",
      extensionPath: resolve(options.extensionPath),
      interceptorBin: options.interceptorBin || "interceptor",
      guardScript: resolve(options.guardScript),
      temp: resolve(options.interceptorTemp || join(root, "runtime", "interceptor")),
      wsPort: options.wsPort ?? 19422,
      slots,
    },
  }
  ensurePrivateDirectory(config.playwright.profilesRoot)
  ensurePrivateDirectory(config.brave.temp)
  atomicJson(paths.config, config)
  return config
}

function envAssignment(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`
}

export function bindBraveSlot(config: BrokerConfig, options: {
  slotId: string
  contextId: string
  instanceId: string
  profileName?: string
}): BraveSlot {
  const slot = config.brave.slots.find((candidate) => candidate.id === options.slotId)
  if (!slot) fail(`unknown Brave slot: ${options.slotId}`, 2)
  const localStatePath = join(slot.profileRoot, "Local State")
  if (!existsSync(localStatePath)) fail(`Brave profile registry is missing: ${localStatePath}`, 5)
  const localState = readJson<{ profile?: { info_cache?: Record<string, { name?: string }> } }>(localStatePath)
  const preferencesPath = join(slot.profileRoot, slot.profileDirectory, "Preferences")
  const preferences = existsSync(preferencesPath)
    ? readJson<{ profile?: { name?: string } }>(preferencesPath)
    : undefined
  const profileName = options.profileName
    || localState.profile?.info_cache?.[slot.profileDirectory]?.name
    || preferences?.profile?.name
  if (!profileName) fail(`profile ${slot.profileDirectory} is not registered in ${localStatePath}`, 5)
  const securePreferencesPath = join(slot.profileRoot, slot.profileDirectory, "Secure Preferences")
  if (!existsSync(securePreferencesPath)) fail(`Secure Preferences missing: ${securePreferencesPath}`, 5)
  const securePreferences = readJson<{ extensions?: { settings?: Record<string, { path?: string }> } }>(securePreferencesPath)
  const extensionId = "hkjbaciefhhgekldhncknbjkofbpenng"
  const actualExtensionPath = securePreferences.extensions?.settings?.[extensionId]?.path
  if (actualExtensionPath !== config.brave.extensionPath) {
    fail(`isolated-profile extension path mismatch for ${slot.id}; expected ${config.brave.extensionPath}, got ${actualExtensionPath || "not installed"}`, 6)
  }
  const prefs = [
    `# Generated by browser-broker for dedicated slot ${slot.id}.`,
    envAssignment("INTERCEPTOR_TEST_BROWSER_PROFILE_NAME", profileName),
    envAssignment("INTERCEPTOR_TEST_PROFILE_DIRECTORY", slot.profileDirectory),
    envAssignment("INTERCEPTOR_TEST_CONTEXT_ID", options.contextId),
    envAssignment("INTERCEPTOR_TEST_CONTEXT_INSTANCE_ID", options.instanceId),
    envAssignment("INTERCEPTOR_TEST_EXTENSION_PATH", config.brave.extensionPath),
    envAssignment("INTERCEPTOR_BROWSER_PROFILE_ROOT", slot.profileRoot),
    envAssignment("INTERCEPTOR_BROWSER_APP_NAME", config.brave.appName),
    envAssignment("INTERCEPTOR_BIN", config.brave.interceptorBin),
    envAssignment("INTERCEPTOR_OPEN_BIN", "/usr/bin/open"),
    envAssignment("INTERCEPTOR_WS_PORT", String(config.brave.wsPort)),
    envAssignment("INTERCEPTOR_TEMP", config.brave.temp),
    "",
  ].join("\n")
  writeFileSync(slot.guardPrefs, prefs, { mode: 0o600 })
  slot.ready = true
  slot.contextId = options.contextId
  slot.instanceId = options.instanceId
  atomicJson(statePaths(config.root).config, config)
  return slot
}

type ContextDescriptor = { kind?: string; contextId?: string; instanceId?: string }

function readContexts(config: BrokerConfig): ContextDescriptor[] {
  const result = Bun.spawnSync([config.brave.interceptorBin, "contexts", "--details", "--json"], {
    env: {
      ...process.env,
      INTERCEPTOR_TEMP: config.brave.temp,
      INTERCEPTOR_WS_PORT: String(config.brave.wsPort),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    fail(result.stderr.toString().trim() || "unable to read broker Interceptor contexts", 5)
  }
  const parsed = JSON.parse(result.stdout.toString()) as unknown
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "object" && entry !== null)) {
    fail("broker Interceptor must support context descriptors with stable instance IDs", 6)
  }
  return parsed as ContextDescriptor[]
}

export async function prepareBraveSlot(config: BrokerConfig, slotId: string): Promise<BraveSlot> {
  const slot = config.brave.slots.find((candidate) => candidate.id === slotId)
  if (!slot) fail(`unknown Brave slot: ${slotId}`, 2)
  if (slot.ready) fail(`${slotId} is already configured`, 2)
  const before = new Set(readContexts(config).map((context) => `${context.contextId}:${context.instanceId || ""}`))
  const launch = Bun.spawnSync([
    "/usr/bin/open", "-g", "-na", config.brave.appName, "--args",
    `--user-data-dir=${slot.profileRoot}`,
    `--profile-directory=${slot.profileDirectory}`,
    `--load-extension=${config.brave.extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ], { stdout: "pipe", stderr: "pipe" })
  if (launch.exitCode !== 0) fail(launch.stderr.toString().trim() || `failed to launch ${slotId}`, 5)

  let discovered: ContextDescriptor | undefined
  for (let attempt = 0; attempt < 40; attempt++) {
    await Bun.sleep(500)
    const candidates = readContexts(config).filter((context) =>
      context.kind === "browser"
      && typeof context.contextId === "string"
      && typeof context.instanceId === "string"
      && !before.has(`${context.contextId}:${context.instanceId}`),
    )
    if (candidates.length === 1) { discovered = candidates[0]; break }
    if (candidates.length > 1) fail(`ambiguous context discovery while preparing ${slotId}; found ${candidates.length} new browser contexts`, 6)
  }
  if (!discovered?.contextId || !discovered.instanceId) {
    fail(`timed out waiting for a unique Interceptor context from ${slotId}`, 5)
  }
  const preferencesPath = join(slot.profileRoot, slot.profileDirectory, "Preferences")
  const securePreferencesPath = join(slot.profileRoot, slot.profileDirectory, "Secure Preferences")
  for (let attempt = 0; attempt < 20; attempt++) {
    if (existsSync(preferencesPath) && existsSync(securePreferencesPath)) break
    await Bun.sleep(250)
  }
  return bindBraveSlot(config, {
    slotId,
    contextId: discovered.contextId,
    instanceId: discovered.instanceId,
  })
}

function lockName(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function requestedLocks(options: AcquireOptions, slotId?: string): string[] {
  const domain = clean(options.domain)?.toLowerCase()
  const account = clean(options.account)?.toLowerCase()
  const resource = clean(options.resource)?.toLowerCase()
  const locks: string[] = []
  if (slotId) locks.push(`slot:${slotId}`)
  if (account) locks.push(`account:${domain || "global"}:${account}`)
  if (resource) locks.push(`resource:${resource}`)
  return [...new Set(locks)].sort()
}

function acquireLocks(root: string, leaseId: string, locks: string[]): { ok: true } | { ok: false; conflicts: string[] } {
  const paths = statePaths(root)
  const held: string[] = []
  const conflicts: string[] = []
  for (const lock of locks) {
    const path = join(paths.locks, `${lockName(lock)}.lock`)
    try {
      mkdirSync(path, { mode: 0o700 })
      atomicJson(join(path, "owner.json"), { leaseId, lock })
      held.push(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw error
      conflicts.push(lock)
    }
    if (conflicts.length > 0) break
  }
  if (conflicts.length > 0) {
    for (const path of held) rmSync(path, { recursive: true, force: true })
    return { ok: false, conflicts }
  }
  return { ok: true }
}

function defaultPreflight(config: BrokerConfig, slot: BraveSlot): { ok: boolean; reason?: string } {
  if (!slot.ready || !existsSync(slot.guardPrefs)) return { ok: false, reason: `${slot.id} is not configured` }
  const result = Bun.spawnSync(["bash", config.brave.guardScript, "preflight"], {
    env: {
      ...process.env,
      INTERCEPTOR_PROFILE_GUARD_PREFS: slot.guardPrefs,
      INTERCEPTOR_TEMP: config.brave.temp,
      INTERCEPTOR_WS_PORT: String(config.brave.wsPort),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode === 0) return { ok: true }
  return { ok: false, reason: result.stderr.toString().trim() || `${slot.id} preflight failed` }
}

function queueRequest(root: string, request: AcquireOptions, conflicts: string[], now: Date): QueueEntry {
  const entry: QueueEntry = {
    schema: "browser-session-broker-queue-v1",
    id: randomUUID(),
    requestedAt: now.toISOString(),
    request,
    conflicts,
  }
  atomicJson(join(statePaths(root).queue, `${entry.id}.json`), entry)
  return entry
}

export function acquireLease(config: BrokerConfig, raw: AcquireOptions, deps: BrokerDeps = {}): Lease {
  const task = clean(raw.task)
  if (!task) fail("--task is required", 2)
  const options: AcquireOptions = {
    task,
    sensitivity: raw.sensitivity,
    domain: clean(raw.domain),
    account: clean(raw.account),
    resource: clean(raw.resource),
  }
  if (!(["ordinary", "authenticated", "sensitive"] as string[]).includes(options.sensitivity)) {
    fail("--sensitivity must be ordinary, authenticated, or sensitive", 2)
  }
  if (options.sensitivity !== "ordinary" && !options.account && !options.resource) {
    fail("authenticated and sensitive leases require --account or --resource", 2)
  }
  const backend = backendFor(options.sensitivity)
  const now = (deps.now || (() => new Date()))()
  const id = randomUUID()
  const token = randomBytes(24).toString("base64url")
  const candidates: Array<BraveSlot | undefined> = backend === "playwright" ? [undefined] : config.brave.slots
  const unavailable: string[] = []

  for (const slot of candidates) {
    if (slot) {
      const preflight = (deps.preflight || defaultPreflight)(config, slot)
      if (!preflight.ok) {
        unavailable.push(preflight.reason || `${slot.id} unavailable`)
        continue
      }
    }
    const locks = requestedLocks(options, slot?.id)
    const acquired = acquireLocks(config.root, id, locks)
    if (!acquired.ok) {
      unavailable.push(...acquired.conflicts)
      continue
    }
    const shortId = id.replaceAll("-", "").slice(0, 8)
    const sessionName = backend === "playwright" ? `${slug(task)}-${shortId}` : undefined
    const lease: Lease = {
      schema: "browser-session-broker-lease-v1",
      id,
      token,
      task,
      backend,
      sensitivity: options.sensitivity,
      domain: options.domain,
      account: options.account,
      resource: options.resource,
      slotId: slot?.id,
      sessionName,
      profilePath: sessionName ? join(config.playwright.profilesRoot, sessionName) : undefined,
      guardPrefs: slot?.guardPrefs,
      locks,
      pid: deps.pid ?? process.pid,
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
    }
    if (lease.profilePath) ensurePrivateDirectory(lease.profilePath)
    atomicJson(join(statePaths(config.root).leases, `${id}.json`), lease)
    return lease
  }

  const queue = queueRequest(config.root, options, [...new Set(unavailable)], now)
  fail(`no browser capacity; queued request ${queue.id}: ${queue.conflicts.join("; ")}`, 75)
}

function loadLease(config: BrokerConfig, id: string): Lease {
  const path = join(statePaths(config.root).leases, `${id}.json`)
  if (!existsSync(path)) fail(`unknown lease: ${id}`, 2)
  return readJson<Lease>(path)
}

function authenticateLease(lease: Lease, token: string): void {
  if (!token || token !== lease.token) fail("invalid lease token", 13)
}

export function heartbeatLease(config: BrokerConfig, id: string, token: string, now = new Date()): Lease {
  const lease = loadLease(config, id)
  authenticateLease(lease, token)
  lease.heartbeatAt = now.toISOString()
  atomicJson(join(statePaths(config.root).leases, `${id}.json`), lease)
  return lease
}

export function releaseLease(config: BrokerConfig, id: string, token: string): void {
  const lease = loadLease(config, id)
  authenticateLease(lease, token)
  releaseLeaseFiles(config, lease)
}

function releaseLeaseFiles(config: BrokerConfig, lease: Lease): void {
  const paths = statePaths(config.root)
  for (const lock of lease.locks) {
    const path = join(paths.locks, `${lockName(lock)}.lock`)
    const ownerPath = join(path, "owner.json")
    if (!existsSync(ownerPath)) continue
    const owner = readJson<{ leaseId: string }>(ownerPath)
    if (owner.leaseId !== lease.id) fail(`lock ownership changed unexpectedly: ${lock}`, 70)
    rmSync(path, { recursive: true, force: true })
  }
  rmSync(join(paths.leases, `${lease.id}.json`), { force: true })
}

export function reclaimStaleLease(config: BrokerConfig, id: string, confirmation: string, now = new Date()): void {
  if (confirmation !== id) fail("--confirm-stale must exactly match the lease ID", 2)
  const lease = loadLease(config, id)
  const ageSeconds = (now.getTime() - new Date(lease.heartbeatAt).getTime()) / 1000
  if (ageSeconds <= config.leaseTtlSeconds) {
    fail(`lease ${id} is not stale; refuse to reclaim an active lease`, 2)
  }
  releaseLeaseFiles(config, lease)
}

export function leaseEnvironment(config: BrokerConfig, id: string, token: string): Record<string, string> {
  const lease = loadLease(config, id)
  authenticateLease(lease, token)
  const common = {
    BROWSER_BROKER_HOME: config.root,
    BROWSER_LEASE_ID: lease.id,
    BROWSER_LEASE_TOKEN: lease.token,
    BROWSER_BACKEND: lease.backend,
  }
  if (lease.backend === "playwright") {
    return {
      ...common,
      PLAYWRIGHT_CLI_SESSION: lease.sessionName!,
      PLAYWRIGHT_CLI_PROFILE: lease.profilePath!,
      PLAYWRIGHT_CLI_COMMAND: config.playwright.command,
    }
  }
  return {
    ...common,
    INTERCEPTOR_PROFILE_GUARD_PREFS: lease.guardPrefs!,
    INTERCEPTOR_TEMP: config.brave.temp,
    INTERCEPTOR_WS_PORT: String(config.brave.wsPort),
    INTERCEPTOR_BIN: config.brave.interceptorBin,
    INTERCEPTOR_GUARD_SCRIPT: config.brave.guardScript,
  }
}

export function brokerStatus(config: BrokerConfig, now = new Date()): BrokerStatus {
  const leases = listJson<Lease>(statePaths(config.root).leases)
  const decorated = leases.map((lease) => {
    const ageSeconds = Math.max(0, (now.getTime() - new Date(lease.heartbeatAt).getTime()) / 1000)
    const { token: _token, ...safeLease } = lease
    return { ...safeLease, ageSeconds, stale: ageSeconds > config.leaseTtlSeconds }
  })
  return {
    root: config.root,
    leases: decorated,
    queue: listJson<QueueEntry>(statePaths(config.root).queue),
    braveSlots: config.brave.slots.map((slot) => ({
      ...slot,
      leasedBy: decorated.find((lease) => lease.slotId === slot.id)?.task,
    })),
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function envText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n")
}

function parseArgs(argv: string[]): { command: string; values: Map<string, string>; flags: Set<string>; positionals: string[] } {
  const [command = "help", ...rest] = argv
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const positionals: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (!arg.startsWith("--")) { positionals.push(arg); continue }
    const equals = arg.indexOf("=")
    if (equals > 0) { values.set(arg.slice(2, equals), arg.slice(equals + 1)); continue }
    const next = rest[index + 1]
    if (next && !next.startsWith("--")) { values.set(arg.slice(2), next); index++; continue }
    flags.add(arg.slice(2))
  }
  return { command, values, flags, positionals }
}

function required(values: Map<string, string>, name: string): string {
  return values.get(name) || fail(`--${name} is required`, 2)
}

function help(): string {
  return `browser-broker — lease isolated browser sessions safely

Commands:
  init --extension-path PATH --guard-script PATH [--root PATH]
  prepare-slot --slot brave-1|brave-2
  bind-slot --slot ID --context ID --instance ID [--profile-name NAME]
  acquire --task NAME --sensitivity ordinary|authenticated|sensitive [--domain HOST] [--account ID] [--resource ID]
  env --lease ID --token TOKEN
  heartbeat --lease ID --token TOKEN
  release --lease ID --token TOKEN
  reclaim --lease ID --confirm-stale ID
  status

Routing:
  ordinary                 Playwright named persistent session
  authenticated|sensitive One exclusively leased Brave/Interceptor slot

Authenticated and sensitive leases require an account or resource lock. A busy
request is recorded in the queue and exits with status 75. Stale leases are
reported but never reclaimed automatically.`
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  const root = parsed.values.get("root")
  if (parsed.command === "help" || parsed.flags.has("help")) { console.log(help()); return }
  if (parsed.command === "init") {
    const config = initializeBroker({
      root,
      extensionPath: required(parsed.values, "extension-path"),
      interceptorBin: parsed.values.get("interceptor-bin"),
      guardScript: required(parsed.values, "guard-script"),
      playwrightCommand: parsed.values.get("playwright-command"),
      braveAppName: parsed.values.get("brave-app"),
      interceptorTemp: parsed.values.get("interceptor-temp"),
      wsPort: parsed.values.has("ws-port") ? Number(parsed.values.get("ws-port")) : undefined,
      leaseTtlSeconds: parsed.values.has("lease-ttl-seconds") ? Number(parsed.values.get("lease-ttl-seconds")) : undefined,
    })
    console.log(JSON.stringify(config, null, 2))
    return
  }
  const config = loadConfig(root)
  if (parsed.command === "prepare-slot") {
    console.log(JSON.stringify(await prepareBraveSlot(config, required(parsed.values, "slot")), null, 2))
    return
  }
  if (parsed.command === "bind-slot") {
    console.log(JSON.stringify(bindBraveSlot(config, {
      slotId: required(parsed.values, "slot"),
      contextId: required(parsed.values, "context"),
      instanceId: required(parsed.values, "instance"),
      profileName: parsed.values.get("profile-name"),
    }), null, 2))
    return
  }
  if (parsed.command === "acquire") {
    const lease = acquireLease(config, {
      task: required(parsed.values, "task"),
      sensitivity: required(parsed.values, "sensitivity") as BrowserSensitivity,
      domain: parsed.values.get("domain"),
      account: parsed.values.get("account"),
      resource: parsed.values.get("resource"),
    })
    console.log(JSON.stringify(lease, null, 2))
    return
  }
  if (parsed.command === "env") {
    console.log(envText(leaseEnvironment(config, required(parsed.values, "lease"), required(parsed.values, "token"))))
    return
  }
  if (parsed.command === "heartbeat") {
    console.log(JSON.stringify(heartbeatLease(config, required(parsed.values, "lease"), required(parsed.values, "token")), null, 2))
    return
  }
  if (parsed.command === "release") {
    releaseLease(config, required(parsed.values, "lease"), required(parsed.values, "token"))
    console.log("released")
    return
  }
  if (parsed.command === "reclaim") {
    reclaimStaleLease(config, required(parsed.values, "lease"), required(parsed.values, "confirm-stale"))
    console.log("reclaimed stale lease")
    return
  }
  if (parsed.command === "status") {
    console.log(JSON.stringify(brokerStatus(config), null, 2))
    return
  }
  fail(`unknown command: ${parsed.command}\n\n${help()}`, 2)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: Error & { exitCode?: number }) => {
    console.error(`browser-broker: ${error.message}`)
    process.exit(error.exitCode || 1)
  })
}
