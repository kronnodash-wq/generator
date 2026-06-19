'use strict'

const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const { v4: uuidv4 } = require('uuid')
const path = require('path')

const adapter = new FileSync(path.join(__dirname, 'data.json'))
const db = low(adapter)

if (db.has('users').value()) db.unset('users').write()

db.defaults({ checkpoints: [], checkins: [], locations: [] }).write()

if (db.get('checkpoints').value().length === 0) {
  const checkpoints = [
    { name: 'Entrada Principal', description: 'Puerta de entrada al edificio' },
    { name: 'Estacionamiento', description: 'Área de vehículos' },
    { name: 'Almacén / Bodega', description: 'Área de carga y almacenamiento' },
    { name: 'Piso 3 – Oficinas', description: 'Planta de administración' }
  ]
  for (const cp of checkpoints) {
    db.get('checkpoints').push({
      id: uuidv4(),
      name: cp.name,
      description: cp.description,
      token: uuidv4(),
      created_at: new Date().toISOString()
    }).write()
  }
}


module.exports = db
