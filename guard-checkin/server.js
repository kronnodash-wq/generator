'use strict'

const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const qrcode = require('qrcode')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const db = require('./db')

const app = express()
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'guard-qr-secret-2024-change-in-prod'

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth (req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No autorizado' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.' })
  }
}

function requireSupervisor (req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'supervisor') {
      return res.status(403).json({ error: 'Solo supervisores pueden realizar esta acción' })
    }
    next()
  })
}

// ── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' })
  }

  const user = db.get('users').find({ email: email.toLowerCase().trim() }).value()
  if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' })

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' })

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '12h' }
  )

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  })
})

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user))

// ── Checkpoints ──────────────────────────────────────────────────────────────

app.get('/api/checkpoints', requireSupervisor, (req, res) => {
  res.json(db.get('checkpoints').filter({ created_by: req.user.id }).value())
})

app.post('/api/checkpoints', requireSupervisor, (req, res) => {
  const { name, description } = req.body || {}
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'El nombre del punto de control es requerido' })
  }

  const checkpoint = {
    id: uuidv4(),
    name: name.trim(),
    description: (description || '').trim(),
    token: uuidv4(),
    created_at: new Date().toISOString(),
    created_by: req.user.id
  }

  db.get('checkpoints').push(checkpoint).write()
  res.json(checkpoint)
})

app.delete('/api/checkpoints/:id', requireSupervisor, (req, res) => {
  const cp = db.get('checkpoints').find({ id: req.params.id, created_by: req.user.id }).value()
  if (!cp) return res.status(404).json({ error: 'Punto de control no encontrado' })
  db.get('checkpoints').remove({ id: req.params.id }).write()
  res.json({ success: true })
})

app.get('/api/checkpoints/:id/qr', requireSupervisor, async (req, res) => {
  const cp = db.get('checkpoints').find({ id: req.params.id, created_by: req.user.id }).value()
  if (!cp) return res.status(404).json({ error: 'Punto de control no encontrado' })

  try {
    const qrPayload = JSON.stringify({ type: 'guard-checkin', token: cp.token, name: cp.name })
    const qrDataUrl = await qrcode.toDataURL(qrPayload, {
      width: 500,
      margin: 2,
      color: { dark: '#0D47A1', light: '#FFFFFF' }
    })
    res.json({ qr: qrDataUrl, checkpoint: cp })
  } catch (err) {
    res.status(500).json({ error: 'Error al generar código QR' })
  }
})

// ── Check-ins (guard submits) ─────────────────────────────────────────────────

app.post('/api/checkins', requireAuth, (req, res) => {
  if (req.user.role !== 'guard') {
    return res.status(403).json({ error: 'Solo guardias pueden registrar marcaciones' })
  }

  const { checkpoint_token, latitude, longitude, accuracy, notes } = req.body || {}

  if (!checkpoint_token) {
    return res.status(400).json({ error: 'Token de punto de control requerido' })
  }
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'La ubicación GPS es obligatoria para marcar' })
  }

  const cp = db.get('checkpoints').find({ token: checkpoint_token }).value()
  if (!cp) return res.status(404).json({ error: 'Código QR no válido o punto de control no existe' })

  const guard = db.get('users').find({ id: req.user.id }).value()

  const checkin = {
    id: uuidv4(),
    guard_id: req.user.id,
    guard_name: req.user.name,
    checkpoint_id: cp.id,
    checkpoint_name: cp.name,
    supervisor_id: guard ? guard.supervisor_id : null,
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    accuracy: accuracy != null ? parseFloat(accuracy) : null,
    notes: (notes || '').trim(),
    timestamp: new Date().toISOString()
  }

  db.get('checkins').push(checkin).write()

  res.json({
    success: true,
    message: `Marcación registrada en "${cp.name}"`,
    checkin
  })
})

app.get('/api/guard/checkins/today', requireAuth, (req, res) => {
  if (req.user.role !== 'guard') return res.status(403).json({ error: 'Acceso denegado' })

  const today = new Date().toISOString().split('T')[0]
  const checkins = db.get('checkins')
    .filter(c => c.guard_id === req.user.id && c.timestamp.startsWith(today))
    .sortBy('timestamp')
    .reverse()
    .value()

  res.json(checkins)
})

// ── Supervisor endpoints ──────────────────────────────────────────────────────

app.get('/api/supervisor/checkins', requireSupervisor, (req, res) => {
  const { date, guard_id, limit = 200 } = req.query
  let chain = db.get('checkins').filter(c => c.supervisor_id === req.user.id)

  if (date) chain = chain.filter(c => c.timestamp.startsWith(date))
  if (guard_id) chain = chain.filter(c => c.guard_id === guard_id)

  res.json(chain.sortBy('timestamp').reverse().take(parseInt(limit)).value())
})

app.get('/api/supervisor/stats', requireSupervisor, (req, res) => {
  const today = new Date().toISOString().split('T')[0]
  const allCheckins = db.get('checkins').filter(c => c.supervisor_id === req.user.id).value()
  const todayCheckins = allCheckins.filter(c => c.timestamp.startsWith(today))
  const guards = db.get('users').filter({ role: 'guard', supervisor_id: req.user.id }).value()
  const checkpoints = db.get('checkpoints').filter({ created_by: req.user.id }).value()

  res.json({
    total_checkins: allCheckins.length,
    today_checkins: todayCheckins.length,
    total_guards: guards.length,
    active_guards_today: new Set(todayCheckins.map(c => c.guard_id)).size,
    total_checkpoints: checkpoints.length
  })
})

app.get('/api/supervisor/guards', requireSupervisor, (req, res) => {
  const guards = db.get('users')
    .filter({ role: 'guard', supervisor_id: req.user.id })
    .map(g => ({ id: g.id, name: g.name, email: g.email, created_at: g.created_at }))
    .value()
  res.json(guards)
})

app.post('/api/supervisor/guards', requireSupervisor, async (req, res) => {
  const { name, email, password } = req.body || {}
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
  }

  const exists = db.get('users').find({ email: email.toLowerCase().trim() }).value()
  if (exists) return res.status(409).json({ error: 'Ya existe un usuario con ese email' })

  const guard = {
    id: uuidv4(),
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: await bcrypt.hash(password, 10),
    role: 'guard',
    supervisor_id: req.user.id,
    created_at: new Date().toISOString()
  }

  db.get('users').push(guard).write()
  res.json({ id: guard.id, name: guard.name, email: guard.email, created_at: guard.created_at })
})

app.delete('/api/supervisor/guards/:id', requireSupervisor, (req, res) => {
  const guard = db.get('users')
    .find({ id: req.params.id, supervisor_id: req.user.id, role: 'guard' })
    .value()
  if (!guard) return res.status(404).json({ error: 'Guardia no encontrado' })
  db.get('users').remove({ id: req.params.id }).write()
  res.json({ success: true })
})

// ── Catch-all → login page ───────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`\n🔐 Guard QR Check-in System`)
  console.log(`   http://localhost:${PORT}\n`)
})
