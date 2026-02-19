import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

describe("claude plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when no credentials", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })

  it("throws when credentials are unreadable", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () => "{bad json"
    ctx.host.keychain.readGenericPassword.mockReturnValue("{bad}")
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })

  it("falls back to keychain when credentials file is corrupt", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () => "{bad json"
    ctx.host.keychain.readGenericPassword.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "token", subscriptionType: "pro" } })
    )
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Session")).toBeTruthy()
  })

  it("renders usage lines from response", async () => {
    const ctx = makeCtx()
    ctx.host.fs.readText = () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "token", subscriptionType: "pro" } })
    ctx.host.fs.exists = () => true
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
        seven_day: { utilization: 20, resets_at: "2099-01-01T00:00:00.000Z" },
        extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 1000 },
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBeTruthy()
    expect(result.lines.find((line) => line.label === "Session")).toBeTruthy()
    expect(result.lines.find((line) => line.label === "Weekly")).toBeTruthy()
  })

  it("omits resetsAt when resets_at is missing", async () => {
    const ctx = makeCtx()
    ctx.host.fs.readText = () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "token", subscriptionType: "pro" } })
    ctx.host.fs.exists = () => true
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 0 },
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const sessionLine = result.lines.find((line) => line.label === "Session")
    expect(sessionLine).toBeTruthy()
    expect(sessionLine.resetsAt).toBeUndefined()
  })

  it("throws token expired on 401", async () => {
    const ctx = makeCtx()
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "token" } })
    ctx.host.fs.exists = () => true
    ctx.host.http.request.mockReturnValue({ status: 401, bodyText: "" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token expired")
  })

  it("uses keychain credentials", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => false
    ctx.host.keychain.readGenericPassword.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "token", subscriptionType: "pro" } })
    )
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        seven_day_sonnet: { utilization: 5, resets_at: "2099-01-01T00:00:00.000Z" },
        extra_usage: { is_enabled: true, used_credits: 250 },
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Sonnet")).toBeTruthy()
    expect(result.lines.find((line) => line.label === "Extra usage")).toBeTruthy()
  })

  it("uses keychain credentials when value is hex-encoded JSON", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => false
    const json = JSON.stringify({ claudeAiOauth: { accessToken: "token", subscriptionType: "pro" } }, null, 2)
    const hex = Buffer.from(json, "utf8").toString("hex")
    ctx.host.keychain.readGenericPassword.mockReturnValue(hex)
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00.000Z" },
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Session")).toBeTruthy()
  })

  it("accepts 0x-prefixed hex keychain credentials", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => false
    const json = JSON.stringify({ claudeAiOauth: { accessToken: "token", subscriptionType: "pro" } }, null, 2)
    const hex = "0x" + Buffer.from(json, "utf8").toString("hex")
    ctx.host.keychain.readGenericPassword.mockReturnValue(hex)
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00.000Z" },
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Session")).toBeTruthy()
  })

  it("decodes hex-encoded UTF-8 correctly (non-ascii json)", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => false
    const json = JSON.stringify({ claudeAiOauth: { accessToken: "token", subscriptionType: "pró" } }, null, 2)
    const hex = Buffer.from(json, "utf8").toString("hex")
    ctx.host.keychain.readGenericPassword.mockReturnValue(hex)
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00.000Z" },
      }),
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
  })

  it("decodes 3-byte and 4-byte UTF-8 in hex-encoded JSON", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => false
    const json = JSON.stringify(
      { claudeAiOauth: { accessToken: "token", subscriptionType: "pro€🙂" } },
      null,
      2
    )
    const hex = Buffer.from(json, "utf8").toString("hex")
    ctx.host.keychain.readGenericPassword.mockReturnValue(hex)
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00.000Z" },
      }),
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
  })

  it("uses custom UTF-8 decoder when TextDecoder is unavailable", async () => {
    const original = globalThis.TextDecoder
    // Force plugin to use its fallback decoder.
    // eslint-disable-next-line no-undef
    delete globalThis.TextDecoder
    try {
      const ctx = makeCtx()
      ctx.host.fs.exists = () => false
      const json = JSON.stringify(
        { claudeAiOauth: { accessToken: "token", subscriptionType: "pró€🙂" } },
        null,
        2
      )
      const hex = Buffer.from(json, "utf8").toString("hex")
      ctx.host.keychain.readGenericPassword.mockReturnValue(hex)
      ctx.host.http.request.mockReturnValue({
        status: 200,
        bodyText: JSON.stringify({
          five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00.000Z" },
        }),
      })
      const plugin = await loadPlugin()
      expect(() => plugin.probe(ctx)).not.toThrow()
    } finally {
      globalThis.TextDecoder = original
    }
  })

  it("custom decoder tolerates invalid byte sequences", async () => {
    const original = globalThis.TextDecoder
    // eslint-disable-next-line no-undef
    delete globalThis.TextDecoder
    try {
      const ctx = makeCtx()
      ctx.host.fs.exists = () => false
      // Invalid UTF-8 bytes (will produce replacement chars).
      ctx.host.keychain.readGenericPassword.mockReturnValue("c200ff")
      const plugin = await loadPlugin()
      expect(() => plugin.probe(ctx)).toThrow("Not logged in")
    } finally {
      globalThis.TextDecoder = original
    }
  })

  it("treats invalid hex credentials as not logged in", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => false
    ctx.host.keychain.readGenericPassword.mockReturnValue("0x123") // odd length
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })

  it("throws on http errors and parse failures", async () => {
    const ctx = makeCtx()
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "token" } })
    ctx.host.fs.exists = () => true
    ctx.host.http.request.mockReturnValueOnce({ status: 500, bodyText: "" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("HTTP 500")

    ctx.host.http.request.mockReturnValueOnce({ status: 200, bodyText: "not-json" })
    expect(() => plugin.probe(ctx)).toThrow("Usage response invalid")
  })

  it("throws on request errors", async () => {
    const ctx = makeCtx()
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "token" } })
    ctx.host.fs.exists = () => true
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("boom")
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed")
  })

  it("returns status when no usage data", async () => {
    const ctx = makeCtx()
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "token" } })
    ctx.host.fs.exists = () => true
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({}),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines[0].text).toBe("No usage data")
  })

  it("passes resetsAt through as ISO when present", async () => {
    const ctx = makeCtx()
    ctx.host.fs.readText = () => JSON.stringify({ claudeAiOauth: { accessToken: "token" } })
    ctx.host.fs.exists = () => true
    const now = new Date("2026-02-02T00:00:00.000Z").getTime()
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now)
    const fiveHourIso = new Date(now + 30_000).toISOString()
    const sevenDayIso = new Date(now + 5 * 60_000).toISOString()
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 10, resets_at: fiveHourIso },
        seven_day: { utilization: 20, resets_at: sevenDayIso },
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Session")?.resetsAt).toBe(fiveHourIso)
    expect(result.lines.find((line) => line.label === "Weekly")?.resetsAt).toBe(sevenDayIso)
    nowSpy.mockRestore()
  })

  it("normalizes resets_at without timezone (microseconds) into ISO for resetsAt", async () => {
    const ctx = makeCtx()
    ctx.host.fs.readText = () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "token", subscriptionType: "pro" } })
    ctx.host.fs.exists = () => true
    ctx.host.http.request.mockReturnValue({
      status: 200,
      bodyText: JSON.stringify({
        five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.123456" },
      }),
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Session")?.resetsAt).toBe(
      "2099-01-01T00:00:00.123Z"
    )
  })

  it("refreshes token when expired and persists updated credentials", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-token",
          refreshToken: "refresh",
          expiresAt: Date.now() - 1000,
          subscriptionType: "pro",
        },
      })

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/v1/oauth/token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ access_token: "new-token", expires_in: 3600, refresh_token: "refresh2" }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
        }),
      }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((line) => line.label === "Session")).toBeTruthy()
    expect(ctx.host.fs.writeText).toHaveBeenCalled()
  })

  it("refreshes keychain credentials and writes back to keychain", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => false
    ctx.host.keychain.readGenericPassword.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-token",
          refreshToken: "refresh",
          expiresAt: Date.now() - 1000,
          subscriptionType: "pro",
        },
      })
    )

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/v1/oauth/token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({ access_token: "new-token", expires_in: 3600 }),
        }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
        }),
      }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
    expect(ctx.host.keychain.writeGenericPassword).toHaveBeenCalled()
  })

  it("retries usage request after 401 by refreshing once", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60_000,
          subscriptionType: "pro",
        },
      })

    let usageCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/api/oauth/usage")) {
        usageCalls += 1
        if (usageCalls === 1) {
          return { status: 401, bodyText: "" }
        }
        return {
          status: 200,
          bodyText: JSON.stringify({
            five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
          }),
        }
      }
      // Refresh
      return {
        status: 200,
        bodyText: JSON.stringify({ access_token: "token2", expires_in: 3600 }),
      }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(usageCalls).toBe(2)
    expect(result.lines.find((line) => line.label === "Session")).toBeTruthy()
  })

  it("throws session expired when refresh returns invalid_grant", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() - 1,
        },
      })

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/v1/oauth/token")) {
        return { status: 400, bodyText: JSON.stringify({ error: "invalid_grant" }) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Session expired")
  })

  it("throws token expired when usage remains unauthorized after refresh", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60_000,
        },
      })

    let usageCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/api/oauth/usage")) {
        usageCalls += 1
        if (usageCalls === 1) return { status: 401, bodyText: "" }
        return { status: 403, bodyText: "" }
      }
      return { status: 200, bodyText: JSON.stringify({ access_token: "token2", expires_in: 3600 }) }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token expired")
  })

  it("throws token expired when refresh is unauthorized", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() - 1,
        },
      })

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/v1/oauth/token")) {
        return { status: 401, bodyText: JSON.stringify({ error: "nope" }) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token expired")
  })

  it("logs when saving keychain credentials fails", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => false
    ctx.host.keychain.readGenericPassword.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-token",
          refreshToken: "refresh",
          expiresAt: Date.now() - 1000,
        },
      })
    )
    ctx.host.keychain.writeGenericPassword.mockImplementation(() => {
      throw new Error("write fail")
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/v1/oauth/token")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: "new-token", expires_in: 3600 }) }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
        }),
      }
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("logs when saving credentials file fails", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-token",
          refreshToken: "refresh",
          expiresAt: Date.now() - 1000,
        },
      })
    ctx.host.fs.writeText.mockImplementation(() => {
      throw new Error("disk full")
    })
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/v1/oauth/token")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: "new-token", expires_in: 3600 }) }
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
        }),
      }
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
    expect(ctx.host.log.error).toHaveBeenCalled()
  })

  it("continues when refresh request throws non-string error (returns null)", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() - 1,
        },
      })

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/v1/oauth/token")) {
        throw new Error("network")
      }
      return {
        status: 200,
        bodyText: JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
        }),
      }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
  })

  it("throws usage request failed after refresh when retry errors", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60_000,
        },
      })

    let usageCalls = 0
    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/api/oauth/usage")) {
        usageCalls += 1
        if (usageCalls === 1) return { status: 401, bodyText: "" }
        throw new Error("boom")
      }
      return { status: 200, bodyText: JSON.stringify({ access_token: "token2", expires_in: 3600 }) }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed after refresh")
  })

  it("throws token expired when refresh response cannot be parsed", async () => {
    const ctx = makeCtx()
    ctx.host.fs.exists = () => true
    ctx.host.fs.readText = () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() - 1,
        },
      })

    ctx.host.http.request.mockImplementation((opts) => {
      if (String(opts.url).includes("/v1/oauth/token")) {
        return { status: 400, bodyText: "not-json" }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Token expired")
  })

  describe("token usage: JSONL scanning integration", () => {
    const CRED_JSON = JSON.stringify({ claudeAiOauth: { accessToken: "tok", subscriptionType: "pro" } })
    const USAGE_RESPONSE = JSON.stringify({
      five_hour: { utilization: 30, resets_at: "2099-01-01T00:00:00.000Z" },
      seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00.000Z" },
    })

    function makeProbeCtx({ globFiles = [], jsonlContents = {} } = {}) {
      const ctx = makeCtx()
      const fileStore = new Map()
      fileStore.set("~/.claude/.credentials.json", CRED_JSON)
      for (const [path, content] of Object.entries(jsonlContents)) {
        fileStore.set(path, content)
      }
      ctx.host.fs.exists = (path) => fileStore.has(path)
      ctx.host.fs.readText = (path) => {
        if (fileStore.has(path)) return fileStore.get(path)
        throw new Error("ENOENT: " + path)
      }
      ctx.host.fs.writeText = vi.fn((path, text) => fileStore.set(path, text))
      ctx.host.fs.glob = vi.fn(() => globFiles)
      ctx.host.http.request.mockReturnValue({ status: 200, bodyText: USAGE_RESPONSE })
      return ctx
    }

    it("adds no token lines when glob returns no files", async () => {
      const ctx = makeProbeCtx({ globFiles: [] })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      expect(result.lines.find((l) => l.label === "Today")).toBeUndefined()
      expect(result.lines.find((l) => l.label === "Last 30 days")).toBeUndefined()
    })

    it("rate-limit lines still appear when glob returns no files", async () => {
      const ctx = makeProbeCtx({ globFiles: [] })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      expect(result.lines.find((l) => l.label === "Session")).toBeTruthy()
    })

    it("adds Today line from a JSONL file with today's usage", async () => {
      const today = new Date().toISOString()
      const jsonlLine = JSON.stringify({
        type: "assistant",
        requestId: "req_001",
        timestamp: today,
        message: {
          id: "msg_001",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      })
      const filePath = "/Users/x/.claude/projects/proj/session.jsonl"
      const ctx = makeProbeCtx({
        globFiles: [{ path: filePath, size: jsonlLine.length, mtimeMs: Date.now() }],
        jsonlContents: { [filePath]: jsonlLine + "\n" },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      const todayLine = result.lines.find((l) => l.label === "Today")
      expect(todayLine).toBeTruthy()
      expect(todayLine.type).toBe("text")
      expect(todayLine.value).toContain("tokens")
    })

    it("deduplicates streaming chunks by request", async () => {
      const today = new Date().toISOString()
      const makeEntry = (outputTokens) => JSON.stringify({
        type: "assistant",
        requestId: "req_stream",
        timestamp: today,
        message: {
          id: "msg_stream",
          model: "claude-opus-4-5",
          usage: { input_tokens: 100, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })
      const jsonlContent = [makeEntry(1), makeEntry(1), makeEntry(200)].join("\n") + "\n"
      const filePath = "/Users/x/.claude/projects/proj/session.jsonl"
      const ctx = makeProbeCtx({
        globFiles: [{ path: filePath, size: jsonlContent.length, mtimeMs: Date.now() }],
        jsonlContents: { [filePath]: jsonlContent },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      const todayLine = result.lines.find((l) => l.label === "Today")
      expect(todayLine).toBeTruthy()
      expect(todayLine.value).toContain("300 tokens")
    })

    it("skips unchanged files on rescan (cache hit)", async () => {
      const today = new Date().toISOString()
      const jsonlLine = JSON.stringify({
        type: "assistant",
        requestId: "req_001",
        timestamp: today,
        message: { id: "msg_001", model: "claude-opus-4-5", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      })
      const filePath = "/Users/x/.claude/projects/proj/session.jsonl"
      const globFile = { path: filePath, size: jsonlLine.length, mtimeMs: 1000 }
      const ctx = makeProbeCtx({
        globFiles: [globFile],
        jsonlContents: { [filePath]: jsonlLine + "\n" },
      })
      const plugin = await loadPlugin()
      plugin.probe(ctx)

      const globSpy = ctx.host.fs.glob
      const callsAfterFirst = globSpy.mock.calls.length
      expect(callsAfterFirst).toBeGreaterThan(0)

      plugin.probe(ctx)

      expect(globSpy).toHaveBeenCalledTimes(callsAfterFirst)
    })

    it("includes cost in Today line when model pricing is known", async () => {
      const today = new Date().toISOString()
      const jsonlLine = JSON.stringify({
        type: "assistant",
        requestId: "req_cost",
        timestamp: today,
        message: {
          id: "msg_cost",
          model: "claude-opus-4-5",
          usage: { input_tokens: 1000000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })
      const filePath = "/Users/x/.claude/projects/proj/session.jsonl"
      const ctx = makeProbeCtx({
        globFiles: [{ path: filePath, size: jsonlLine.length, mtimeMs: Date.now() }],
        jsonlContents: { [filePath]: jsonlLine + "\n" },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      const todayLine = result.lines.find((l) => l.label === "Today")
      expect(todayLine).toBeTruthy()
      expect(todayLine.value).toContain("$5.00")
      expect(todayLine.value).toContain("1M tokens")
    })

    it("omits cost but shows tokens when model is unknown", async () => {
      const today = new Date().toISOString()
      const jsonlLine = JSON.stringify({
        type: "assistant",
        requestId: "req_unk",
        timestamp: today,
        message: {
          id: "msg_unk",
          model: "claude-future-model-9000",
          usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })
      const filePath = "/Users/x/.claude/projects/proj/session.jsonl"
      const ctx = makeProbeCtx({
        globFiles: [{ path: filePath, size: jsonlLine.length, mtimeMs: Date.now() }],
        jsonlContents: { [filePath]: jsonlLine + "\n" },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      const todayLine = result.lines.find((l) => l.label === "Today")
      expect(todayLine).toBeTruthy()
      expect(todayLine.value).not.toContain("$")
      expect(todayLine.value).toContain("tokens")
    })

    it("gracefully handles glob failure", async () => {
      const ctx = makeCtx()
      ctx.host.fs.exists = (path) => path === "~/.claude/.credentials.json"
      ctx.host.fs.readText = () => CRED_JSON
      ctx.host.fs.writeText = vi.fn()
      ctx.host.fs.glob = vi.fn(() => { throw new Error("permission denied") })
      ctx.host.http.request.mockReturnValue({ status: 200, bodyText: USAGE_RESPONSE })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      expect(result.lines.find((l) => l.label === "Session")).toBeTruthy()
      expect(result.lines.find((l) => l.label === "Today")).toBeUndefined()
    })

    it("gracefully handles JSONL read failure", async () => {
      const today = new Date().toISOString()
      const goodJsonl = JSON.stringify({
        type: "assistant",
        requestId: "req_good",
        timestamp: today,
        message: { id: "msg_good", model: "claude-opus-4-5", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }) + "\n"
      const badPath = "/Users/x/.claude/projects/bad/session.jsonl"
      const goodPath = "/Users/x/.claude/projects/good/session.jsonl"
      const ctx = makeProbeCtx({
        globFiles: [
          { path: badPath, size: 10, mtimeMs: Date.now() },
          { path: goodPath, size: goodJsonl.length, mtimeMs: Date.now() },
        ],
        jsonlContents: { [goodPath]: goodJsonl },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      const todayLine = result.lines.find((l) => l.label === "Today")
      expect(todayLine).toBeTruthy()
      expect(todayLine.value).toContain("tokens")
    })

    it("normalizes anthropic. prefixed model names", async () => {
      const today = new Date().toISOString()
      const jsonlLine = JSON.stringify({
        type: "assistant",
        requestId: "req_norm",
        timestamp: today,
        message: {
          id: "msg_norm",
          model: "anthropic.claude-opus-4-5",
          usage: { input_tokens: 1000000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })
      const filePath = "/Users/x/.claude/projects/proj/session.jsonl"
      const ctx = makeProbeCtx({
        globFiles: [{ path: filePath, size: jsonlLine.length, mtimeMs: Date.now() }],
        jsonlContents: { [filePath]: jsonlLine + "\n" },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      const todayLine = result.lines.find((l) => l.label === "Today")
      expect(todayLine).toBeTruthy()
      expect(todayLine.value).toContain("$5.00")
    })

    it("normalizes dated model names (claude-sonnet-4-5-20250929 → claude-sonnet-4-5)", async () => {
      const today = new Date().toISOString()
      const jsonlLine = JSON.stringify({
        type: "assistant",
        requestId: "req_dated",
        timestamp: today,
        message: {
          id: "msg_dated",
          model: "claude-sonnet-4-5-20250929",
          usage: { input_tokens: 1000000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })
      const filePath = "/Users/x/.claude/projects/proj/session.jsonl"
      const ctx = makeProbeCtx({
        globFiles: [{ path: filePath, size: jsonlLine.length, mtimeMs: Date.now() }],
        jsonlContents: { [filePath]: jsonlLine + "\n" },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      const todayLine = result.lines.find((l) => l.label === "Today")
      expect(todayLine).toBeTruthy()
      expect(todayLine.value).toContain("$5.40")
    })

    it("oversized file clears stale cache entry", async () => {
      const filePath = "/Users/x/.claude/projects/proj/big.jsonl"
      const todayKey = new Date().toISOString().slice(0, 10)
      const cachePath = "/tmp/openusage-test/plugin/token-cache.json"
      const preCache = {
        version: 1,
        lastScanMs: 0,
        files: {
          [filePath]: { size: 100, mtimeMs: 1000, days: { [todayKey]: { "claude-opus-4-5": [100, 0, 0, 50, 0] } } },
        },
        days: { [todayKey]: { "claude-opus-4-5": [100, 0, 0, 50, 0] } },
      }
      const ctx = makeProbeCtx({
        globFiles: [{ path: filePath, size: 110 * 1024 * 1024, mtimeMs: 1000 }],
        jsonlContents: { [cachePath]: JSON.stringify(preCache) },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      expect(result.lines.find((l) => l.label === "Today")).toBeUndefined()
    })

    it("scan failure preserves old cached data", async () => {
      const filePath = "/Users/x/.claude/projects/proj/stale.jsonl"
      const todayKey = new Date().toISOString().slice(0, 10)
      const cachePath = "/tmp/openusage-test/plugin/token-cache.json"
      const preCache = {
        version: 1,
        lastScanMs: 0,
        files: {
          [filePath]: { size: 100, mtimeMs: 1000, days: { [todayKey]: { "claude-opus-4-5": [200, 0, 0, 100, 0] } } },
        },
        days: { [todayKey]: { "claude-opus-4-5": [200, 0, 0, 100, 0] } },
      }
      const ctx = makeProbeCtx({
        globFiles: [{ path: filePath, size: 100, mtimeMs: 2000 }],
        jsonlContents: { [cachePath]: JSON.stringify(preCache) },
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      expect(result.lines.find((l) => l.label === "Today")).toBeTruthy()
    })

    it("reads CLAUDE_CONFIG_DIR and scans its projects subdir", async () => {
      const today = new Date().toISOString()
      const jsonlLine = JSON.stringify({
        type: "assistant",
        requestId: "req_custom",
        timestamp: today,
        message: {
          id: "msg_custom",
          model: "claude-opus-4-5",
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })
      const customFilePath = "/custom/config/projects/proj/session.jsonl"
      const ctx = makeProbeCtx({
        globFiles: [],
        jsonlContents: { [customFilePath]: jsonlLine + "\n" },
      })
      ctx.host.env.get = vi.fn((name) => name === "CLAUDE_CONFIG_DIR" ? "/custom/config" : null)
      ctx.host.fs.glob = vi.fn((root, pattern) => {
        if (root === "/custom/config/projects") {
          return [{ path: customFilePath, size: jsonlLine.length, mtimeMs: Date.now() }]
        }
        return []
      })
      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)
      const todayLine = result.lines.find((l) => l.label === "Today")
      expect(todayLine).toBeTruthy()
      expect(todayLine.value).toContain("tokens")
    })
  })
})
