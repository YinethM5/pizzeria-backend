// db.js
const sqlite3 = require('sqlite3').verbose();

// -------------------------------------------------------
// CONEXIÓN A LA BASE DE DATOS
// -------------------------------------------------------
const db = new sqlite3.Database('./pizzeria.db', (err) => {
  if (err) {
    console.error('Error al conectar con SQLite:', err.message);
  } else {
    console.log(' Base de datos SQLite conectada');
  }
});

// -------------------------------------------------------
// CREACIÓN DE TABLAS
// -------------------------------------------------------
db.run(`
  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    precio REAL,
    sede TEXT,
    UNIQUE(nombre, sede)
  )
`);
db.run(`
  UPDATE productos 
  SET tipo = 'ingrediente' 
  WHERE nombre IN (
    'Mortadela','Queso','Peperoni','Piña','Harina',
    'Levadura','Azúcar','Mantequilla','Sal',
    'Cajas','Salsa de tomate','Maiz Sabrosa'
  )
`);

db.run(`ALTER TABLE productos ADD COLUMN tipo TEXT DEFAULT 'venta'`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.error('Error agregando columna tipo:', err.message);
  }
});

db.run(`
  CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto TEXT,
    cantidad INTEGER,
    total REAL,
    fecha TEXT DEFAULT (date('now', 'localtime')),
    sede TEXT
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS resumen_diario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    base REAL DEFAULT 0,
    extras REAL DEFAULT 0,
    gastos REAL DEFAULT 0,
    sede TEXT,
    UNIQUE(fecha, sede)
  )
`);

// -------------------------------------------------------
//  INSERTAR PRODUCTOS AUTOMÁTICAMENTE SI NO EXISTEN
// -------------------------------------------------------
const productos = [
  // BASE DEL SISTEMA
  ['Masas', 11.25],
  ['Caja grande', 0],
  ['Caja mediana', 0],
  ['Caja pequeña', 0],
  ['Cola personal', 0.75],
  ['Cola de litro', 1.50],
  ['Jugo Botella', 0.50],
  ['Fuze Tea litro', 1.50],
  ['Botella de Agua', 0.50],
];

const sedes = ["quinta1", "quinta2"];

sedes.forEach(sede => {
  productos.forEach(([nombre, precio]) => {
    db.run(
      'INSERT OR IGNORE INTO productos (nombre, precio, sede) VALUES (?, ?, ?)',
      [nombre, precio, sede]
    );
  });
});
// -------------------------------------------------------
// INGREDIENTES
// -------------------------------------------------------
const ingredientes = [
  "Mortadela",
  "Queso",
  "Peperoni",
  "Piña",
  "Harina",
  "Levadura",
  "Azúcar",
  "Mantequilla",
  "Sal",
  "Cajas",
  "Salsa de tomate",
  "Maiz Sabrosa",

  // NUEVOS
  "Porta pizza",
  "Platos de torta número 6",
  "Funda de aluminio",
  "Fundas de basura",
  "Fundas dina negra",
  "Fundas dina blanca",
  "Vasos",
  "Fundas de bolos",
  "Óregano",
  "Salami",
  "Servilletas",
  "Jamón",
  "Tachos de Mayonesa",
  "Caja de schet mayonesa",
  "Caja de schet salsatomate",
  "Maíz",
  "Champiñones",
  "Tocino"
];
sedes.forEach(sede => {
  ingredientes.forEach(nombre => {
    db.run(
      'INSERT OR IGNORE INTO productos (nombre, precio, sede, tipo) VALUES (?, ?, ?, ?)',
      [nombre, 0, sede, 'ingrediente']
    );
  });
});

// -------------------------------------------------------
//  EXPORTAR DB PARA USAR EN server.js
// -------------------------------------------------------
module.exports = db;
