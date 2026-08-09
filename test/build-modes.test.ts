import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const buildScript = readFileSync(resolve(import.meta.dir, "../scripts/build.sh"), "utf8")

describe("build modes", () => {
  test("browser-only builds do not require the optional macOS bridge", () => {
    expect(buildScript).toContain('BUILD_MODE="browser-only"')
    expect(buildScript).toContain('[[ "$BUILD_MODE" == "browser-only" ]] || build_bridge')
  })

  test("browser-only and full build modes cannot be combined", () => {
    expect(buildScript).toContain("ERROR: --browser-only and --full are mutually exclusive.")
  })
})
