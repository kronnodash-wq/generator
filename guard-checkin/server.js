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

// Llave de acceso del supervisor — cambia SUPERVISOR_KEY para modificarla
const SUPERVISOR_KEY = process.env.SUPERVISOR_KEY || '1999'

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// Clientes SSE conectados (supervisores en tiempo real)
const sseClients = []

// ── Middleware supervisor ─────────────────────────────────────────────────────

function requireSupervisor (req, res, next) {
  // Acepta token por header o query param (necesario para EventSource)
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

// ── Autenticación ─────────────────────────────────────────────────────────────

// Supervisor: nombre + llave
app.post('/api/auth/supervisor', (req, res) => {
  const { name, key } = req.body || {}
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'El nombre es requerido' })
  }
  if (!key || key.trim() !== SUPERVISOR_KEY) {
    return res.status(401).json({ error: 'Llave incorrecta' })
  }
  const token = jwt.sign(
    { name: name.trim(), role: 'supervisor' },
    JWT_SECRET,
    { expiresIn: '12h' }
  )
  res.json({ token, name: name.trim(), role: 'supervisor' })
})

// Guardia: solo nombre (sin token, sin contraseña)
app.post('/api/auth/guard', (req, res) => {
  const { name } = req.body || {}
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'El nombre es requerido' })
  }
  res.json({ name: name.trim(), role: 'guard' })
})

// ── Puntos de control ─────────────────────────────────────────────────────────

app.get('/api/checkpoints', requireSupervisor, (req, res) => {
  res.json(db.get('checkpoints').value())
})

app.post('/api/checkpoints', requireSupervisor, (req, res) => {
  const { name, description } = req.body || {}
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'El nombre del punto es requerido' })
  }
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

// ── Marcaciones (guardia las crea, supervisor las lee) ────────────────────────

// El guardia envía la marcación — no necesita token, pero GPS es obligatorio
app.post('/api/checkins', (req, res) => {
  const { guard_name, checkpoint_token, latitude, longitude, accuracy } = req.body || {}

  if (!guard_name || !guard_name.trim()) {
    return res.status(400).json({ error: 'Nombre del guardia requerido' })
  }
  if (!checkpoint_token) {
    return res.status(400).json({ error: 'Token de punto de control requerido' })
  }
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'La ubicación GPS es obligatoria para registrar una marcación' })
  }

  const cp = db.get('checkpoints').find({ token: checkpoint_token }).value()
  if (!cp) return res.status(404).json({ error: 'Código QR no válido o punto de control no existe' })

  const now = new Date()
  const checkin = {
    id: uuidv4(),
    guard_name: guard_name.trim(),
    checkpoint_id: cp.id,
    checkpoint_name: cp.name,
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    accuracy: accuracy != null ? parseFloat(accuracy) : null,
    timestamp: now.toISOString()
  }

  db.get('checkins').push(checkin).write()

  // Notificar en tiempo real a todos los supervisores conectados
  const ssePayload = `data: ${JSON.stringify(checkin)}\n\n`
  sseClients.forEach(client => {
    try { client.write(ssePayload) } catch {}
  })

  res.json({ success: true, message: `Marcación registrada en "${cp.name}"` })
})

// ── Endpoints exclusivos del supervisor ──────────────────────────────────────

app.get('/api/supervisor/checkins', requireSupervisor, (req, res) => {
  const { date, limit = 500 } = req.query
  let chain = db.get('checkins')
  if (date) chain = chain.filter(c => c.timestamp.startsWith(date))
  res.json(chain.sortBy('timestamp').reverse().take(parseInt(limit)).value())
})

app.get('/api/supervisor/stats', requireSupervisor, (req, res) => {
  const today = new Date().toISOString().split('T')[0]
  const all = db.get('checkins').value()
  const hoy = all.filter(c => c.timestamp.startsWith(today))
  res.json({
    today_checkins: hoy.length,
    active_guards_today: new Set(hoy.map(c => c.guard_name)).size,
    total_checkins: all.length,
    total_checkpoints: db.get('checkpoints').value().length
  })
})

// SSE: canal de eventos en tiempo real para el supervisor
app.get('/api/supervisor/events', requireSupervisor, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Ping periódico para mantener viva la conexión
  const ping = setInterval(() => {
    try { res.write(':ping\n\n') } catch {}
  }, 25000)

  sseClients.push(res)

  req.on('close', () => {
    clearInterval(ping)
    const idx = sseClients.indexOf(res)
    if (idx !== -1) sseClients.splice(idx, 1)
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
