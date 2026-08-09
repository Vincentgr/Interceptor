import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { instanceId?: string; interceptorExit?: number; duplicateAtlas?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "interceptor-profile-guard-"))
  roots.push(root)
  const chromeRoot = join(root, "Chrome")
  const profileDir = join(chromeRoot, "Profile 8")
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(chromeRoot, "Local State"), JSON.stringify({
    profile: {
      info_cache: {
        "Profile 8": { name: "Atlas" },
        ...(options.duplicateAtlas ? { "Profile 9": { name: "Atlas" } } : {}),
      },
    },
  }))
  writeFileSync(join(profileDir, "Secure Preferences"), JSON.stringify({
    extensions: {
      settings: {
        hkjbaciefhhgekldhncknbjkofbpenng: { path: "/fixture/interceptor/extension/dist" },
      },
    },
  }))

  const prefs = join(root, "preferences.env")
  const fakeInterceptor = join(root, "interceptor")
  writeFileSync(prefs, [
    'export INTERCEPTOR_TEST_CHROME_PROFILE_NAME="Atlas"',
    'export INTERCEPTOR_TEST_CONTEXT_ID="interceptor-test"',
    'export INTERCEPTOR_TEST_CONTEXT_INSTANCE_ID="atlas-instance"',
    'export INTERCEPTOR_TEST_EXTENSION_PATH="/fixture/interceptor/extension/dist"',
    `export INTERCEPTOR_BROWSER_PROFILE_ROOT="${chromeRoot}"`,
    `export INTERCEPTOR_BIN="${fakeInterceptor}"`,
    "",
  ].join("\n"))

  if ((options.interceptorExit ?? 0) === 0) {
    writeFileSync(fakeInterceptor, `#!/bin/sh\nprintf '%s\\n' '[{"contextId":"interceptor-test","instanceId":"${options.instanceId ?? "atlas-instance"}","kind":"browser"}]'\n`)
  } else {
    writeFileSync(fakeInterceptor, "#!/bin/sh\necho 'daemon socket exists but this process cannot connect' >&2\nexit 1\n")
  }
  chmodSync(fakeInterceptor, 0o755)

  const result = Bun.spawnSync([
    "bash",
    join(import.meta.dir, "../scripts/profile-context-guard.sh"),
    "preflight",
  ], {
    env: { ...process.env, INTERCEPTOR_PROFILE_GUARD_PREFS: prefs },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe("profile context guard", () => {
  test("proves the Atlas profile, extension, context, and stable instance binding", () => {
    const result = fixture()

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('READY profile="Atlas" directory="Profile 8"')
  })

  test("fails closed when the context belongs to a different browser-profile instance", () => {
    const result = fixture({ instanceId: "other-instance" })

    expect(result.exitCode).toBe(6)
    expect(result.stderr).toContain("context instance mismatch")
  })

  test("classifies sandbox IPC denial without claiming UUID rotation", () => {
    const result = fixture({ interceptorExit: 1 })

    expect(result.exitCode).toBe(9)
    expect(result.stderr).toContain("outside the execution sandbox")
    expect(result.stderr).not.toContain("UUID")
  })

  test("rejects an ambiguous Chrome display name", () => {
    const result = fixture({ duplicateAtlas: true })

    expect(result.exitCode).toBe(7)
    expect(result.stderr).toContain("expected exactly one Chrome profile named")
  })
})
