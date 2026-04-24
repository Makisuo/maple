#!/usr/bin/env node
/**
 * Tiny OTel Collector supervisor.
 *
 * Runs as PID 1 in the self-managed collector container. Keeps an otelcol-
 * contrib child process alive and exposes a small HTTP endpoint so the Maple
 * API can push a freshly-generated collector config whenever a BYO Tinybird
 * sync activates or deactivates.
 *
 * Protocol:
 *   PUT  /-/reload    body = new collector config YAML, Bearer auth optional
 *   GET  /-/health    200 if the collector child is running
 *
 * On a successful reload the supervisor:
 *   1. writes the new YAML atomically to COLLECTOR_CONFIG_PATH
 *   2. SIGTERMs the running collector
 *   3. waits for it to exit (SIGKILL after RESTART_TIMEOUT_MS)
 *   4. spawns a new collector with the new config
 *
 * The collector restart drops in-flight spans that haven't been exported yet,
 * but the persistent `file_storage/queue` extension survives across restarts,
 * so anything already queued resumes cleanly.
 *
 * No npm deps — node:22 stdlib only.
 */

import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { writeFile, rename, mkdir } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname } from "node:path"

const CONFIG_PATH =
  process.env.COLLECTOR_CONFIG_PATH ?? "/etc/otelcol/config.yaml"
const OTELCOL_BIN =
  process.env.OTELCOL_BIN ?? "/usr/local/bin/otelcol-contrib"
const RELOAD_BEARER = process.env.COLLECTOR_RELOAD_BEARER
// Prefer Railway's auto-assigned PORT so its health probes + public
// networking hit the supervisor by default. Falls back to the explicit
// COLLECTOR_RELOAD_PORT for compose / self-hosted setups.
const RELOAD_PORT = Number(
  process.env.PORT ?? process.env.COLLECTOR_RELOAD_PORT ?? "13140",
)
const RESTART_TIMEOUT_MS = Number(
  process.env.COLLECTOR_RESTART_TIMEOUT_MS ?? "30000",
)
const MAX_BODY_BYTES = Number(
  process.env.COLLECTOR_MAX_CONFIG_BYTES ?? "2000000",
)

let child = null
let reloadInFlight = false
let shuttingDown = false

const log = (level, message, extra = {}) => {
  console.log(
    JSON.stringify({
      level,
      ts: new Date().toISOString(),
      component: "collector-supervisor",
      message,
      ...extra,
    }),
  )
}

const spawnCollector = () => {
  log("info", "spawning otelcol", {
    bin: OTELCOL_BIN,
    config: CONFIG_PATH,
  })
  const proc = spawn(OTELCOL_BIN, ["--config", CONFIG_PATH], {
    stdio: ["ignore", "inherit", "inherit"],
  })
  proc.on("exit", (code, signal) => {
    log("info", "otelcol exited", {
      code,
      signal,
      reloadInFlight,
    })
    child = null
    if (shuttingDown) return
    // Crash-restart unless a reload already planned to spawn a new one.
    if (!reloadInFlight) {
      setTimeout(() => {
        if (!shuttingDown) child = spawnCollector()
      }, 1000).unref()
    }
  })
  proc.on("error", (error) => {
    log("error", "otelcol spawn error", { message: error.message })
  })
  return proc
}

const waitForExit = (proc) =>
  new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve()
    const timer = setTimeout(() => {
      log("warn", "otelcol did not exit within timeout, SIGKILL")
      proc.kill("SIGKILL")
    }, RESTART_TIMEOUT_MS)
    timer.unref()
    proc.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })

const gracefulRestart = async () => {
  const previous = child
  reloadInFlight = true
  try {
    if (previous) {
      previous.kill("SIGTERM")
      await waitForExit(previous)
    }
    child = spawnCollector()
  } finally {
    reloadInFlight = false
  }
}

const writeConfigAtomically = async (yaml) => {
  const dir = dirname(CONFIG_PATH)
  await mkdir(dir, { recursive: true })
  const tmp = `${CONFIG_PATH}.${randomBytes(4).toString("hex")}.tmp`
  await writeFile(tmp, yaml, "utf8")
  await rename(tmp, CONFIG_PATH)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on("data", (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("payload too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

const looksLikeCollectorConfig = (yaml) =>
  /^\s*(receivers|exporters|processors|service|connectors|extensions)\s*:/m.test(
    yaml,
  )

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/-/health") {
      const healthy = child != null
      res.writeHead(healthy ? 200 : 503, {
        "content-type": "application/json",
      })
      res.end(
        JSON.stringify({
          healthy,
          collectorRunning: child != null,
          reloadInFlight,
        }),
      )
      return
    }

    if (req.method === "PUT" && req.url === "/-/reload") {
      if (RELOAD_BEARER) {
        const auth = req.headers["authorization"] ?? ""
        if (auth !== `Bearer ${RELOAD_BEARER}`) {
          res.writeHead(401).end("unauthorized")
          return
        }
      }
      let yaml
      try {
        yaml = await readBody(req)
      } catch (error) {
        res
          .writeHead(413, { "content-type": "text/plain" })
          .end(error.message ?? "request body error")
        return
      }
      if (yaml.trim().length === 0) {
        res.writeHead(400).end("empty body")
        return
      }
      if (!looksLikeCollectorConfig(yaml)) {
        res.writeHead(400).end("body does not look like a collector config")
        return
      }

      await writeConfigAtomically(yaml)
      log("info", "config written, restarting collector", {
        bytes: yaml.length,
      })
      await gracefulRestart()
      res.writeHead(204).end()
      return
    }

    res.writeHead(404).end("not found")
  } catch (error) {
    log("error", "supervisor request failed", {
      message: error?.message ?? String(error),
    })
    if (!res.headersSent) {
      res.writeHead(500).end("server error")
    }
  }
})

const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  log("info", "supervisor shutting down")
  server.close()
  if (child) child.kill("SIGTERM")
  // Hard exit if the child refuses to die.
  setTimeout(() => process.exit(0), RESTART_TIMEOUT_MS).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

// Bind to :: so the supervisor is reachable on Railway's IPv6-only private
// network (for <service>.railway.internal DNS) as well as the public TCP
// proxy. Node dual-stacks a `::` bind to also accept IPv4.
server.listen(RELOAD_PORT, "::", () => {
  log("info", "supervisor listening", { port: RELOAD_PORT })
  child = spawnCollector()
})
