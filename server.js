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

function calc(inicial, producidas, queda) {
    const total = num(inicial) + num(producidas);
    return {
        total,
        vendidas: total - num(queda),
        final: num(queda)
    };
}

// FUNCIÓN CENTRAL DE MASAS
function calcularTotalMasas(data) {
    const vendidas = Number(data.vendidas || 0);
    let total = vendidas * 11.25;

    const tradicional_familiar = Number(data.tradicional_familiar || 0);
    const tradicional_mediana = Number(data.tradicional_mediana || 0);
    const tradicional_pequena = Number(data.tradicional_pequena || 0);

    total -= tradicional_familiar * 0.25;
    total -= tradicional_mediana * 1.50;
    total += tradicional_pequena * 0.375;

    const base = 11.25;
    const base_pequena = base / 2;

    const pizzas = {
        vegetariana: { f: 13.50, m: 12.00, p: 8.50 },
        tocino: { f: 12.50, m: 11.00, p: 7.50 },
        carnivora: { f: 15.00, m: 13.50, p: 8.50 },
        pollo: { f: 16.00, m: 14.50, p: 9.00 },
        petete: { f: 16.00, m: 14.50, p: 9.00 },
        cali: { f: 15.00, m: 13.50, p: 8.50 }
    };

    for (let tipo in pizzas) {
        const p = pizzas[tipo];
        const f = Number(data[`${tipo}_familiar`] || 0);
        const m = Number(data[`${tipo}_mediana`] || 0);
        const peq = Number(data[`${tipo}_pequena`] || 0);
        total += f * (p.f - base);
        total += m * (p.m - base);
        total += peq * (p.p - base_pequena);
    }

    return total;
}

// ── Descuenta cajas solo de pizzas llevar ──────────────
async function descontarCajas(db, masasData, fecha, sede) {
    const tipos = ["tradicional", "vegetariana", "tocino", "carnivora", "petete", "pollo", "cali"];

    let grandesLlevar = 0;
    let medianasLlevar = 0;
    let pequeñasLlevar = 0;

    for (const tipo of tipos) {
        grandesLlevar  += num(masasData[`${tipo}_familiar_llevar`]);
        medianasLlevar += num(masasData[`${tipo}_mediana_llevar`]);
        pequeñasLlevar += num(masasData[`${tipo}_pequena_llevar`]);
    }

    const cajas = [
        { producto: "Caja grande",  cantidad: grandesLlevar  },
        { producto: "Caja mediana", cantidad: medianasLlevar },
        { producto: "Caja pequeña", cantidad: pequeñasLlevar },
    ];

    for (const { producto, cantidad } of cajas) {


        const anterior = await db.get(`
            SELECT final FROM inventario_diario
            WHERE producto = ? AND sede = ?
            ORDER BY id DESC LIMIT 1
        `, [producto, sede]);

        const inicial = anterior ? anterior.final : 0;
        const final   = inicial - cantidad;

        if (final < 0) {
            throw new Error(`No hay suficientes ${producto} (necesitas ${cantidad}, hay ${inicial})`);
        }

        await db.run(`
            INSERT INTO inventario_diario
            (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
            VALUES (?, ?, ?, 0, ?, ?, 0, ?)
        `, [fecha, producto, inicial, cantidad, final, sede]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────

app.get("/debug-productos", async (req, res) => {
    const db = await dbPromise;
    const rows = await db.all("SELECT nombre, sede FROM productos");
    res.json(rows);
});

app.get("/seed", async (req, res) => {
    const db = await dbPromise;
    const productos = [
        ['Masas', 11.25],
        ['Caja grande', 0],
        ['Caja mediana', 0],
        ['Caja pequeña', 0],
        ['Cola personal', 0.75],
        ['Cola de litro', 1.50],
        ['Jugo Botella', 0.50],
        ['Fuze Tea litro', 1.50],
        ['Botella de Agua', 0.50]
    ];
    for (let [nombre, precio] of productos) {
        for (const sede of ["sede1", "sede2"]) {
            await db.run(
                `INSERT OR REPLACE INTO productos (nombre, precio, sede, tipo) VALUES (?, ?, ?, 'venta')`,
                [nombre, precio, sede]
            );
        }
    }
    res.send("Productos creados para sede1 y sede2");
});

app.get("/debug-cajas", async (req, res) => {
    const db = await dbPromise;
    const { sede } = req.query;
    const rows = await db.all(`
        SELECT producto, id, fecha, inicial, vendidas, final 
        FROM inventario_diario 
        WHERE producto IN ('Caja mediana', 'Caja pequeña') 
        AND sede = ?
        ORDER BY id DESC
    `, [sede]);
    res.json(rows);
});


app.post("/movimiento-stock", async (req, res) => {
    const db = await dbPromise;
    const { producto, cantidad, sede, descontarMasas } = req.body;
    const fecha = "2026-01-01";

    const anterior = await db.get(`
        SELECT final FROM inventario_diario
        WHERE producto = ? AND sede = ?
        ORDER BY id DESC LIMIT 1
    `, [producto, sede]);

    const inicial = anterior ? anterior.final : 0;
    let nuevo = inicial + cantidad;

    if (nuevo < 0) return res.json({ ok: false, error: "Stock no puede ser negativo" });

    await db.run(`
        INSERT INTO inventario_diario
        (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [fecha, producto, inicial, cantidad > 0 ? cantidad : 0, cantidad < 0 ? Math.abs(cantidad) : 0, nuevo, 0, sede]);

    if (descontarMasas && cantidad < 0) {
        const masasAnterior = await db.get(`
            SELECT final FROM inventario_diario
            WHERE producto = 'Masas' AND sede = ?
            ORDER BY id DESC LIMIT 1
        `, [sede]);

        const masasInicial = masasAnterior ? masasAnterior.final : 0;
        let masasUsadas = Math.abs(cantidad);
        if (producto.toLowerCase().includes("peque")) masasUsadas = masasUsadas / 2;
        const masasFinal = masasInicial - masasUsadas;

        if (masasFinal < 0) return res.json({ ok: false, error: "No hay masas suficientes" });

        await db.run(`
            INSERT INTO inventario_diario
            (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [fecha, "Masas", masasInicial, 0, masasUsadas, masasFinal, 0, sede]);
    }

    res.json({ ok: true, nuevo });
});

app.post("/registrar-venta", async (req, res) => {
    const db = await dbPromise;
    const { tamaño, cantidad, tipo, sede } = req.body;
    const fecha = new Date().toISOString().split("T")[0];

    try {
        const masasRow = await db.get(`
            SELECT final FROM inventario_diario
            WHERE producto = 'Masas' AND sede = ?
            ORDER BY id DESC LIMIT 1
        `, [sede]);

        const masasInicial = masasRow ? masasRow.final : 0;
        let masasUsadas = 0;
        if (tamaño === "familiar") masasUsadas = cantidad;
        if (tamaño === "mediana")  masasUsadas = cantidad;
        if (tamaño === "pequena")  masasUsadas = cantidad / 2;

        const masasFinal = masasInicial - masasUsadas;
        if (masasFinal < 0) return res.json({ ok: false, error: "No hay masas suficientes" });

        await db.run(`
            INSERT INTO inventario_diario
            (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [fecha, "Masas", masasInicial, 0, masasUsadas, masasFinal, 0, sede]);

        if (tipo === "llevar") {
            let caja = "";
            if (tamaño === "familiar") caja = "Caja grande";
            if (tamaño === "mediana")  caja = "Caja mediana";
            if (tamaño === "pequena")  caja = "Caja pequeña";

            const cajaRow = await db.get(`
                SELECT final FROM inventario_diario
                WHERE producto = ? AND sede = ?
                ORDER BY id DESC LIMIT 1
            `, [caja, sede]);

            const cajaInicial = cajaRow ? cajaRow.final : 0;
            const cajaFinal   = cajaInicial - cantidad;

            if (cajaFinal < 0) return res.json({ ok: false, error: "No hay cajas suficientes" });

            await db.run(`
                INSERT INTO inventario_diario
                (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [fecha, caja, cajaInicial, 0, cantidad, cajaFinal, 0, sede]);
        }

        res.json({ ok: true });
    } catch (err) {
        console.log(err);
        res.json({ ok: false, error: "Error registrando venta" });
    }
});

app.get("/resumen", async (req, res) => {
    const db = await dbPromise;
    const { sede } = req.query;
    const rows = await db.all(`SELECT * FROM resumen_diario WHERE sede = ? ORDER BY fecha DESC`, [sede]);
    res.json(rows);
});

app.get("/stock-actual", async (req, res) => {
    const db = await dbPromise;
    const { sede } = req.query;
    const rows = await db.all(`
        SELECT producto, final FROM inventario_diario
        WHERE id IN (
            SELECT MAX(id) FROM inventario_diario WHERE sede = ? GROUP BY producto
        )
    `, [sede]);
    res.json(rows);
});

app.get("/productos", async (req, res) => {
    const db = await dbPromise;
    const { sede } = req.query;
    const productos = await db.all(`
        SELECT nombre, precio FROM productos
        WHERE sede = ? AND tipo = 'venta'
        GROUP BY nombre ORDER BY nombre
    `, [sede]);
    res.json(productos);
});

app.get("/ingredientes", async (req, res) => {
    const db = await dbPromise;
    const { sede } = req.query;
    const ingredientes = await db.all(`
        SELECT nombre FROM productos
        WHERE sede = ? AND tipo = 'ingrediente' ORDER BY nombre
    `, [sede]);
    res.json(ingredientes);
});

app.get("/seed-ingredientes", async (req, res) => {
    const db = await dbPromise;
    const ingredientes = [
        "Mortadela","Queso","Peperoni","Piña","Harina","Levadura","Azúcar","Mantequilla","Sal",
        "Cajas","Salsa de tomate","Maiz Sabrosa","Porta pizza","Platos de torta número 6",
        "Funda de aluminio","Fundas de basura","Fundas dina negra","Fundas dina blanca",
        "Vasos","Fundas de bolos","Óregano","Salami","Servilletas","Jamón",
        "Tachos de Mayonesa","Caja de schet mayonesa","Caja de schet salsatomate",
        "Maíz","Champiñones","Tocino"
    ];
    for (const nombre of ingredientes) {
        await db.run(`INSERT OR IGNORE INTO productos (nombre, precio, sede, tipo) VALUES (?, 0, 'sede1', 'ingrediente')`, [nombre]);
        await db.run(`INSERT OR IGNORE INTO productos (nombre, precio, sede, tipo) VALUES (?, 0, 'sede2', 'ingrediente')`, [nombre]);
    }
    res.json({ ok: true });
});

app.post("/guardar-ingrediente", async (req, res) => {
    const db = await dbPromise;
    const { nombre, sede } = req.body;
    try {
        await db.run(`INSERT INTO productos (nombre, precio, sede, tipo) VALUES (?, ?, ?, 'ingrediente')`, [nombre, 0, sede]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post("/inventario", async (req, res) => {
    const db = await dbPromise;
    let { fecha, producto, inicial, producidas, queda, sede } = req.body;
    fecha = normalizarFecha(fecha);

    if (inicial === undefined) {
        const anterior = await db.get(`
            SELECT final FROM inventario_diario
            WHERE producto = ? AND sede = ? AND fecha < ?
            ORDER BY fecha DESC LIMIT 1
        `, [producto, sede, fecha]);
        inicial = anterior ? anterior.final : 0;
    }

    const prod = await db.get("SELECT precio FROM productos WHERE nombre = ? AND sede = ?", [producto, sede]);
    if (!prod) return res.json({ error: "Producto no existe" });

    const { total, vendidas, final } = calc(inicial, producidas, queda);
    if (vendidas > inicial + producidas) throw new Error(`No hay suficiente stock de ${producto}`);
    if (queda > total) return res.json({ error: "No puedes tener más de lo que produciste", total_disponible: total, queda });

    if (producto === "Masas") {
        let usadas = 0;
        usadas += num(req.body.tradicional_familiar);
        usadas += num(req.body.tradicional_mediana);
        usadas += num(req.body.tradicional_pequena) / 2;
        const tipos = ["vegetariana", "tocino", "carnivora", "pollo", "petete", "cali"];
        tipos.forEach(t => {
            usadas += num(req.body[`${t}_familiar`]);
            usadas += num(req.body[`${t}_mediana`]);
            usadas += num(req.body[`${t}_pequena`]) / 2;
        });
        if (usadas !== vendidas) return res.json({ error: "Debes especificar todas las masas", usadas, vendidas });
    }

    let total_vendido = vendidas * prod.precio;
    if (producto === "Masas") total_vendido = calcularTotalMasas({ vendidas, ...req.body });

    await db.run(`
        INSERT INTO inventario_diario
        (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede]);

    res.json({ ok: true, total_vendido, vendidas });
});

app.get("/debug-inventario", async (req, res) => {
    const db = await dbPromise;
    const rows = await db.all("SELECT * FROM inventario_diario");
    res.json(rows);
});

app.get("/historial", async (req, res) => {
    const db = await dbPromise;
    const { sede, desde, hasta } = req.query;
    try {
        let query = `SELECT fecha, producto, inicial, producidas, vendidas, final FROM inventario_diario WHERE sede = ?`;
        const params = [sede];
        if (desde && hasta) { query += ` AND fecha BETWEEN ? AND ?`; params.push(desde, hasta); }
        query += ` ORDER BY fecha DESC, producto ASC`;
        const rows = await db.all(query, params);
        res.json(rows);
    } catch (err) {
        console.log(err);
        res.json({ ok: false });
    }
});

// ── HISTORIAL PIZZAS  ────────────────
app.get("/historial-pizzas", async (req, res) => {
    const db = await dbPromise;
    const { sede } = req.query;
    try {
        const rows = await db.all(`
            SELECT r.fecha, r.base, r.total, r.total_final,
                   v.tipo, v.tamaño, v.modalidad,
                   SUM(v.cantidad) as cantidad
            FROM resumen_diario r
            LEFT JOIN ventas_pizzas v ON v.fecha = r.fecha AND v.sede = r.sede
            WHERE r.sede = ?
            GROUP BY r.fecha, v.tipo, v.tamaño, v.modalidad
            ORDER BY r.fecha DESC
        `, [sede]);
        res.json(rows);
    } catch (err) {
        console.log(err);
        res.json({ ok: false });
    }
});

app.post("/pagos", async (req, res) => {
    const db = await dbPromise;
    const { trabajador, monto, fecha, concepto, sede } = req.body;
    if (!trabajador || !monto || !fecha || !sede) return res.json({ ok: false, error: "Faltan datos" });
    try {
        await db.run(`INSERT INTO pagos (trabajador, monto, fecha, concepto, sede) VALUES (?, ?, ?, ?, ?)`, [trabajador, monto, fecha, concepto || "", sede]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/dia", async (req, res) => {
    const db = await dbPromise;
    const { fecha, sede } = req.query;
    if (!fecha || !sede) return res.json({ ok: false, error: "Faltan datos" });
    try {
        await db.exec("BEGIN TRANSACTION");
        await db.run(`DELETE FROM inventario_diario WHERE fecha = ? AND sede = ?`, [fecha, sede]);
        await db.run(`DELETE FROM resumen_diario WHERE fecha = ? AND sede = ?`, [fecha, sede]);
        await db.run(`DELETE FROM ventas_pizzas WHERE fecha = ? AND sede = ?`, [fecha, sede]);
        await db.exec("COMMIT");
        res.json({ ok: true });
    } catch (err) {
        await db.exec("ROLLBACK");
        res.json({ ok: false, error: err.message });
    }
});

app.patch("/dia", async (req, res) => {
    const db = await dbPromise;
    const { fecha, sede, base, gastos, transferencias, adicionales, descripcion_gastos, descripcion_adicionales, total } = req.body;
    if (!fecha || !sede) return res.json({ ok: false, error: "Faltan datos" });
    try {
        const total_final = Number(total || 0) + Number(base || 0) - Number(transferencias || 0) - Number(gastos || 0) + Number(adicionales || 0);
        await db.run(`
            UPDATE resumen_diario
            SET base = ?, gastos = ?, transferencias = ?, adicionales = ?,
                descripcion_gastos = ?, descripcion_adicionales = ?, total_final = ?
            WHERE fecha = ? AND sede = ?
        `, [Number(base || 0), Number(gastos || 0), Number(transferencias || 0), Number(adicionales || 0),
            descripcion_gastos || "", descripcion_adicionales || "", total_final, fecha, sede]);
        res.json({ ok: true, total_final });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.get("/pendientes", async (req, res) => {
    const db = await dbPromise;
    const { sede } = req.query;
    try {
        const rows = await db.all(`SELECT * FROM pendientes WHERE sede = ? ORDER BY pagado ASC, fecha DESC`, [sede]);
        res.json(rows);
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post("/pendientes", async (req, res) => {
    const db = await dbPromise;
    const { trabajador, monto, descripcion, sede } = req.body;
    const fecha = new Date().toISOString().split("T")[0];
    try {
        await db.run(`INSERT INTO pendientes (trabajador, monto, descripcion, fecha, pagado, sede) VALUES (?, ?, ?, ?, 0, ?)`, [trabajador, monto, descripcion || "", fecha, sede]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.patch("/pendientes/:id", async (req, res) => {
    const db = await dbPromise;
    const { id } = req.params;
    try {
        // Obtener el pendiente
        const pendiente = await db.get(`SELECT * FROM pendientes WHERE id = ?`, [id]);
        if (!pendiente) return res.json({ ok: false, error: "No encontrado" });

        // Marcarlo como pagado
        await db.run(`UPDATE pendientes SET pagado = 1 WHERE id = ?`, [id]);

        // Registrarlo en historial de pagos
        const fecha = new Date().toISOString().split("T")[0];
        await db.run(
            `INSERT INTO pagos (trabajador, monto, fecha, concepto, sede) VALUES (?, ?, ?, ?, ?)`,
            [pendiente.trabajador, pendiente.monto, fecha, pendiente.descripcion || "Pago pendiente", pendiente.sede]
        );

        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/pendientes/:id", async (req, res) => {
    const db = await dbPromise;
    const { id } = req.params;
    try {
        await db.run(`DELETE FROM pendientes WHERE id = ?`, [id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.get("/pagos", async (req, res) => {
    const db = await dbPromise;
    const { sede, trabajador, desde, hasta } = req.query;
    let query = `SELECT * FROM pagos WHERE sede = ?`;
    const params = [sede];
    if (trabajador) { query += ` AND trabajador LIKE ?`; params.push(`%${trabajador}%`); }
    if (desde && hasta) { query += ` AND fecha BETWEEN ? AND ?`; params.push(desde, hasta); }
    else if (desde) { query += ` AND fecha >= ?`; params.push(desde); }
    else if (hasta) { query += ` AND fecha <= ?`; params.push(hasta); }
    query += ` ORDER BY fecha DESC`;
    try {
        const rows = await db.all(query, params);
        res.json(rows);
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/pagos/:id", async (req, res) => {
    const db = await dbPromise;
    const { id } = req.params;
    try {
        await db.run(`DELETE FROM pagos WHERE id = ?`, [id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ------------------------------------------------------
// GUARDAR TODO DIA — con descuento de cajas por llevar
// ------------------------------------------------------
app.post("/guardar-todo", async (req, res) => {
    const db = await dbPromise;
    let total_dia = 0;
    let total_pizzas = 0;
    let total_bebidas = 0;

    let { fecha, sede, productos, base, transferencias, gastos, adicionales, descripcion_gastos, descripcion_adicionales } = req.body;

    base = num(base);
    transferencias = num(transferencias);
    gastos = num(gastos);
    adicionales = num(adicionales);
    fecha = normalizarFecha(fecha);

    try {
        const existe = await db.get(`SELECT id FROM resumen_diario WHERE fecha = ? AND sede = ?`, [fecha, sede]);
        if (existe) return res.json({ ok: false, error: "DIA_REGISTRADO" });

        await db.exec("BEGIN TRANSACTION");

        // ── GUARDAR PIZZAS EN ventas_pizzas separando mesa y llevar ──────────
        for (let p of productos[0] ? [productos[0]] : []) {
            const tipos = ["tradicional", "vegetariana", "tocino", "carnivora", "petete", "pollo", "cali"];
            for (let tipo of tipos) {
                const f   = num(p[`${tipo}_familiar`]);
                const m   = num(p[`${tipo}_mediana`]);
                const peq = num(p[`${tipo}_pequena`]);

                const fL   = num(p[`${tipo}_familiar_llevar`]);
                const mL   = num(p[`${tipo}_mediana_llevar`]);
                const peqL = num(p[`${tipo}_pequena_llevar`]);

                // Pizzas en mesa = total - llevar
                const fM   = f   - fL;
                const mM   = m   - mL;
                const peqM = peq - peqL;

                // Insertar pizzas en mesa
                if (fM   > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES (?, ?, ?, 'familiar', ?, 'mesa')`,  [fecha, sede, tipo, fM]);
                if (mM   > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES (?, ?, ?, 'mediana', ?, 'mesa')`,   [fecha, sede, tipo, mM]);
                if (peqM > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES (?, ?, ?, 'pequena', ?, 'mesa')`,   [fecha, sede, tipo, peqM]);

                // Insertar pizzas para llevar
                if (fL   > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES (?, ?, ?, 'familiar', ?, 'llevar')`, [fecha, sede, tipo, fL]);
                if (mL   > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES (?, ?, ?, 'mediana', ?, 'llevar')`,  [fecha, sede, tipo, mL]);
                if (peqL > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES (?, ?, ?, 'pequena', ?, 'llevar')`,  [fecha, sede, tipo, peqL]);
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        await db.run(`DELETE FROM inventario_diario WHERE fecha = ? AND sede = ?`, [fecha, sede]);

        // GUARDAR MASAS Y BEBIDAS 
        for (let item of productos) {
            if (["Caja grande", "Caja mediana", "Caja pequeña"].includes(item.producto)) continue;

            const prod = await db.get("SELECT precio FROM productos WHERE nombre = ? AND sede = ?", [item.producto, sede]);
            if (!prod) continue;

            const inicial    = num(item.inicial);
            const producidas = num(item.producidas);
            const queda      = num(item.queda);
            const { total, vendidas, final } = calc(inicial, producidas, queda);

            if (queda > total) throw new Error(`Stock inválido en ${item.producto}`);

            const vendidasSafe = Math.max(0, vendidas);
            let total_vendido = vendidas * prod.precio;

            if (item.producto === "Masas") {
                total_vendido = calcularTotalMasas({ vendidas, ...item });
                total_pizzas += total_vendido;
            } else {
                total_bebidas += total_vendido;
            }

            total_dia += total_vendido;

            await db.run(`
                INSERT INTO inventario_diario
                (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [fecha, item.producto, inicial, producidas, vendidasSafe, final, total_vendido, sede]);
        }

        // ── DESCONTAR CAJAS solo de pizzas llevar ────────────────────────────
        if (productos[0] && productos[0].producto === "Masas") {
            await descontarCajas(db, productos[0], fecha, sede);
        }
    

        const total_final = total_dia + base - transferencias - gastos + adicionales;

        await db.run(`
            INSERT OR REPLACE INTO resumen_diario
            (fecha, base, adicionales, gastos, descripcion_gastos, descripcion_adicionales, transferencias, total, total_final, sede)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [fecha, base, adicionales, gastos, descripcion_gastos || "", descripcion_adicionales || "", transferencias, total_dia, total_final, sede]);

        await db.exec("COMMIT");

        res.json({
            ok: true,
            resumen: { pizzas: total_pizzas, bebidas: total_bebidas, total: total_dia, base, transferencias, gastos, adicionales, total_final }
        });

    } catch (err) {
        await db.exec("ROLLBACK");
        console.error(err);
        res.json({ ok: false, error: err.message });
    }
});


// ── PEDIDOS ──────────────────────────────────────────

app.get("/pedidos", async (req, res) => {
    const db = await dbPromise;
    const { sede, todos } = req.query;
    try {
        let query = `SELECT * FROM pedidos WHERE sede = ?`;
        if (!todos) query += ` AND estado != 'entregado'`;
        query += ` ORDER BY id DESC`;
        const rows = await db.all(query, [sede]);
        const parsed = rows.map(r => ({ ...r, pizzas: JSON.parse(r.pizzas) }));
        res.json(parsed);
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post("/pedidos", async (req, res) => {
    const db = await dbPromise;
    const { cliente, telefono, direccion, pizzas, notas, sede } = req.body;
    if (!cliente || !direccion || !pizzas || !sede)
        return res.json({ ok: false, error: "Faltan datos obligatorios" });
    const fecha = new Date().toISOString().split("T")[0];
    try {
        const result = await db.run(
            `INSERT INTO pedidos (cliente, telefono, direccion, pizzas, notas, estado, fecha, sede)
             VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?)`,
            [cliente, telefono || "", direccion, JSON.stringify(pizzas), notas || "", fecha, sede]
        );
        res.json({ ok: true, id: result.lastID });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.put("/pedidos/:id", async (req, res) => {
    const db = await dbPromise;
    const { id } = req.params;
    const { cliente, telefono, direccion, pizzas, notas } = req.body;
    if (!cliente || !direccion || !pizzas)
        return res.json({ ok: false, error: "Faltan datos obligatorios" });
    try {
        await db.run(
            `UPDATE pedidos SET cliente = ?, telefono = ?, direccion = ?, pizzas = ?, notas = ? WHERE id = ?`,
            [cliente, telefono || "", direccion, JSON.stringify(pizzas), notas || "", id]
        );
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.patch("/pedidos/:id", async (req, res) => {
    const db = await dbPromise;
    const { id } = req.params;
    const { estado } = req.body;
    const estados = ["pendiente", "entregado"];
    if (!estados.includes(estado))
        return res.json({ ok: false, error: "Estado inválido" });
    try {
        await db.run(`UPDATE pedidos SET estado = ? WHERE id = ?`, [estado, id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/pedidos/:id", async (req, res) => {
    const db = await dbPromise;
    const { id } = req.params;
    try {
        await db.run(`DELETE FROM pedidos WHERE id = ?`, [id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.get("/precios-pizzas", (req, res) => {
    res.json({
        tradicional: { f: 11.00, m: 9.75,  p: 6.00  },
        vegetariana:  { f: 13.50, m: 12.00, p: 8.50  },
        tocino:       { f: 12.50, m: 11.00, p: 7.50  },
        carnivora:    { f: 15.00, m: 13.50, p: 8.50  },
        pollo:        { f: 16.00, m: 14.50, p: 9.00  },
        petete:       { f: 16.00, m: 14.50, p: 9.00  },
        cali:         { f: 15.00, m: 13.50, p: 8.50  },
    });
});

// ------------------------------------------------------
// LOGIN
// ------------------------------------------------------
app.post("/login", async (req, res) => {
    const db = await dbPromise;
    const { usuario, password } = req.body;
    const user = await db.get("SELECT * FROM usuarios WHERE usuario = ?", [usuario]);
    if (!user) return res.json({ ok: false });
    const match = bcrypt.compareSync(password, user.password);
    res.json({ ok: match, usuario: user.usuario });
});

app.get("/crear-usuario", async (req, res) => {
    const db = await dbPromise;
    const { usuario, password } = req.query;
    if (!usuario || !password) return res.json({ ok: false, error: "Faltan datos" });
    const hash = bcrypt.hashSync(password, 10);
    try {
        await db.run("INSERT INTO usuarios (usuario, password) VALUES (?, ?)", [usuario, hash]);
        res.json({ ok: true, mensaje: `Usuario ${usuario} creado` });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ------------------------------------------------------
// INICIAR SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;

(async () => {
    const db = await dbPromise;

    // Migraciones seguras
    try { await db.exec(`ALTER TABLE resumen_diario ADD COLUMN descripcion_gastos TEXT`); } catch (e) {}
    try { await db.exec(`ALTER TABLE resumen_diario ADD COLUMN descripcion_adicionales TEXT`); } catch (e) {}
    try { await db.exec(`ALTER TABLE resumen_diario RENAME COLUMN extras TO adicionales`); } catch (e) {}
    try { await db.exec(`ALTER TABLE ventas_pizzas ADD COLUMN modalidad TEXT DEFAULT 'mesa'`); } catch (e) {}
    try { await db.exec(`ALTER TABLE pedidos ADD COLUMN notas TEXT`); } catch (e) {}
    // Tablas


    await db.exec(`CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL,
    telefono TEXT,
    direccion TEXT NOT NULL,
    pizzas TEXT NOT NULL,
    estado TEXT DEFAULT 'pendiente',
    notas TEXT,
    fecha TEXT,
    sede TEXT
);`);


    await db.exec(`CREATE TABLE IF NOT EXISTS ventas_pizzas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT,
        sede TEXT,
        tipo TEXT,
        tamaño TEXT,
        cantidad INTEGER,
        modalidad TEXT DEFAULT 'mesa'
    );`);

    await db.exec(`CREATE TABLE IF NOT EXISTS productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT,
        precio REAL,
        sede TEXT,
        tipo TEXT DEFAULT 'venta'
    );`);

    await db.exec(`CREATE TABLE IF NOT EXISTS resumen_diario (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT,
        base REAL DEFAULT 0,
        adicionales REAL DEFAULT 0,
        gastos REAL DEFAULT 0,
        descripcion_gastos TEXT,
        descripcion_adicionales TEXT,
        transferencias REAL DEFAULT 0,
        total REAL DEFAULT 0,
        total_final REAL DEFAULT 0,
        sede TEXT,
        UNIQUE(fecha, sede)
    );`);

    await db.exec(`CREATE TABLE IF NOT EXISTS inventario_diario (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT,
        producto TEXT,
        inicial INTEGER,
        producidas INTEGER,
        vendidas INTEGER,
        final INTEGER,
        total_vendido REAL,
        sede TEXT
    );`);

    await db.exec(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT UNIQUE,
        password TEXT
    );`);

    await db.exec(`CREATE TABLE IF NOT EXISTS pendientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trabajador TEXT,
        monto REAL,
        descripcion TEXT,
        fecha TEXT,
        pagado INTEGER DEFAULT 0,
        sede TEXT
    );`);

    await db.exec(`CREATE TABLE IF NOT EXISTS pagos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trabajador TEXT,
        monto REAL,
        fecha TEXT,
        concepto TEXT,
        sede TEXT
    );`);

    console.log("DB lista");
    app.listen(PORT, "0.0.0.0", () => console.log("Servidor corriendo en puerto " + PORT));
})();