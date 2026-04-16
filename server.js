const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const bcrypt = require("bcryptjs");

const app = express();
app.use(express.json());
app.use(cors());

// ---------------- DB ----------------
const dbPromise = open({
  filename: "pizzeria.db",
  driver: sqlite3.Database
});

// ---------------- HELPERS ----------------
function normalizarFecha(fecha) {
  if (!fecha) return fecha;

  if (fecha.includes("/")) {
    const [d, m, y] = fecha.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return fecha;
}

const num = (v) => Number(v || 0);

// 🔥 FUNCIÓN CENTRAL DE MASAS
function calcularTotalMasas(data) {
  const vendidas = num(data.vendidas);

  const cajas_grandes = num(data.cajas_grandes);
  const cajas_medianas = num(data.cajas_medianas);
  const cajas_pequenas = num(data.cajas_pequenas);

  const especiales_familiar = num(data.especiales_familiar);
  const especiales_mediana = num(data.especiales_mediana);
  const especiales_pequena = num(data.especiales_pequena);

  let total = vendidas * 11.25;

  total -= cajas_grandes * 0.25;
  total -= cajas_medianas * 1.50;

  total += cajas_pequenas * 0.375;

  total += especiales_familiar * 3.75;
  total += especiales_mediana * 2.25;
  total += especiales_pequena * 1.25;

  return total;
}

// ------------------------------------------------------
// PRODUCTOS
// ------------------------------------------------------
app.get("/productos", async (req, res) => {
  const db = await dbPromise;
  const { sede } = req.query;

  const productos = await db.all(`
    SELECT nombre, precio
    FROM productos
    WHERE sede = ? AND tipo = 'venta'
    GROUP BY nombre
    ORDER BY nombre
  `, [sede]);

  res.json(productos);
});

app.get("/ingredientes", async (req, res) => {
  const db = await dbPromise;
  const { sede } = req.query;

  const ingredientes = await db.all(`
    SELECT nombre
    FROM productos
    WHERE sede = ? AND tipo = 'ingrediente'
    ORDER BY nombre
  `, [sede]);

  res.json(ingredientes);
});

app.post("/guardar-ingrediente", async (req, res) => {
  const db = await dbPromise;
  const { nombre, sede } = req.body;

  try {
    await db.run(
      `INSERT INTO productos (nombre, precio, sede, tipo)
       VALUES (?, ?, ?, 'ingrediente')`,
      [nombre, 0, sede]
    );

    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------
// INVENTARIO
// ------------------------------------------------------
app.post("/inventario", async (req, res) => {
  const db = await dbPromise;

  let { fecha, producto, inicial, producidas, queda, sede } = req.body;

  fecha = normalizarFecha(fecha);

  const prod = await db.get(
    "SELECT precio FROM productos WHERE nombre = ? AND sede = ?",
    [producto, sede]
  );

  if (!prod) return res.json({ error: "Producto no existe" });

  const total = num(inicial) + num(producidas);
  const vendidas = total - num(queda);
  const final = num(queda);

  let total_vendido = vendidas * prod.precio;

  // 🔥 MASAS
  if (producto === "Masas") {
    total_vendido = calcularTotalMasas({
      vendidas,
      ...req.body
    });
  }

  await db.run(`
    INSERT INTO inventario_diario
    (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede]);

  res.json({ ok: true });
});

// ------------------------------------------------------
// GUARDAR TODO (DÍA COMPLETO)
// ------------------------------------------------------
app.post("/guardar-todo", async (req, res) => {
  const db = await dbPromise;

  let { fecha, sede, productos } = req.body;
  fecha = normalizarFecha(fecha);

  try {
    await db.exec("BEGIN TRANSACTION");

    await db.run(
      `DELETE FROM inventario_diario WHERE fecha = ? AND sede = ?`,
      [fecha, sede]
    );

    for (let item of productos) {
      const prod = await db.get(
        "SELECT precio FROM productos WHERE nombre = ? AND sede = ?",
        [item.producto, sede]
      );

      if (!prod) continue;

      const inicial = num(item.inicial);
      const producidas = num(item.producidas);
      const queda = num(item.queda);

      const total = inicial + producidas;
      const vendidas = total - queda;
      const final = queda;

      let total_vendido = vendidas * prod.precio;

      // 🔥 MASAS
      if (item.producto === "Masas") {
        total_vendido = calcularTotalMasas({
          vendidas,
          ...item
        });
      }

      await db.run(`
        INSERT INTO inventario_diario
        (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        fecha,
        item.producto,
        inicial,
        producidas,
        vendidas,
        final,
        total_vendido,
        sede
      ]);
    }

    await db.exec("COMMIT");
    res.json({ ok: true });

  } catch (err) {
    await db.exec("ROLLBACK");
    console.error(err);
    res.json({ ok: false });
  }
});

// ------------------------------------------------------
// LOGIN
// ------------------------------------------------------
app.post("/login", async (req, res) => {
  const db = await dbPromise;
  const { usuario, password } = req.body;

  const user = await db.get(
    "SELECT * FROM usuarios WHERE usuario = ?",
    [usuario]
  );

  if (!user) return res.json({ ok: false });

  const match = bcrypt.compareSync(password, user.password);

  res.json({ ok: match, usuario: user.usuario });
});

// ------------------------------------------------------
// INICIAR SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;

(async () => {
  const db = await dbPromise;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      precio REAL,
      sede TEXT,
      tipo TEXT DEFAULT 'venta'
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS inventario_diario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      producto TEXT,
      inicial INTEGER,
      producidas INTEGER,
      vendidas INTEGER,
      final INTEGER,
      total_vendido REAL,
      sede TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      password TEXT
    );
  `);

  console.log("✅ DB lista");

  app.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 Servidor corriendo en puerto " + PORT);
  });
})();