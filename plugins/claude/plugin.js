(function () {
  const CRED_FILE = "~/.claude/.credentials.json"
  const KEYCHAIN_SERVICE = "Claude Code-credentials"
  const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
  const REFRESH_URL = "https://platform.claude.com/v1/oauth/token"
  const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
  const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers"
  const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 minutes before expiration

  function utf8DecodeBytes(bytes) {
    // Prefer native TextDecoder when available (QuickJS may not expose it).
    if (typeof TextDecoder !== "undefined") {
      try {
        return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes))
      } catch {}
    }

    // Minimal UTF-8 decoder (replacement char on invalid sequences).
    let out = ""
    for (let i = 0; i < bytes.length; ) {
      const b0 = bytes[i] & 0xff
      if (b0 < 0x80) {
        out += String.fromCharCode(b0)
        i += 1
        continue
      }

      // 2-byte
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        if (i + 1 >= bytes.length) {
          out += "\ufffd"
          break
        }
        const b1 = bytes[i + 1] & 0xff
        if ((b1 & 0xc0) !== 0x80) {
          out += "\ufffd"
          i += 1
          continue
        }
        const cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f)
        out += String.fromCharCode(cp)
        i += 2
        continue
      }

      // 3-byte
      if (b0 >= 0xe0 && b0 <= 0xef) {
        if (i + 2 >= bytes.length) {
          out += "\ufffd"
          break
        }
        const b1 = bytes[i + 1] & 0xff
        const b2 = bytes[i + 2] & 0xff
        const validCont = (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80
        const notOverlong = !(b0 === 0xe0 && b1 < 0xa0)
        const notSurrogate = !(b0 === 0xed && b1 >= 0xa0)
        if (!validCont || !notOverlong || !notSurrogate) {
          out += "\ufffd"
          i += 1
          continue
        }
        const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)
        out += String.fromCharCode(cp)
        i += 3
        continue
      }

      // 4-byte
      if (b0 >= 0xf0 && b0 <= 0xf4) {
        if (i + 3 >= bytes.length) {
          out += "\ufffd"
          break
        }
        const b1 = bytes[i + 1] & 0xff
        const b2 = bytes[i + 2] & 0xff
        const b3 = bytes[i + 3] & 0xff
        const validCont = (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80
        const notOverlong = !(b0 === 0xf0 && b1 < 0x90)
        const notTooHigh = !(b0 === 0xf4 && b1 > 0x8f)
        if (!validCont || !notOverlong || !notTooHigh) {
          out += "\ufffd"
          i += 1
          continue
        }
        const cp =
          ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)
        const n = cp - 0x10000
        out += String.fromCharCode(0xd800 + ((n >> 10) & 0x3ff), 0xdc00 + (n & 0x3ff))
        i += 4
        continue
      }

      out += "\ufffd"
      i += 1
    }
    return out
  }

  function tryParseCredentialJSON(ctx, text) {
    if (!text) return null
    const parsed = ctx.util.tryParseJson(text)
    if (parsed) return parsed

    // Some macOS keychain items are returned by `security ... -w` as hex-encoded UTF-8 bytes.
    // Example prefix: "7b0a" ( "{\\n" ).
    // Support both plain hex and "0x..." forms.
    let hex = String(text).trim()
    if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2)
    if (!hex || hex.length % 2 !== 0) return null
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null
    try {
      const bytes = []
      for (let i = 0; i < hex.length; i += 2) {
        bytes.push(parseInt(hex.slice(i, i + 2), 16))
      }
      const decoded = utf8DecodeBytes(bytes)
      const decodedParsed = ctx.util.tryParseJson(decoded)
      if (decodedParsed) return decodedParsed
    } catch {}

    return null
  }

  function loadCredentials(ctx) {
    // Try file first
    if (ctx.host.fs.exists(CRED_FILE)) {
      try {
        const text = ctx.host.fs.readText(CRED_FILE)
        const parsed = tryParseCredentialJSON(ctx, text)
        if (parsed) {
          const oauth = parsed.claudeAiOauth
          if (oauth && oauth.accessToken) {
            ctx.host.log.info("credentials loaded from file")
            return { oauth, source: "file", fullData: parsed }
          }
        }
        ctx.host.log.warn("credentials file exists but no valid oauth data")
      } catch (e) {
        ctx.host.log.warn("credentials file read failed: " + String(e))
      }
    }

    // Try keychain fallback
    try {
      const keychainValue = ctx.host.keychain.readGenericPassword(KEYCHAIN_SERVICE)
      if (keychainValue) {
        const parsed = tryParseCredentialJSON(ctx, keychainValue)
        if (parsed) {
          const oauth = parsed.claudeAiOauth
          if (oauth && oauth.accessToken) {
            ctx.host.log.info("credentials loaded from keychain")
            return { oauth, source: "keychain", fullData: parsed }
          }
        }
        ctx.host.log.warn("keychain has data but no valid oauth")
      }
    } catch (e) {
      ctx.host.log.info("keychain read failed (may not exist): " + String(e))
    }

    ctx.host.log.warn("no credentials found")
    return null
  }

  function saveCredentials(ctx, source, fullData) {
    // MUST use minified JSON - macOS `security -w` hex-encodes values with newlines,
    // which Claude Code can't read back, causing it to invalidate the session.
    const text = JSON.stringify(fullData)
    if (source === "file") {
      try {
        ctx.host.fs.writeText(CRED_FILE, text)
      } catch (e) {
        ctx.host.log.error("Failed to write Claude credentials file: " + String(e))
      }
    } else if (source === "keychain") {
      try {
        ctx.host.keychain.writeGenericPassword(KEYCHAIN_SERVICE, text)
      } catch (e) {
        ctx.host.log.error("Failed to write Claude credentials keychain: " + String(e))
      }
    }
  }

  function needsRefresh(ctx, oauth, nowMs) {
    return ctx.util.needsRefreshByExpiry({
      nowMs,
      expiresAtMs: oauth.expiresAt,
      bufferMs: REFRESH_BUFFER_MS,
    })
  }

  function refreshToken(ctx, creds) {
    const { oauth, source, fullData } = creds
    if (!oauth.refreshToken) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    ctx.host.log.info("attempting token refresh")
    try {
      const resp = ctx.util.request({
        method: "POST",
        url: REFRESH_URL,
        headers: { "Content-Type": "application/json" },
        bodyText: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: oauth.refreshToken,
          client_id: CLIENT_ID,
          scope: SCOPES,
        }),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401) {
        let errorCode = null
        const body = ctx.util.tryParseJson(resp.bodyText)
        if (body) errorCode = body.error || body.error_description
        ctx.host.log.error("refresh failed: status=" + resp.status + " error=" + String(errorCode))
        if (errorCode === "invalid_grant") {
          throw "Session expired. Run `claude` to log in again."
        }
        throw "Token expired. Run `claude` to log in again."
      }
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("refresh returned unexpected status: " + resp.status)
        return null
      }

      const body = ctx.util.tryParseJson(resp.bodyText)
      if (!body) {
        ctx.host.log.warn("refresh response not valid JSON")
        return null
      }
      const newAccessToken = body.access_token
      if (!newAccessToken) {
        ctx.host.log.warn("refresh response missing access_token")
        return null
      }

      // Update oauth credentials
      oauth.accessToken = newAccessToken
      if (body.refresh_token) oauth.refreshToken = body.refresh_token
      if (typeof body.expires_in === "number") {
        oauth.expiresAt = Date.now() + body.expires_in * 1000
      }

      // Persist updated credentials
      fullData.claudeAiOauth = oauth
      saveCredentials(ctx, source, fullData)

      ctx.host.log.info("refresh succeeded, new token expires in " + (body.expires_in || "unknown") + "s")
      return newAccessToken
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("refresh exception: " + String(e))
      return null
    }
  }

  function fetchUsage(ctx, accessToken) {
    return ctx.util.request({
      method: "GET",
      url: USAGE_URL,
      headers: {
        Authorization: "Bearer " + accessToken.trim(),
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "OpenUsage",
      },
      timeoutMs: 10000,
    })
  }

  const TOKEN_SCAN_MAX_FILE_BYTES = 100 * 1024 * 1024
  const TOKEN_CACHE_VERSION = 1
  const TOKEN_SCAN_MIN_INTERVAL_MS = 60 * 1000

  const CLAUDE_PRICING = {
    "claude-haiku-4-5-20251001": { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheCreate: 1.25e-6 },
    "claude-haiku-4-5": { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheCreate: 1.25e-6 },
    "claude-opus-4-5-20251101": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheCreate: 6.25e-6 },
    "claude-opus-4-5": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheCreate: 6.25e-6 },
    "claude-opus-4-6-20260205": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheCreate: 6.25e-6 },
    "claude-opus-4-6": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheCreate: 6.25e-6 },
    "claude-sonnet-4-6": {
      input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheCreate: 3.75e-6,
      threshold: 200000, inputAbove: 6e-6, outputAbove: 2.25e-5, cacheReadAbove: 6e-7, cacheCreateAbove: 7.5e-6,
    },
    "claude-sonnet-4-5-20250929": {
      input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheCreate: 3.75e-6,
      threshold: 200000, inputAbove: 6e-6, outputAbove: 2.25e-5, cacheReadAbove: 6e-7, cacheCreateAbove: 7.5e-6,
    },
    "claude-sonnet-4-5": {
      input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheCreate: 3.75e-6,
      threshold: 200000, inputAbove: 6e-6, outputAbove: 2.25e-5, cacheReadAbove: 6e-7, cacheCreateAbove: 7.5e-6,
    },
    "claude-opus-4-20250514": { input: 1.5e-5, output: 7.5e-5, cacheRead: 1.5e-6, cacheCreate: 1.875e-5 },
    "claude-opus-4-1": { input: 1.5e-5, output: 7.5e-5, cacheRead: 1.5e-6, cacheCreate: 1.875e-5 },
    "claude-sonnet-4-20250514": {
      input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheCreate: 3.75e-6,
      threshold: 200000, inputAbove: 6e-6, outputAbove: 2.25e-5, cacheReadAbove: 6e-7, cacheCreateAbove: 7.5e-6,
    },
  }

  function normalizeClaudeModel(raw) {
    if (!raw) return raw
    let model = String(raw).trim()
    if (model.indexOf("anthropic.") === 0) model = model.slice("anthropic.".length)

    const lastDot = model.lastIndexOf(".")
    if (lastDot >= 0 && model.slice(lastDot + 1).indexOf("claude-") === 0) {
      model = model.slice(lastDot + 1)
    }

    model = model.replace(/-v\d+:\d+$/, "")
    const atIdx = model.indexOf("@")
    if (atIdx >= 0) model = model.slice(0, atIdx)

    const dateMatch = model.match(/^(.+)-(\d{8})$/)
    if (dateMatch && CLAUDE_PRICING[dateMatch[1]]) return dateMatch[1]
    return model
  }

  function claudeCostUSD(model, inputTokens, cacheRead, cacheCreate, outputTokens) {
    const pricing = CLAUDE_PRICING[model]
    if (!pricing) return null

    function tiered(tokens, base, above, threshold) {
      if (!threshold || !above) return tokens * base
      const below = Math.min(tokens, threshold)
      const over = Math.max(tokens - threshold, 0)
      return below * base + over * above
    }

    return (
      tiered(inputTokens, pricing.input, pricing.inputAbove, pricing.threshold) +
      tiered(cacheRead, pricing.cacheRead, pricing.cacheReadAbove, pricing.threshold) +
      tiered(cacheCreate, pricing.cacheCreate, pricing.cacheCreateAbove, pricing.threshold) +
      tiered(outputTokens, pricing.output, pricing.outputAbove, pricing.threshold)
    )
  }

  function fmtTokens(n) {
    const abs = Math.abs(n)
    const sign = n < 0 ? "-" : ""
    const units = [
      { threshold: 1e9, divisor: 1e9, suffix: "B" },
      { threshold: 1e6, divisor: 1e6, suffix: "M" },
      { threshold: 1e3, divisor: 1e3, suffix: "K" },
    ]
    for (let i = 0; i < units.length; i++) {
      const unit = units[i]
      if (abs >= unit.threshold) {
        const scaled = abs / unit.divisor
        const formatted = scaled >= 10
          ? Math.round(scaled).toString()
          : scaled.toFixed(1).replace(/\.0$/, "")
        return sign + formatted + unit.suffix
      }
    }
    return sign + Math.round(abs).toString()
  }

  function dayKeyFromTimestamp(ts) {
    const date = new Date(ts)
    if (isNaN(date.getTime())) return null
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    return year + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day
  }

  function dayKeyOffset(daysAgo) {
    const date = new Date()
    date.setDate(date.getDate() - daysAgo)
    return dayKeyFromTimestamp(date.toISOString())
  }

  function applyFileDays(cacheDays, fileDays, sign) {
    const dayKeys = Object.keys(fileDays)
    for (let i = 0; i < dayKeys.length; i++) {
      const day = dayKeys[i]
      const fileModels = fileDays[day]
      if (!fileModels) continue
      const cacheDay = cacheDays[day] || {}

      const modelKeys = Object.keys(fileModels)
      for (let j = 0; j < modelKeys.length; j++) {
        const model = modelKeys[j]
        const incoming = fileModels[model]
        const current = cacheDay[model] || [0, 0, 0, 0, 0]
        const len = Math.max(current.length, incoming.length)
        const merged = []
        let hasValue = false
        for (let k = 0; k < len; k++) {
          const value = Math.max(0, (current[k] || 0) + sign * (incoming[k] || 0))
          merged.push(value)
          if (value !== 0) hasValue = true
        }
        if (hasValue) {
          cacheDay[model] = merged
        } else {
          delete cacheDay[model]
        }
      }

      if (Object.keys(cacheDay).length === 0) {
        delete cacheDays[day]
      } else {
        cacheDays[day] = cacheDay
      }
    }
  }

  function scanJsonlFile(ctx, filePath) {
    const lines = ctx.host.fs.readText(filePath).split("\n")
    const byRequestId = {}
    const entries = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      if (line.indexOf('"type":"assistant"') === -1) continue
      if (line.indexOf('"usage"') === -1) continue

      const obj = ctx.util.tryParseJson(line)
      if (!obj || obj.type !== "assistant") continue
      const msg = obj.message
      if (!msg || !msg.usage || !obj.timestamp) continue

      const dayKey = dayKeyFromTimestamp(obj.timestamp)
      if (!dayKey) continue

      const usage = msg.usage
      const inputTokens = Math.max(0, usage.input_tokens || 0)
      const cacheRead = Math.max(0, usage.cache_read_input_tokens || 0)
      const cacheCreate = Math.max(0, usage.cache_creation_input_tokens || 0)
      const outputTokens = Math.max(0, usage.output_tokens || 0)
      if (inputTokens === 0 && cacheRead === 0 && cacheCreate === 0 && outputTokens === 0) continue

      const entry = {
        dayKey,
        model: msg.model || "unknown",
        inputTokens,
        cacheRead,
        cacheCreate,
        outputTokens,
      }

      if (obj.requestId && msg.id) {
        const dedupKey = msg.id + ":" + obj.requestId
        const existing = byRequestId[dedupKey]
        if (!existing || outputTokens > existing.outputTokens) {
          byRequestId[dedupKey] = entry
        }
      } else {
        entries.push(entry)
      }
    }

    const dayData = {}
    function accumulateEntry(entry) {
      const normalizedModel = normalizeClaudeModel(entry.model)
      const cost = claudeCostUSD(
        normalizedModel,
        entry.inputTokens,
        entry.cacheRead,
        entry.cacheCreate,
        entry.outputTokens
      )
      const costNanos = cost === null ? 0 : Math.round(cost * 1e9)
      const dayModels = dayData[entry.dayKey] || {}
      const packed = dayModels[normalizedModel] || [0, 0, 0, 0, 0]
      packed[0] += entry.inputTokens
      packed[1] += entry.cacheRead
      packed[2] += entry.cacheCreate
      packed[3] += entry.outputTokens
      packed[4] += costNanos
      dayModels[normalizedModel] = packed
      dayData[entry.dayKey] = dayModels
    }

    const requestIds = Object.keys(byRequestId)
    for (let i = 0; i < requestIds.length; i++) {
      accumulateEntry(byRequestId[requestIds[i]])
    }
    for (let i = 0; i < entries.length; i++) {
      accumulateEntry(entries[i])
    }

    return dayData
  }

  function loadTokenCache(ctx) {
    const cachePath = ctx.app.pluginDataDir + "/token-cache.json"
    try {
      if (ctx.host.fs.exists(cachePath)) {
        const parsed = ctx.util.tryParseJson(ctx.host.fs.readText(cachePath))
        if (parsed && parsed.version === TOKEN_CACHE_VERSION) {
          return { cache: parsed, path: cachePath }
        }
      }
    } catch (e) {
      ctx.host.log.warn("token cache load failed: " + String(e))
    }
    return { cache: { version: TOKEN_CACHE_VERSION, lastScanMs: 0, files: {}, days: {} }, path: cachePath }
  }

  function saveTokenCache(ctx, cachePath, cache) {
    try {
      ctx.host.fs.writeText(cachePath, JSON.stringify(cache))
    } catch (e) {
      ctx.host.log.warn("token cache save failed: " + String(e))
    }
  }

  function pruneOldDays(days, keepDays) {
    const cutoffKey = dayKeyOffset(keepDays)
    if (!cutoffKey) return
    const keys = Object.keys(days)
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] < cutoffKey) delete days[keys[i]]
    }
  }

  function scanTokenUsage(ctx) {
    const loaded = loadTokenCache(ctx)
    const cache = loaded.cache
    const cachePath = loaded.path

    if (cache.lastScanMs && Date.now() - cache.lastScanMs < TOKEN_SCAN_MIN_INTERVAL_MS) {
      return cache.days
    }

    const roots = ["~/.claude/projects", "~/.config/claude/projects"]
    const configDir = ctx.host.env.get("CLAUDE_CONFIG_DIR")
    if (configDir) {
      let projectsDir = String(configDir).trim()
      if (projectsDir) {
        if (!/\/projects\/?$/.test(projectsDir)) {
          projectsDir = projectsDir.replace(/\/$/, "") + "/projects"
        }
        roots.unshift(projectsDir)
      }
    }

    const allFiles = []
    for (let i = 0; i < roots.length; i++) {
      try {
        const found = ctx.host.fs.glob(roots[i], "**/*.jsonl")
        for (let j = 0; j < found.length; j++) allFiles.push(found[j])
      } catch (e) {
        ctx.host.log.warn("glob failed for " + roots[i] + ": " + String(e))
      }
    }

    const touchedPaths = {}
    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i]
      const filePath = file.path
      if (touchedPaths[filePath]) continue
      touchedPaths[filePath] = true

      const cached = cache.files[filePath]
      if (file.size > TOKEN_SCAN_MAX_FILE_BYTES) {
        if (cached && cached.days) applyFileDays(cache.days, cached.days, -1)
        delete cache.files[filePath]
        continue
      }
      if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) continue

      if (cached && cached.days) {
        applyFileDays(cache.days, cached.days, -1)
      }

      try {
        const fileDays = scanJsonlFile(ctx, filePath)
        cache.files[filePath] = { size: file.size, mtimeMs: file.mtimeMs, days: fileDays }
        applyFileDays(cache.days, fileDays, +1)
      } catch (e) {
        ctx.host.log.warn("scan failed for " + filePath + ": " + String(e))
        if (cached && cached.days) {
          applyFileDays(cache.days, cached.days, +1)
          cache.files[filePath] = cached
        }
      }
    }

    const cachedPaths = Object.keys(cache.files)
    for (let i = 0; i < cachedPaths.length; i++) {
      const path = cachedPaths[i]
      if (!touchedPaths[path]) {
        if (cache.files[path] && cache.files[path].days) {
          applyFileDays(cache.days, cache.files[path].days, -1)
        }
        delete cache.files[path]
      }
    }

    pruneOldDays(cache.days, 31)
    cache.lastScanMs = Date.now()
    saveTokenCache(ctx, cachePath, cache)

    return cache.days
  }

  function aggregateDay(days, dayKey) {
    const models = days[dayKey]
    if (!models) return { tokens: 0, costUSD: null }
    let tokens = 0
    let costNanos = 0
    let hasCost = false
    const modelKeys = Object.keys(models)
    for (let i = 0; i < modelKeys.length; i++) {
      const packed = models[modelKeys[i]]
      tokens += (packed[0] || 0) + (packed[1] || 0) + (packed[2] || 0) + (packed[3] || 0)
      if (packed[4]) {
        costNanos += packed[4]
        hasCost = true
      }
    }
    return { tokens, costUSD: hasCost ? costNanos / 1e9 : null }
  }

  function aggregateDays(days, count) {
    let tokens = 0
    let costNanos = 0
    let hasCost = false
    for (let i = 0; i < count; i++) {
      const dayKey = dayKeyOffset(i)
      if (!dayKey) continue
      const dayData = aggregateDay(days, dayKey)
      tokens += dayData.tokens
      if (dayData.costUSD !== null) {
        costNanos += dayData.costUSD * 1e9
        hasCost = true
      }
    }
    return { tokens, costUSD: hasCost ? costNanos / 1e9 : null }
  }

  function costAndTokensLabel(data) {
    const parts = []
    if (data.costUSD !== null) parts.push("$" + data.costUSD.toFixed(2))
    if (data.tokens > 0) parts.push(fmtTokens(data.tokens) + " tokens")
    return parts.join(" \u00b7 ")
  }

  function probe(ctx) {
    const creds = loadCredentials(ctx)
    if (!creds || !creds.oauth || !creds.oauth.accessToken || !creds.oauth.accessToken.trim()) {
      ctx.host.log.error("probe failed: not logged in")
      throw "Not logged in. Run `claude` to authenticate."
    }

    const nowMs = Date.now()
    let accessToken = creds.oauth.accessToken

    // Proactively refresh if token is expired or about to expire
    if (needsRefresh(ctx, creds.oauth, nowMs)) {
      ctx.host.log.info("token needs refresh (expired or expiring soon)")
      const refreshed = refreshToken(ctx, creds)
      if (refreshed) {
        accessToken = refreshed
      } else {
        ctx.host.log.warn("proactive refresh failed, trying with existing token")
      }
    }

    let resp
    let didRefresh = false
    try {
      resp = ctx.util.retryOnceOnAuth({
        request: (token) => {
          try {
            return fetchUsage(ctx, token || accessToken)
          } catch (e) {
            ctx.host.log.error("usage request exception: " + String(e))
            if (didRefresh) {
              throw "Usage request failed after refresh. Try again."
            }
            throw "Usage request failed. Check your connection."
          }
        },
        refresh: () => {
          ctx.host.log.info("usage returned 401, attempting refresh")
          didRefresh = true
          return refreshToken(ctx, creds)
        },
      })
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("usage request failed: " + String(e))
      throw "Usage request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      ctx.host.log.error("usage returned auth error after all retries: status=" + resp.status)
      throw "Token expired. Run `claude` to log in again."
    }

    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.error("usage returned error: status=" + resp.status)
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }
    
    ctx.host.log.info("usage fetch succeeded")

    let data
    data = ctx.util.tryParseJson(resp.bodyText)
    if (data === null) {
      throw "Usage response invalid. Try again later."
    }

    const lines = []
    let plan = null
    if (creds.oauth.subscriptionType) {
      const planLabel = ctx.fmt.planLabel(creds.oauth.subscriptionType)
      if (planLabel) {
        plan = planLabel
      }
    }

    if (data.five_hour && typeof data.five_hour.utilization === "number") {
      lines.push(ctx.line.progress({
        label: "Session",
        used: data.five_hour.utilization,
        limit: 100,
        format: { kind: "percent" },
        resetsAt: ctx.util.toIso(data.five_hour.resets_at),
        periodDurationMs: 5 * 60 * 60 * 1000 // 5 hours
      }))
    }
    if (data.seven_day && typeof data.seven_day.utilization === "number") {
      lines.push(ctx.line.progress({
        label: "Weekly",
        used: data.seven_day.utilization,
        limit: 100,
        format: { kind: "percent" },
        resetsAt: ctx.util.toIso(data.seven_day.resets_at),
        periodDurationMs: 7 * 24 * 60 * 60 * 1000 // 7 days
      }))
    }
    if (data.seven_day_sonnet && typeof data.seven_day_sonnet.utilization === "number") {
      lines.push(ctx.line.progress({
        label: "Sonnet",
        used: data.seven_day_sonnet.utilization,
        limit: 100,
        format: { kind: "percent" },
        resetsAt: ctx.util.toIso(data.seven_day_sonnet.resets_at),
        periodDurationMs: 7 * 24 * 60 * 60 * 1000 // 7 days
      }))
    }

    if (data.extra_usage && data.extra_usage.is_enabled) {
      const used = data.extra_usage.used_credits
      const limit = data.extra_usage.monthly_limit
      if (typeof used === "number" && typeof limit === "number" && limit > 0) {
        lines.push(ctx.line.progress({
          label: "Extra usage",
          used: ctx.fmt.dollars(used),
          limit: ctx.fmt.dollars(limit),
          format: { kind: "dollars" }
        }))
      } else if (typeof used === "number" && used > 0) {
        lines.push(ctx.line.text({ label: "Extra usage", value: "$" + String(ctx.fmt.dollars(used)) }))
      }
    }

    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    try {
      const tokenDays = scanTokenUsage(ctx)
      const todayKey = dayKeyFromTimestamp(new Date().toISOString())
      const todayData = aggregateDay(tokenDays, todayKey)
      const last30Data = aggregateDays(tokenDays, 30)
      if (todayData.tokens > 0) {
        lines.push(ctx.line.text({ label: "Today", value: costAndTokensLabel(todayData) }))
      }
      if (last30Data.tokens > 0) {
        lines.push(ctx.line.text({ label: "Last 30 days", value: costAndTokensLabel(last30Data) }))
      }
    } catch (e) {
      ctx.host.log.warn("token scan failed: " + String(e))
    }

    return { plan: plan, lines: lines }
  }

  globalThis.__openusage_plugin = { id: "claude", probe }
})()
