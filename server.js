const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const bcrypt = require("bcryptjs");

// DB
const dbPromise = open({
  filename: "pizzeria.db",
  driver: sqlite3.Database
});

const app = express();
app.use(express.json());
app.use(cors());
const path = require("path");

// app.use(express.static(__dirname));


function normalizarFecha(fecha) {
  if (!fecha) return fecha;

  if (fecha.includes("/")) {
    const [d, m, y] = fecha.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return fecha;
}

// ------------------------------------------------------
// PRODUCTOS
// ------------------------------------------------------
app.get("/productos", async (req, res) => {
  const db = await dbPromise;
  const { sede } = req.query;

  const productos = await db.all(`     SELECT nombre, precio
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
       VALUES (?, ?, ?, ?)`,
      [nombre, 0, sede, 'ingrediente']
    );

    res.json({ ok: true });

  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});
app.post("/sumar-inventario", async (req, res) => {
  const db = await dbPromise;
  const { producto, cantidad, sede } = req.body;

  try {

    await db.run(`
      INSERT INTO inventario_diario 
      (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
      VALUES (date('now'), ?, 0, ?, 0, ?, 0, ?)
    `, [producto, cantidad, cantidad, sede]);

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});
app.post("/restar-inventario", async (req, res) => {
  const db = await dbPromise;
  const { producto, cantidad, sede } = req.body;

  try {

    await db.run(`
      INSERT INTO inventario_diario 
      (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
      VALUES (date('now'), ?, 0, 0, ?, 0, 0, ?)
    `, [producto, cantidad, sede]);

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

app.get('/existe-dia', async (req, res) => {

  const db = await dbPromise;
  let { fecha, sede } = req.query;

  fecha = normalizarFecha(fecha);

  try {

    const row = await db.get(
      `SELECT * FROM cierre_dia WHERE fecha = ? AND sede = ?`,
      [fecha, sede]
    );

    res.json({ existe: !!row });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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

  if (!prod) {
    return res.json({ error: "Producto no existe" });
  }

const total = Number(inicial || 0) + Number(producidas || 0);
const vendidas = total - Number(queda || 0);
const final = Number(queda || 0);
 let total_vendido = vendidas * prod.precio;

// 🔥 AJUSTE ESPECIAL PARA MASAS
if (producto === "Masas") {

const cajas_grandes = Number(req.body.cajas_grandes || 0);
const cajas_medianas = Number(req.body.cajas_medianas || 0);
const cajas_pequenas = Number(req.body.cajas_pequenas || 0);

const especiales_familiar = Number(req.body.especiales_familiar || 0);
const especiales_mediana = Number(req.body.especiales_mediana || 0);
const especiales_pequena = Number(req.body.especiales_pequena || 0);

  // BASE
  total_vendido = vendidas * 11.25;

  // RESTAS (clásicas)
  total_vendido -= cajas_grandes * 0.25;
  total_vendido -= cajas_medianas * 1.50;

  // SUMA (pequeñas)
  total_vendido += cajas_pequenas * 0.375;

  // ESPECIALES
  total_vendido += especiales_familiar * 3.75;
  total_vendido += especiales_mediana * 2.25;
  total_vendido += especiales_pequena * 1.25;
}

  await db.run(
    `INSERT INTO inventario_diario 
    (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    [fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede]
  );

  res.json({ ok: true });
});


app.post("/editar-inventario", async (req, res) => {
  const db = await dbPromise;
  let { producto, cantidad, fecha, sede } = req.body;

  fecha = normalizarFecha(fecha);

  // registro actual
  const row = await db.get(`
    SELECT * FROM inventario_diario
    WHERE producto = ? AND fecha = ? AND sede = ?
  `, [producto, fecha, sede]);

  if (!row) {
    return res.json({ ok: false, mensaje: "No existe el registro" });
  }

  // 🔍 obtener precio
  const prod = await db.get(
    "SELECT precio FROM productos WHERE nombre = ? AND sede = ?",
    [producto, sede]
  );

  const inicial = row.inicial || 0;

  // 🔥 CAMBIO: ahora entradas = cantidad editada
  const producidas = cantidad;

  const final = cantidad;
  const vendidas = (inicial + producidas) - final;
  const total_vendido = vendidas * (prod?.precio || 0);

  const result = await db.run(`
    UPDATE inventario_diario
    SET final = ?, producidas = ?, vendidas = ?, total_vendido = ?
    WHERE producto = ? AND fecha = ? AND sede = ?
  `, [final, producidas, vendidas, total_vendido, producto, fecha, sede]);

  console.log("FILAS ACTUALIZADAS:", result.changes);

  res.json({ ok: true });
});
// ------------------------------------------------------
// INVENTARIO ACTUAL
// ------------------------------------------------------
app.get("/inventario", async (req, res) => {
  const db = await dbPromise;
  const { sede } = req.query;

  try {
    const rows = await db.all(`
      SELECT 
        producto,
        SUM(producidas) 
        + (
            SELECT inicial 
            FROM inventario_diario i2
            WHERE i2.producto = i1.producto
            AND i2.sede = i1.sede
            ORDER BY id ASC
            LIMIT 1
          )
        - SUM(vendidas) AS cantidad

      FROM inventario_diario i1
      WHERE sede = ?
      GROUP BY producto
      ORDER BY producto
    `, [sede]);

    res.json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


app.get("/historial-ingrediente", async (req, res) => {
  const db = await dbPromise;
  const { producto, sede } = req.query;

  try {

    const rows = await db.all(`
      SELECT 
        fecha,
        producidas as entradas,
        vendidas as salidas
      FROM inventario_diario
      WHERE producto = ? AND sede = ?
      ORDER BY id DESC
      LIMIT 10
    `, [producto, sede]);

    res.json(rows);

  } catch (err) {
    console.error(err);
    res.json([]);
  }
});


// ------------------------------------------------------
// GUARDADO 
// ------------------------------------------------------
app.post("/guardar-todo", async (req, res) => {
  const db = await dbPromise;

  let { fecha, sede, productos } = req.body;

  fecha = normalizarFecha(fecha);

  try {

    await db.exec("BEGIN TRANSACTION");

    for (let item of productos) {

      const prod = await db.get(
        "SELECT precio FROM productos WHERE nombre = ? AND sede = ?",
        [item.producto, sede]
      );

      if (!prod) continue;

      const inicial = Number(item.inicial || 0);
      const producidas = Number(item.producidas || 0);
      const queda = Number(item.queda || 0);

      const total = inicial + producidas;
      const vendidas = total - queda;
      const final = queda;

      let total_vendido = vendidas * (prod.precio || 0);

      // 🔥 AJUSTE ESPECIAL PARA MASAS
      if (item.producto === "Masas") {

        const cajas_grandes = Number(item.cajas_grandes || 0);
        const cajas_medianas = Number(item.cajas_medianas || 0);
        const cajas_pequenas = Number(item.cajas_pequenas || 0);

        const especiales_familiar = Number(item.especiales_familiar || 0);
        const especiales_mediana = Number(item.especiales_mediana || 0);
        const especiales_pequena = Number(item.especiales_pequena || 0);

        // BASE
        total_vendido = vendidas * 11.25;

        // RESTAS (clásicas)
        total_vendido -= cajas_grandes * 0.25;
        total_vendido -= cajas_medianas * 1.50;

        // SUMA (pequeñas)
        total_vendido += cajas_pequenas * 0.375;

        // ESPECIALES (las que superan 11.25)
        total_vendido += especiales_familiar * 3.75;
        total_vendido += especiales_mediana * 2.25;
        total_vendido += especiales_pequena * 1.25;
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
    console.error("ERROR GUARDAR TODO:", err);
    res.json({ ok: false });
  }
});

app.get("/inventario/resumen-dia", async (req, res) => {
  const db = await dbPromise;
  let { fecha, sede } = req.query;

  fecha = normalizarFecha(fecha);

  try {

    let productos = await db.all(`
      SELECT 
        producto,

        (
          SELECT inicial
          FROM inventario_diario i2
          WHERE i2.producto = inventario_diario.producto
          AND i2.fecha = inventario_diario.fecha
          AND i2.sede = inventario_diario.sede
          ORDER BY i2.id ASC
          LIMIT 1
        ) as inicial,

        SUM(producidas) as producidas,
        SUM(vendidas) as vendidas,
        MAX(final) as final,
        SUM(total_vendido) as total_vendido

      FROM inventario_diario
      WHERE fecha = ? 
      AND sede = ?
      AND producto IN (
      SELECT nombre FROM productos WHERE tipo = 'venta')
      GROUP BY producto
      ORDER BY producto
    `, [fecha, sede]);

    const todos = await db.all(`
      SELECT nombre as producto
      FROM productos
      WHERE sede = ?  AND tipo = 'venta'
    `, [sede]);

    const mapa = {};
    productos.forEach(p => {
      mapa[p.producto] = true;
    });

    todos.forEach(p => {
      if (!mapa[p.producto]) {
        productos.push({
          producto: p.producto,
          inicial: 0,
          producidas: 0,
          vendidas: 0,
          final: 0,
          total_vendido: 0
        });
      }
    });


    productos.sort((a, b) => a.producto.localeCompare(b.producto));
    const total_ventas = productos.reduce(
      (s, r) => s + Number(r.total_vendido || 0),
      0
    );

    const cierre = await db.get(`
      SELECT *
      FROM cierre_dia
      WHERE fecha = ? AND sede = ?
    `, [fecha, sede]);

    res.json({
      productos,
      total_ventas,
      cierre
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/cierre-dia", async (req, res) => {
  const db = await dbPromise;
  let { fecha, sede } = req.query;

  fecha = normalizarFecha(fecha);

  const row = await db.get(
    `SELECT * FROM cierre_dia WHERE fecha = ? AND sede = ?`,
    [fecha, sede]
  );

  res.json(row || {});
});


app.post("/cierre-dia", async (req, res) => {
  const db = await dbPromise;

  let {
    fecha,
    sede,
    base,
    gastos,
    transferencias,
    adicionales,
    adicional_desc,
    gasto_desc
  } = req.body;

  fecha = normalizarFecha(fecha);

  // VALIDAR DUPLICADO
  const existe = await db.get(
    "SELECT id FROM cierre_dia WHERE fecha = ? AND sede = ?",
    [fecha, sede]
  );

  if (existe) {
    return res.json({ error: "⚠️ El día ya fue cerrado" });
  }

  const ventasRow = await db.get(`
    SELECT SUM(total_vendido) as total_ventas
    FROM inventario_diario
    WHERE fecha = ? AND sede = ?
  `, [fecha, sede]);

  const total_ventas = ventasRow?.total_ventas || 0;

  // 🔥 NUEVO CÁLCULO FINANCIERO
  const total_dia =
    total_ventas +
    (base || 0) +
    (adicionales || 0) -
    (transferencias || 0);

  const ganancia = total_dia - (gastos || 0);

  await db.run(`
    INSERT INTO cierre_dia 
    (fecha, sede, base, gastos, transferencias, adicionales, adicional_desc, gasto_desc, total_ventas, total_dia, ganancia)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      fecha,
      sede,
      base || 0,
      gastos || 0,
      transferencias || 0,
      adicionales || 0,
      adicional_desc || "",
      gasto_desc || "",
      total_ventas,
      total_dia,
      ganancia
    ]);

  res.json({ ok: true, total_ventas, total_dia, ganancia });
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
app.get("/usuarios", async (req, res) => {
  const db = await dbPromise;
  const users = await db.all("SELECT * FROM usuarios");
  res.json(users);
});

app.get("/crear-admin", async (req, res) => {
  const db = await dbPromise;

  await db.run(
    "INSERT INTO usuarios (usuario, password) VALUES (?, ?)",
    ["yeisonpaul", bcrypt.hashSync("1525", 10)]
  );

  res.send("Usuario creado ✅");
});

// ------------------------------------------------------
const PORT = process.env.PORT || 3000;

(async () => {
  const db = await dbPromise;

  console.log("⏳ Inicializando base de datos...");

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
    CREATE TABLE IF NOT EXISTS cierre_dia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      sede TEXT,
      base REAL,
      gastos REAL,
      gasto_desc TEXT, 
      transferencias REAL DEFAULT 0,
      adicionales REAL DEFAULT 0,
      adicional_desc TEXT,
      total_ventas REAL,
      total_dia REAL,
      ganancia REAL,
      UNIQUE(fecha, sede)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      password TEXT
    );
  `);

  console.log("✅ DB lista, arrancando servidor...");

  app.listen(PORT, "0.0.0.0", () => {
    console.log("Servidor corriendo en puerto " + PORT);
  });

})();