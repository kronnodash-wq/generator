'use strict'

const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const path = require('path')

const adapter = new FileSync(path.join(__dirname, 'data.json'))
const db = low(adapter)

db.defaults({ users: [], checkpoints: [], checkins: [] }).write()

async function seedDefaults () {
  const supervisors = db.get('users').filter({ role: 'supervisor' }).value()
  if (supervisors.length > 0) return

  const supPassword = await bcrypt.hash('supervisor123', 10)
  const supervisor = {
    id: uuidv4(),
    name: 'Supervisor Principal',
    email: 'supervisor@empresa.com',
    password: supPassword,
    role: 'supervisor',
    created_at: new Date().toISOString()
  }
  db.get('users').push(supervisor).write()

  const guardPassword = await bcrypt.hash('guardia123', 10)
  db.get('users').push({
    id: uuidv4(),
    name: 'Guardia Demo',
    email: 'guardia@empresa.com',
    password: guardPassword,
    role: 'guard',
    supervisor_id: supervisor.id,
    created_at: new Date().toISOString()
  }).write()

  const demoCheckpoints = [
    { name: 'Entrada Principal', description: 'Puerta de entrada al edificio' },
    { name: 'Estacionamiento', description: 'Área de vehículos y cocheras' },
    { name: 'Almacén / Bodega', description: 'Área de carga y almacenamiento' },
    { name: 'Piso 3 – Oficinas', description: 'Planta de administración' }
  ]

  for (const cp of demoCheckpoints) {
    db.get('checkpoints').push({
      id: uuidv4(),
      name: cp.name,
      description: cp.description,
      token: uuidv4(),
      created_at: new Date().toISOString(),
      created_by: supervisor.id
    }).write()
  }

  console.log('─────────────────────────────────────────')
  console.log('  Datos de demostración creados:')
  console.log('  Supervisor : supervisor@empresa.com / supervisor123')
  console.log('  Guardia    : guardia@empresa.com    / guardia123')
  console.log('─────────────────────────────────────────')
}

seedDefaults().catch(console.error)

module.exports = db
