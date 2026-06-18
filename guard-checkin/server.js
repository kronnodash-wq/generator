'use strict'

const express = require('express')
const jwt = require('jsonwebtoken')
const qrcode = require('qrcode')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const db = require('./db')

const app = express()
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'guard-qr-local-secret-2024'
const SUPERVISOR_KEY = process.env.SUPERVISOR_KEY || '1999'

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const sseClients = []

// ── Middleware ────────────────────────────────────────────────────────────────

function requireSupervisor (req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1] || req.query.token
  if (!token) return res.status(401).json({ error: 'No autorizado' })
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (decoded.role !== 'supervisor') return res.status(403).json({ error: 'Solo supervisores' })
    req.user = decoded
    next()
  } catch {
    res.status(401).json({ error: 'Sesión expirada. Vuelve a ingresar.' })
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/supervisor', (req, res) => {
  const { name, key } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' })
  if (!key || key.trim() !== SUPERVISOR_KEY) return res.status(401).json({ error: 'Llave incorrecta' })
  const token = jwt.sign({ name: name.trim(), role: 'supervisor' }, JWT_SECRET, { expiresIn: '12h' })
  res.json({ token, name: name.trim(), role: 'supervisor' })
})

app.post('/api/auth/guard', (req, res) => {
  const { name } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' })
  res.json({ name: name.trim(), role: 'guard' })
})

// ── Locales (público para guardias, gestión por supervisor) ───────────────────

app.get('/api/locations', (req, res) => {
  res.json(db.get('locations').sortBy('name').value())
})

app.post('/api/locations', requireSupervisor, (req, res) => {
  const { name } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre del local es requerido' })
  const exists = db.get('locations').find(l => l.name.toLowerCase() === name.trim().toLowerCase()).value()
  if (exists) return res.status(409).json({ error: 'Ya existe un local con ese nombre' })
  const loc = { id: uuidv4(), name: name.trim(), created_at: new Date().toISOString() }
  db.get('locations').push(loc).write()
  res.json(loc)
})

app.delete('/api/locations/:id', requireSupervisor, (req, res) => {
  const loc = db.get('locations').find({ id: req.params.id }).value()
  if (!loc) return res.status(404).json({ error: 'Local no encontrado' })
  db.get('locations').remove({ id: req.params.id }).write()
  res.json({ success: true })
})

// ── Puntos de control ─────────────────────────────────────────────────────────

app.get('/api/checkpoints', requireSupervisor, (req, res) => {
  res.json(db.get('checkpoints').value())
})

app.post('/api/checkpoints', requireSupervisor, (req, res) => {
  const { name, description } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre del punto es requerido' })
  const cp = {
    id: uuidv4(),
    name: name.trim(),
    description: (description || '').trim(),
    token: uuidv4(),
    created_at: new Date().toISOString()
  }
  db.get('checkpoints').push(cp).write()
  res.json(cp)
})

app.delete('/api/checkpoints/:id', requireSupervisor, (req, res) => {
  const cp = db.get('checkpoints').find({ id: req.params.id }).value()
  if (!cp) return res.status(404).json({ error: 'Punto no encontrado' })
  db.get('checkpoints').remove({ id: req.params.id }).write()
  res.json({ success: true })
})

app.get('/api/checkpoints/:id/qr', requireSupervisor, async (req, res) => {
  const cp = db.get('checkpoints').find({ id: req.params.id }).value()
  if (!cp) return res.status(404).json({ error: 'Punto no encontrado' })
  try {
    const qrDataUrl = await qrcode.toDataURL(
      JSON.stringify({ type: 'guard-checkin', token: cp.token, name: cp.name }),
      { width: 500, margin: 2, color: { dark: '#0D47A1', light: '#FFFFFF' } }
    )
    res.json({ qr: qrDataUrl, checkpoint: cp })
  } catch {
    res.status(500).json({ error: 'Error al generar el QR' })
  }
})

// ── Marcaciones ───────────────────────────────────────────────────────────────

// El guardia envía la marcación (sin auth, pero GPS obligatorio)
// Acepta `timestamp` para sincronizar marcaciones offline
app.post('/api/checkins', (req, res) => {
  const { guard_name, location_name, checkpoint_token, latitude, longitude, accuracy, timestamp } = req.body || {}

  if (!guard_name || !guard_name.trim()) return res.status(400).json({ error: 'Nombre del guardia requerido' })
  if (!checkpoint_token) return res.status(400).json({ error: 'Token de punto de control requerido' })
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'La ubicación GPS es obligatoria para registrar una marcación' })
  }

  const cp = db.get('checkpoints').find({ token: checkpoint_token }).value()
  if (!cp) return res.status(404).json({ error: 'Código QR no válido o punto de control no existe' })

  const now = new Date()
  const checkin = {
    id: uuidv4(),
    guard_name: guard_name.trim(),
    location_name: (location_name || 'Sin especificar').trim(),
    checkpoint_id: cp.id,
    checkpoint_name: cp.name,
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    accuracy: accuracy != null ? parseFloat(accuracy) : null,
    // Usar el timestamp del cliente si viene (marcación offline), si no, hora actual
    timestamp: (timestamp && !isNaN(Date.parse(timestamp))) ? timestamp : now.toISOString(),
    timestamp_received: now.toISOString()
  }

  db.get('checkins').push(checkin).write()

  // Notificar supervisores en tiempo real
  const ssePayload = `data: ${JSON.stringify(checkin)}\n\n`
  sseClients.forEach(c => { try { c.write(ssePayload) } catch {} })

  res.json({ success: true, message: `Marcación registrada en "${cp.name}"` })
})

// ── Supervisor ────────────────────────────────────────────────────────────────

app.get('/api/supervisor/checkins', requireSupervisor, (req, res) => {
  const { date, location } = req.query
  let chain = db.get('checkins')
  if (date) chain = chain.filter(c => c.timestamp.startsWith(date))
  if (location) chain = chain.filter(c => c.location_name === location)
  res.json(chain.sortBy('timestamp').reverse().take(500).value())
})

app.get('/api/supervisor/stats', requireSupervisor, (req, res) => {
  const today = new Date().toISOString().split('T')[0]
  const all = db.get('checkins').value()
  const hoy = all.filter(c => c.timestamp.startsWith(today))
  const locs = db.get('locations').value()
  const cps = db.get('checkpoints').value()

  // Resumen por local (hoy)
  const byLocation = {}
  hoy.forEach(c => {
    byLocation[c.location_name] = (byLocation[c.location_name] || 0) + 1
  })

  res.json({
    today_checkins: hoy.length,
    active_guards_today: new Set(hoy.map(c => c.guard_name)).size,
    total_checkins: all.length,
    total_checkpoints: cps.length,
    total_locations: locs.length,
    by_location_today: byLocation
  })
})

app.get('/api/supervisor/events', requireSupervisor, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const ping = setInterval(() => { try { res.write(':ping\n\n') } catch {} }, 25000)
  sseClients.push(res)
  req.on('close', () => {
    clearInterval(ping)
    const i = sseClients.indexOf(res)
    if (i !== -1) sseClients.splice(i, 1)
  })
})

// ── Catch-all ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log('\n🔐 Sistema de Rondas con QR')
  console.log(`   http://localhost:${PORT}`)
  console.log(`   Llave supervisor: ${SUPERVISOR_KEY}\n`)
})
