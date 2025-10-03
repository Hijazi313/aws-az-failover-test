// server.js
const express = require('express')
const axios = require('axios')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 80
const METADATA_BASE = process.env.METADATA_BASE || 'http://169.254.169.254/latest/meta-data'
const METADATA_TIMEOUT_MS = 1000

// runtime state
let isReady = true
let shuttingDown = false
let cachedMetadata = { instanceId: null, availabilityZone: null, fetchedAt: 0 }
const METADATA_CACHE_TTL = 30 * 1000 // 30s

// helper: fetch EC2 metadata (instance-id & az) with simple caching
async function fetchMetadata() {
  const now = Date.now()
  if (cachedMetadata.fetchedAt + METADATA_CACHE_TTL > now && cachedMetadata.instanceId) {
    return cachedMetadata
  }

  async function md(path) {
    try {
      const res = await axios.get(`${METADATA_BASE}/${path}`, { timeout: METADATA_TIMEOUT_MS })
      return res.data
    } catch (err) {
      return null
    }
  }

  const [instanceId, az] = await Promise.all([md('instance-id'), md('placement/availability-zone')])
  cachedMetadata = { instanceId: instanceId || 'unknown', availabilityZone: az || 'unknown', fetchedAt: Date.now() }
  return cachedMetadata
}

// Basic root: show instance + AZ info
app.get('/', async (req, res) => {
  const meta = await fetchMetadata()
  res.json({
    message: 'hello from express health-check app',
    instanceId: meta.instanceId,
    availabilityZone: meta.availabilityZone,
    ready: isReady && !shuttingDown,
    timestamp: new Date().toISOString()
  })
})

// Liveness probe — is process alive?
// Should be used as the container / instance Liveness probe.
app.get('/health/live', (req, res) => {
  // If process is in terminating state, you might return 500 to trigger restart depending on your orchestration.
  if (shuttingDown) return res.status(500).json({ live: false, reason: 'shutting_down' })
  return res.json({ live: true })
})

// Readiness probe — should traffic be sent to this instance?
// Return 200 when healthy, 503 when not ready.
app.get('/health/ready', (req, res) => {
  if (!isReady || shuttingDown) {
    return res.status(503).json({ ready: false })
  }
  return res.json({ ready: true })
})

// Metadata endpoint (handy to inspect from your ALB logs)
app.get('/meta', async (req, res) => {
  const meta = await fetchMetadata()
  res.json(meta)
})

// Small diagnostic endpoint to help AWS ALB/clients see which instance/AZ served the request
app.get('/whoami', async (req, res) => {
  const meta = await fetchMetadata()
  res.json({
    instanceId: meta.instanceId,
    availabilityZone: meta.availabilityZone,
    pid: process.pid,
    ready: isReady && !shuttingDown,
    time: new Date().toISOString()
  })
})

/**
 * Simulation endpoints
 *
 * Use these to test how your infra behaves:
 *
 * 1) Make instance unready without killing it:
 *    POST /simulate with body { "ready": false }
 *    -> readiness probe returns 503 (ALB/Target Group should mark unhealthy after health-check failures)
 *
 * 2) Make instance ready:
 *    POST /simulate { "ready": true }
 *
 * 3) Trigger graceful shutdown to simulate instance termination:
 *    POST /simulate/shutdown  -> starts graceful shutdown (sets readiness false, closes server after delay)
 *
 * NOTE: In production, protect these endpoints (auth) or only enable via ENV.
 */
const SIM_KEY = process.env.SIM_KEY || '' // optional secret to protect simulate endpoints

function requireSimKey(req, res, next) {
  if (!SIM_KEY) return next()
  const key = req.headers['x-sim-key'] || req.query.simKey || req.body.simKey
  if (key === SIM_KEY) return next()
  return res.status(401).json({ error: 'sim-key-missing-or-invalid' })
}

app.post('/simulate', requireSimKey, (req, res) => {
  const { ready } = req.body
  if (typeof ready !== 'boolean') return res.status(400).json({ error: '`ready` boolean is required in body' })
  isReady = ready
  return res.json({ ready: isReady })
})

app.post('/simulate/shutdown', requireSimKey, (req, res) => {
  if (shuttingDown) return res.status(400).json({ error: 'already_shutting_down' })
  // mark not ready immediately so load balancer stops sending new requests
  isReady = false
  shuttingDown = true
  res.json({ shuttingDown: true, note: 'server will attempt graceful shutdown in 5s' })

  // give clients time to finish; close server and exit
  setTimeout(async () => {
    try {
      await shutdownGracefully()
    } catch (err) {
      process.exit(1)
    }
  }, 5000)
})

// server + graceful shutdown
const server = app.listen(PORT, () => {
  console.log(`Health-check app listening on port ${PORT} (pid=${process.pid})`)
})

async function shutdownGracefully() {
  console.log('Graceful shutdown: refusing new requests (isReady=false), closing server...')
  isReady = false
  shuttingDown = true

  // stop accepting new connections
  server.close((err) => {
    if (err) {
      console.error('Error closing server:', err)
      process.exit(1)
    }
    console.log('Server closed. Exiting process.')
    process.exit(0)
  })

  // Force exit if close doesn't finish within timeout
  setTimeout(() => {
    console.warn('Forcing exit: shutdown timed out.')
    process.exit(1)
  }, 15_000)
}

// react to SIGTERM (ECS/ASG/K8s sends this when draining)
process.on('SIGTERM', () => {
  console.info('SIGTERM received — starting graceful shutdown.')
  // set readiness false right away
  isReady = false
  shuttingDown = true
  // try to close gracefully
  setTimeout(() => shutdownGracefully(), 2000)
})

process.on('SIGINT', () => {
  console.info('SIGINT received — exiting.')
  shutdownGracefully()
})
