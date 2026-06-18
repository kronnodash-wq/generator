'use strict'

const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const { v4: uuidv4 } = require('uuid')
const path = require('path')

const adapter = new FileSync(path.join(__dirname, 'data.json'))
const db = low(adapter)

// Migración: eliminar tabla de usuarios si existía en versión anterior
if (db.has('users').value()) {
  db.unset('users').write()
}

db.defaults({ checkpoints: [], checkins: [] }).write()

// Crear puntos de control de demostración al primer arranque
if (db.get('checkpoints').value().length === 0) {
  const demos = [
    { name: 'Entrada Principal', description: 'Puerta de entrada al edificio' },
    { name: 'Estacionamiento', description: 'Área de vehículos y cocheras' },
    { name: 'Almacén / Bodega', description: 'Área de carga y almacenamiento' },
    { name: 'Piso 3 – Oficinas', description: 'Planta de administración' }
  ]
  for (const cp of demos) {
    db.get('checkpoints').push({
      id: uuidv4(),
      name: cp.name,
      description: cp.description,
      token: uuidv4(),
      created_at: new Date().toISOString()
    }).write()
  }
  console.log('✅ Puntos de control de ejemplo creados')
}

module.exports = db
