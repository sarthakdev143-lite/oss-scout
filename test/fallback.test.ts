import { describe, expect, test } from "bun:test"
import { bestFreeOpencodeModel } from "../src/models/fallback.ts"

describe("bestFreeOpencodeModel", () => {
  test("picks the first free opencode model listed", () => {
    const out = ["anthropic/claude-sonnet-5-5", "opencode/claude-fable-5-2", "opencode/deepseek-v4.1-flash-free", "opencode/hy4-flash-free", "opencode/nemotron-3.5-lightning-free"].join("\n")
    expect(bestFreeOpencodeModel(out)).toBe("opencode/deepseek-v4.1-flash-free")
  })

  test("falls back to the first opencode model when nothing is free", () => {
    expect(bestFreeOpencodeModel("opencode/claude-fable-5-2\nopencode/muse-ember-1.0")).toBe("opencode/claude-fable-5-2")
  })

  test("returns null when opencode lists no models", () => {
    expect(bestFreeOpencodeModel("")).toBe(null)
  })
})
