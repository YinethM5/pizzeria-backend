require("dotenv").config();
process.env.DATABASE_URL = "postgresql://postgres.rpwnbwuelsimnislbflz:Yurani1518-@aws-1-sa-east-1.pooler.supabase.com:6543/postgres";
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(cors());

// ---------------- DB ----------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const db = {
    get: async (query, params) => {
        const res = await pool.query(query, params);
        return res.rows[0] || null;
    },
    all: async (query, params) => {
        const res = await pool.query(query, params);
        return res.rows;
    },
    run: async (query, params) => {
        const res = await pool.query(query, params);
        return { lastID: res.rows[0]?.id, changes: res.rowCount };
    },
    exec: async (query) => {
        await pool.query(query);
    }
};

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

async function descontarCajas(db, masasData, fecha, sede) {
    const tipos = ["tradicional", "vegetariana", "tocino", "carnivora", "petete", "pollo", "cali"];

    let grandesLlevar = 0;
    let medianasLlevar = 0;
    let pequeñasLlevar = 0;

    for (const tipo of tipos) {
        grandesLlevar += num(masasData[`${tipo}_familiar_llevar`]);
        medianasLlevar += num(masasData[`${tipo}_mediana_llevar`]);
        pequeñasLlevar += num(masasData[`${tipo}_pequena_llevar`]);
    }

    const cajas = [
        { producto: "Caja grande", cantidad: grandesLlevar },
        { producto: "Caja mediana", cantidad: medianasLlevar },
        { producto: "Caja pequeña", cantidad: pequeñasLlevar },
    ];

    for (const { producto, cantidad } of cajas) {
        const anterior = await db.get(
            `SELECT final FROM inventario_diario WHERE producto = $1 AND sede = $2 ORDER BY id DESC LIMIT 1`,
            [producto, sede]
        );

        const inicial = anterior ? anterior.final : 0;
        const final = inicial - cantidad;

        if (final < 0) {
            throw new Error(`No hay suficientes ${producto} (necesitas ${cantidad}, hay ${inicial})`);
        }

        await db.run(
            `INSERT INTO inventario_diario (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
             VALUES ($1, $2, $3, 0, $4, $5, 0, $6)`,
            [fecha, producto, inicial, cantidad, final, sede]
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────

app.get("/debug-productos", async (req, res) => {
    const rows = await db.all("SELECT nombre, sede FROM productos");
    res.json(rows);
});

app.get("/seed", async (req, res) => {
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
                `INSERT INTO productos (nombre, precio, sede, tipo) VALUES ($1, $2, $3, 'venta')
                 ON CONFLICT (nombre, sede) DO NOTHING`,
                [nombre, precio, sede]
            );
        }
    }
    res.send("Productos creados para sede1 y sede2");
});

app.get("/debug-cajas", async (req, res) => {
    const { sede } = req.query;
    const rows = await db.all(
        `SELECT producto, id, fecha, inicial, vendidas, final 
         FROM inventario_diario 
         WHERE producto IN ('Caja mediana', 'Caja pequeña') AND sede = $1
         ORDER BY id DESC`,
        [sede]
    );
    res.json(rows);
});

app.post("/movimiento-stock", async (req, res) => {
    const { producto, cantidad, sede, descontarMasas } = req.body;
    const fecha = new Date().toISOString().split("T")[0];

    const anterior = await db.get(
        `SELECT final FROM inventario_diario WHERE producto = $1 AND sede = $2 ORDER BY id DESC LIMIT 1`,
        [producto, sede]
    );

    const inicial = anterior ? anterior.final : 0;
    let nuevo = inicial + cantidad;

    if (nuevo < 0) return res.json({ ok: false, error: "Stock no puede ser negativo" });

    await db.run(
        `INSERT INTO inventario_diario (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
        [fecha, producto, inicial, cantidad > 0 ? cantidad : 0, cantidad < 0 ? Math.abs(cantidad) : 0, nuevo, sede]
    );

    if (descontarMasas && cantidad < 0) {
        const masasAnterior = await db.get(
            `SELECT final FROM inventario_diario WHERE producto = 'Masas' AND sede = $1 ORDER BY id DESC LIMIT 1`,
            [sede]
        );
        const masasInicial = masasAnterior ? masasAnterior.final : 0;
        let masasUsadas = Math.abs(cantidad);
        if (producto.toLowerCase().includes("peque")) masasUsadas = masasUsadas / 2;
        const masasFinal = masasInicial - masasUsadas;

        if (masasFinal < 0) return res.json({ ok: false, error: "No hay masas suficientes" });

        await db.run(
            `INSERT INTO inventario_diario (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
             VALUES ($1, 'Masas', $2, 0, $3, $4, 0, $5)`,
            [fecha, masasInicial, masasUsadas, masasFinal, sede]
        );
    }

    res.json({ ok: true, nuevo });
});

app.get("/resumen", async (req, res) => {
    const { sede } = req.query;
    const rows = await db.all(`SELECT * FROM resumen_diario WHERE sede = $1 ORDER BY fecha DESC`, [sede]);
    res.json(rows);
});

app.get("/stock-actual", async (req, res) => {
    const { sede } = req.query;
    const rows = await db.all(
        `SELECT producto, final FROM inventario_diario
         WHERE id IN (SELECT MAX(id) FROM inventario_diario WHERE sede = $1 GROUP BY producto)`,
        [sede]
    );
    res.json(rows);
});

app.get("/productos", async (req, res) => {
    const { sede } = req.query;
    const productos = await db.all(
        `SELECT nombre, precio FROM productos WHERE sede = $1 AND tipo = 'venta' GROUP BY nombre, precio ORDER BY nombre`,
        [sede]
    );
    res.json(productos);
});

app.get("/ingredientes", async (req, res) => {
    const { sede } = req.query;
    const ingredientes = await db.all(
        `SELECT nombre FROM productos WHERE sede = $1 AND tipo = 'ingrediente' ORDER BY nombre`,
        [sede]
    );
    res.json(ingredientes);
});

app.get("/seed-ingredientes", async (req, res) => {
    const ingredientes = [
        "Mortadela", "Queso", "Peperoni", "Piña", "Harina", "Levadura", "Azúcar", "Mantequilla", "Sal",
        "Cajas", "Salsa de tomate", "Maiz Sabrosa", "Porta pizza", "Platos de torta número 6",
        "Funda de aluminio", "Fundas de basura", "Fundas dina negra", "Fundas dina blanca",
        "Vasos", "Fundas de bolos", "Óregano", "Salami", "Servilletas", "Jamón",
        "Tachos de Mayonesa", "Caja de schet mayonesa", "Caja de schet salsatomate",
        "Maíz", "Champiñones", "Tocino"
    ];
    for (const nombre of ingredientes) {
        await db.run(`INSERT INTO productos (nombre, precio, sede, tipo) VALUES ($1, 0, 'sede1', 'ingrediente') ON CONFLICT DO NOTHING`, [nombre]);
        await db.run(`INSERT INTO productos (nombre, precio, sede, tipo) VALUES ($1, 0, 'sede2', 'ingrediente') ON CONFLICT DO NOTHING`, [nombre]);
    }
    res.json({ ok: true });
});

app.post("/guardar-ingrediente", async (req, res) => {
    const { nombre, sede } = req.body;
    try {
        await db.run(`INSERT INTO productos (nombre, precio, sede, tipo) VALUES ($1, 0, $2, 'ingrediente')`, [nombre, sede]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post("/inventario", async (req, res) => {
    let { fecha, producto, inicial, producidas, queda, sede } = req.body;
    fecha = normalizarFecha(fecha);

    if (inicial === undefined) {
        const anterior = await db.get(
            `SELECT final FROM inventario_diario WHERE producto = $1 AND sede = $2 AND fecha < $3 ORDER BY fecha DESC LIMIT 1`,
            [producto, sede, fecha]
        );
        inicial = anterior ? anterior.final : 0;
    }

    const prod = await db.get("SELECT precio FROM productos WHERE nombre = $1 AND sede = $2", [producto, sede]);
    if (!prod) return res.json({ error: "Producto no existe" });

    const { total, vendidas, final } = calc(inicial, producidas, queda);
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

    await db.run(
        `INSERT INTO inventario_diario (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede]
    );

    res.json({ ok: true, total_vendido, vendidas });
});

app.get("/debug-inventario", async (req, res) => {
    const rows = await db.all("SELECT * FROM inventario_diario");
    res.json(rows);
});

app.get("/historial", async (req, res) => {
    const { sede, desde, hasta } = req.query;
    try {
        let query = `SELECT fecha, producto, inicial, producidas, vendidas, final FROM inventario_diario WHERE sede = $1`;
        const params = [sede];
        if (desde && hasta) { query += ` AND fecha BETWEEN $2 AND $3`; params.push(desde, hasta); }
        query += ` ORDER BY fecha DESC, producto ASC`;
        const rows = await db.all(query, params);
        res.json(rows);
    } catch (err) {
        res.json({ ok: false });
    }
});

app.get("/historial-pizzas", async (req, res) => {
    const { sede } = req.query;
    try {
        const rows = await db.all(
            `SELECT r.fecha, r.base, r.total, r.total_final,
                    v.tipo, v.tamaño, v.modalidad, SUM(v.cantidad) as cantidad
             FROM resumen_diario r
             LEFT JOIN ventas_pizzas v ON v.fecha = r.fecha AND v.sede = r.sede
             WHERE r.sede = $1
             GROUP BY r.fecha, r.base, r.total, r.total_final, v.tipo, v.tamaño, v.modalidad
             ORDER BY r.fecha DESC`,
            [sede]
        );
        res.json(rows);
    } catch (err) {
        res.json({ ok: false });
    }
});

app.post("/pagos", async (req, res) => {
    const { trabajador, monto, fecha, concepto, sede } = req.body;
    if (!trabajador || !monto || !fecha || !sede) return res.json({ ok: false, error: "Faltan datos" });
    try {
        await db.run(
            `INSERT INTO pagos (trabajador, monto, fecha, concepto, sede) VALUES ($1, $2, $3, $4, $5)`,
            [trabajador, monto, fecha, concepto || "", sede]
        );
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/dia", async (req, res) => {
    const { fecha, sede } = req.query;
    if (!fecha || !sede) return res.json({ ok: false, error: "Faltan datos" });
    try {
        await db.exec("BEGIN");
        await db.run(`DELETE FROM inventario_diario WHERE fecha = $1 AND sede = $2`, [fecha, sede]);
        await db.run(`DELETE FROM resumen_diario WHERE fecha = $1 AND sede = $2`, [fecha, sede]);
        await db.run(`DELETE FROM ventas_pizzas WHERE fecha = $1 AND sede = $2`, [fecha, sede]);
        await db.exec("COMMIT");
        res.json({ ok: true });

    } catch (err) {
        await db.exec("ROLLBACK");
        res.json({ ok: false, error: err.message });
    }
});

app.patch("/dia", async (req, res) => {
    const { fecha, sede, base, gastos, transferencias, adicionales, descripcion_gastos, descripcion_adicionales, total } = req.body;
    if (!fecha || !sede) return res.json({ ok: false, error: "Faltan datos" });
    try {
        const total_final = Number(total || 0) + Number(base || 0) - Number(transferencias || 0) - Number(gastos || 0) + Number(adicionales || 0);
        await db.run(
            `UPDATE resumen_diario SET base=$1, gastos=$2, transferencias=$3, adicionales=$4,
             descripcion_gastos=$5, descripcion_adicionales=$6, total_final=$7
             WHERE fecha=$8 AND sede=$9`,
            [Number(base || 0), Number(gastos || 0), Number(transferencias || 0), Number(adicionales || 0),
            descripcion_gastos || "", descripcion_adicionales || "", total_final, fecha, sede]
        );
        res.json({ ok: true, total_final });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.get("/pendientes", async (req, res) => {
    const { sede } = req.query;
    try {
        const rows = await db.all(`SELECT * FROM pendientes WHERE sede = $1 ORDER BY pagado ASC, fecha DESC`, [sede]);
        res.json(rows);
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post("/pendientes", async (req, res) => {
    const { trabajador, monto, descripcion, sede } = req.body;
    const fecha = new Date().toISOString().split("T")[0];
    try {
        await db.run(
            `INSERT INTO pendientes (trabajador, monto, descripcion, fecha, pagado, sede) VALUES ($1, $2, $3, $4, 0, $5)`,
            [trabajador, monto, descripcion || "", fecha, sede]
        );
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.patch("/pendientes/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const pendiente = await db.get(`SELECT * FROM pendientes WHERE id = $1`, [id]);
        if (!pendiente) return res.json({ ok: false, error: "No encontrado" });

        await db.run(`UPDATE pendientes SET pagado = 1 WHERE id = $1`, [id]);

        const fecha = new Date().toISOString().split("T")[0];
        await db.run(
            `INSERT INTO pagos (trabajador, monto, fecha, concepto, sede) VALUES ($1, $2, $3, $4, $5)`,
            [pendiente.trabajador, pendiente.monto, fecha, pendiente.descripcion || "Pago pendiente", pendiente.sede]
        );

        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/pendientes/:id", async (req, res) => {
    const { id } = req.params;
    try {
        await db.run(`DELETE FROM pendientes WHERE id = $1`, [id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.get("/pagos", async (req, res) => {
    const { sede, trabajador, desde, hasta } = req.query;
    let query = `SELECT * FROM pagos WHERE sede = $1`;
    const params = [sede];
    let i = 2;
    if (trabajador) { query += ` AND trabajador ILIKE $${i++}`; params.push(`%${trabajador}%`); }
    if (desde && hasta) { query += ` AND fecha BETWEEN $${i++} AND $${i++}`; params.push(desde, hasta); }
    else if (desde) { query += ` AND fecha >= $${i++}`; params.push(desde); }
    else if (hasta) { query += ` AND fecha <= $${i++}`; params.push(hasta); }
    query += ` ORDER BY fecha DESC`;
    try {
        const rows = await db.all(query, params);
        res.json(rows);
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/pagos/:id", async (req, res) => {
    const { id } = req.params;
    try {
        await db.run(`DELETE FROM pagos WHERE id = $1`, [id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post("/guardar-todo", async (req, res) => {
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
        const existe = await db.get(`SELECT id FROM resumen_diario WHERE fecha = $1 AND sede = $2`, [fecha, sede]);
        if (existe) return res.json({ ok: false, error: "DIA_REGISTRADO" });

        await db.exec("BEGIN");

        for (let p of productos[0] ? [productos[0]] : []) {
            const tipos = ["tradicional", "vegetariana", "tocino", "carnivora", "petete", "pollo", "cali"];
            for (let tipo of tipos) {
                const f = num(p[`${tipo}_familiar`]);
                const m = num(p[`${tipo}_mediana`]);
                const peq = num(p[`${tipo}_pequena`]);
                const fL = num(p[`${tipo}_familiar_llevar`]);
                const mL = num(p[`${tipo}_mediana_llevar`]);
                const peqL = num(p[`${tipo}_pequena_llevar`]);
                const fM = f - fL;
                const mM = m - mL;
                const peqM = peq - peqL;

                if (fM > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES ($1,$2,$3,'familiar',$4,'mesa')`, [fecha, sede, tipo, fM]);
                if (mM > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES ($1,$2,$3,'mediana',$4,'mesa')`, [fecha, sede, tipo, mM]);
                if (peqM > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES ($1,$2,$3,'pequena',$4,'mesa')`, [fecha, sede, tipo, peqM]);
                if (fL > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES ($1,$2,$3,'familiar',$4,'llevar')`, [fecha, sede, tipo, fL]);
                if (mL > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES ($1,$2,$3,'mediana',$4,'llevar')`, [fecha, sede, tipo, mL]);
                if (peqL > 0) await db.run(`INSERT INTO ventas_pizzas (fecha, sede, tipo, tamaño, cantidad, modalidad) VALUES ($1,$2,$3,'pequena',$4,'llevar')`, [fecha, sede, tipo, peqL]);
            }
        }

        await db.run(`DELETE FROM inventario_diario WHERE fecha = $1 AND sede = $2`, [fecha, sede]);

        for (let item of productos) {
            if (["Caja grande", "Caja mediana", "Caja pequeña"].includes(item.producto)) continue;

            const prod = await db.get("SELECT precio FROM productos WHERE nombre = $1 AND sede = $2", [item.producto, sede]);
            if (!prod) continue;

            const inicial = num(item.inicial);
            const producidas = num(item.producidas);
            const queda = num(item.queda);
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

            await db.run(
                `INSERT INTO inventario_diario (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [fecha, item.producto, inicial, producidas, vendidasSafe, final, total_vendido, sede]
            );
        }

        if (productos[0] && productos[0].producto === "Masas") {
            await descontarCajas(db, productos[0], fecha, sede);
        }

        const total_final = total_dia + base - transferencias - gastos + adicionales;

        await db.run(
            `INSERT INTO resumen_diario (fecha, base, adicionales, gastos, descripcion_gastos, descripcion_adicionales, transferencias, total, total_final, sede)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (fecha, sede) DO UPDATE SET base=$2, adicionales=$3, gastos=$4, descripcion_gastos=$5, descripcion_adicionales=$6, transferencias=$7, total=$8, total_final=$9`,
            [fecha, base, adicionales, gastos, descripcion_gastos || "", descripcion_adicionales || "", transferencias, total_dia, total_final, sede]
        );
        // ── DESCONTAR INSUMOS SEGÚN RECETAS ──
        const masasItem = productos.find((p) => p.producto === "Masas");
        const masasVendidas = masasItem ? num(masasItem.inicial) + num(masasItem.producidas) - num(masasItem.queda) : 0;

        if (masasVendidas > 0) {
            const recetas = await db.all(`SELECT * FROM recetas WHERE sede = $1`, [sede]);
            for (const receta of recetas) {
                const cantidadADescontar = masasVendidas / receta.masas_por_unidad;
                const anteriorInsumo = await db.get(
                    `SELECT final FROM inventario_diario WHERE producto = $1 AND sede = $2 ORDER BY id DESC LIMIT 1`,
                    [receta.insumo, sede]
                );
                const inicialInsumo = anteriorInsumo ? anteriorInsumo.final : 0;
                const finalInsumo = Math.max(0, inicialInsumo - cantidadADescontar);
                await db.run(
                    `INSERT INTO inventario_diario (fecha, producto, inicial, producidas, vendidas, final, total_vendido, sede)
             VALUES ($1, $2, $3, 0, $4, $5, 0, $6)`,
                    [fecha, receta.insumo, inicialInsumo, cantidadADescontar, finalInsumo, sede]
                );
            }
        }
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

app.get("/pedidos", async (req, res) => {
    const { sede, todos } = req.query;
    try {
        let query = `SELECT * FROM pedidos WHERE sede = $1`;
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
    const { cliente, telefono, direccion, pizzas, notas, sede } = req.body;
    if (!cliente || !direccion || !pizzas || !sede)
        return res.json({ ok: false, error: "Faltan datos obligatorios" });
    const fecha = new Date().toISOString().split("T")[0];
    try {
        const result = await db.run(
            `INSERT INTO pedidos (cliente, telefono, direccion, pizzas, notas, estado, fecha, sede)
             VALUES ($1,$2,$3,$4,$5,'pendiente',$6,$7) RETURNING id`,
            [cliente, telefono || "", direccion, JSON.stringify(pizzas), notas || "", fecha, sede]
        );
        res.json({ ok: true, id: result.lastID });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.put("/pedidos/:id", async (req, res) => {
    const { id } = req.params;
    const { cliente, telefono, direccion, pizzas, notas } = req.body;
    if (!cliente || !direccion || !pizzas)
        return res.json({ ok: false, error: "Faltan datos obligatorios" });
    try {
        await db.run(
            `UPDATE pedidos SET cliente=$1, telefono=$2, direccion=$3, pizzas=$4, notas=$5 WHERE id=$6`,
            [cliente, telefono || "", direccion, JSON.stringify(pizzas), notas || "", id]
        );
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.patch("/pedidos/:id", async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    if (!["pendiente", "entregado"].includes(estado))
        return res.json({ ok: false, error: "Estado inválido" });
    try {
        await db.run(`UPDATE pedidos SET estado=$1 WHERE id=$2`, [estado, id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/pedidos/:id", async (req, res) => {
    const { id } = req.params;
    try {
        await db.run(`DELETE FROM pedidos WHERE id=$1`, [id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.get("/precios-pizzas", (req, res) => {
    res.json({
        tradicional: { f: 11.00, m: 9.75, p: 6.00 },
        vegetariana: { f: 13.50, m: 12.00, p: 8.50 },
        tocino: { f: 12.50, m: 11.00, p: 7.50 },
        carnivora: { f: 15.00, m: 13.50, p: 8.50 },
        pollo: { f: 16.00, m: 14.50, p: 9.00 },
        petete: { f: 16.00, m: 14.50, p: 9.00 },
        cali: { f: 15.00, m: 13.50, p: 8.50 },
    });
});


// ── RECETAS ──────────────────────────────────────────
app.get("/recetas", async (req, res) => {
    const { sede } = req.query;
    try {
        const rows = await db.all(`SELECT * FROM recetas WHERE sede = $1 ORDER BY insumo ASC`, [sede]);
        res.json(rows);
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post("/recetas", async (req, res) => {
    const { insumo, cantidad, masas_por_unidad, sede } = req.body;
    try {
        await db.run(
            `INSERT INTO recetas (insumo, cantidad, masas_por_unidad, sede) VALUES ($1, $2, $3, $4)
             ON CONFLICT (insumo, sede) DO UPDATE SET cantidad=$2, masas_por_unidad=$3`,
            [insumo, cantidad, masas_por_unidad, sede]
        );
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.delete("/recetas/:id", async (req, res) => {
    const { id } = req.params;
    try {
        await db.run(`DELETE FROM recetas WHERE id = $1`, [id]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});


app.post("/login", async (req, res) => {
    const { usuario, password } = req.body;
    const user = await db.get("SELECT * FROM usuarios WHERE usuario = $1", [usuario]);
    if (!user) return res.json({ ok: false });
    const match = bcrypt.compareSync(password, user.password);
    res.json({ ok: match, usuario: user.usuario });
});

app.get("/crear-usuario", async (req, res) => {
    const { usuario, password } = req.query;
    if (!usuario || !password) return res.json({ ok: false, error: "Faltan datos" });
    const hash = bcrypt.hashSync(password, 10);
    try {
        await db.run("INSERT INTO usuarios (usuario, password) VALUES ($1, $2)", [usuario, hash]);
        res.json({ ok: true, mensaje: `Usuario ${usuario} creado` });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});


app.get("/fix-columnas", async (req, res) => {
    try {
        await db.exec(`ALTER TABLE inventario_diario 
            ALTER COLUMN inicial TYPE REAL USING inicial::REAL,
            ALTER COLUMN producidas TYPE REAL USING producidas::REAL,
            ALTER COLUMN vendidas TYPE REAL USING vendidas::REAL,
            ALTER COLUMN final TYPE REAL USING final::REAL`);
        res.json({ ok: true, mensaje: "Columnas actualizadas" });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});
// ------------------------------------------------------
// INICIAR SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;

(async () => {
    // Crear tablas si no existen
    await db.exec(`CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        cliente TEXT NOT NULL,
        telefono TEXT,
        direccion TEXT NOT NULL,
        pizzas TEXT NOT NULL,
        estado TEXT DEFAULT 'pendiente',
        notas TEXT,
        fecha TEXT,
        sede TEXT
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS ventas_pizzas (
        id SERIAL PRIMARY KEY,
        fecha TEXT,
        sede TEXT,
        tipo TEXT,
        tamaño TEXT,
        cantidad INTEGER,
        modalidad TEXT DEFAULT 'mesa'
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        nombre TEXT,
        precio REAL,
        sede TEXT,
        tipo TEXT DEFAULT 'venta',
        UNIQUE(nombre, sede)
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS resumen_diario (
        id SERIAL PRIMARY KEY,
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
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS inventario_diario (
        id SERIAL PRIMARY KEY,
        fecha TEXT,
        producto TEXT,
        inicial REAL,
        producidas REAL,
        vendidas REAL,
        final REAL,
        total_vendido REAL,
        sede TEXT
    )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        usuario TEXT UNIQUE,
        password TEXT
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS pendientes (
        id SERIAL PRIMARY KEY,
        trabajador TEXT,
        monto REAL,
        descripcion TEXT,
        fecha TEXT,
        pagado INTEGER DEFAULT 0,
        sede TEXT
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS pagos (
        id SERIAL PRIMARY KEY,
        trabajador TEXT,
        monto REAL,
        fecha TEXT,
        concepto TEXT,
        sede TEXT
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS recetas (
    id SERIAL PRIMARY KEY,
    insumo TEXT,
    cantidad REAL,
    masas_por_unidad REAL,
    sede TEXT,
    UNIQUE(insumo, sede)
)`);

    console.log("DB lista");
    app.listen(PORT, "0.0.0.0", () => console.log("Servidor corriendo en puerto " + PORT));
})();