import { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

const API_URL = "https://api.anthropic.com/v1/messages";

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Error leyendo archivo"));
    r.readAsDataURL(file);
  });
}

function readInventory(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        let headerIdx = -1;
        for (let i = 0; i < Math.min(raw.length, 10); i++) {
          if (
            raw[i].some((c) => String(c).toLowerCase().includes("nombre")) &&
            raw[i].some((c) =>
              String(c).toLowerCase().includes("codigo") ||
              String(c).toLowerCase().includes("código")
            )
          ) {
            headerIdx = i;
            break;
          }
        }
        if (headerIdx === -1) {
          rej(new Error("No se encontró encabezado en el inventario"));
          return;
        }
        const headers = raw[headerIdx].map((h) => String(h).trim().toLowerCase());
        const nameIdx = headers.findIndex((h) => h.includes("nombre"));
        const codeIdx = headers.findIndex(
          (h) => h.includes("codigo") || h.includes("código")
        );
        const items = [];
        for (let i = headerIdx + 1; i < raw.length; i++) {
          const nombre = String(raw[i][nameIdx] || "").trim();
          const codigo = String(raw[i][codeIdx] || "").trim();
          if (nombre && codigo) items.push({ nombre: nombre.toUpperCase(), codigo });
        }
        res(items);
      } catch (err) {
        rej(err);
      }
    };
    r.onerror = () => rej(new Error("Error leyendo inventario"));
    r.readAsArrayBuffer(file);
  });
}

function fuzzyMatch(invItems, query) {
  const q = query
    .toUpperCase()
    .replace(/[.\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  let best = null,
    bestScore = 0;
  for (const item of invItems) {
    const name = item.nombre;
    let score = 0;
    for (const word of q) if (name.includes(word)) score++;
    const ratio = q.length ? score / q.length : 0;
    if (ratio > bestScore) {
      bestScore = ratio;
      best = item;
    }
  }
  return bestScore >= 0.5 ? { ...best, score: bestScore } : null;
}

function exportXLSX(rows, tasa) {
  const wsData = [
    ["Nombre dentro del Sistema", "Código Interno", "Cantidad", `Valor Unit. (USD @ ${tasa})`, "Total USD"],
  ];
  for (const r of rows) {
    wsData.push([
      r.nombre_sistema || "NO ENCONTRADO",
      r.codigo || "",
      r.cantidad,
      r.valor_usd != null ? r.valor_usd : "",
      r.cantidad && r.valor_usd != null ? +(r.cantidad * r.valor_usd).toFixed(4) : "",
    ]);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = [{ wch: 50 }, { wch: 18 }, { wch: 10 }, { wch: 20 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws, "Cruce Factura");
  XLSX.writeFile(wb, "cruce_factura.xlsx");
}

function DropZone({ label, accept, onFile, file, icon }) {
  const ref = useRef();
  const [drag, setDrag] = useState(false);
  const handle = (f) => { if (f) onFile(f); };
  return (
    <div
      onClick={() => ref.current.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
      style={{
        cursor: "pointer", borderRadius: 12,
        border: `2px dashed ${drag ? "#3b82f6" : file ? "#22c55e" : "#d1d5db"}`,
        padding: 24, display: "flex", flexDirection: "column",
        alignItems: "center", gap: 8,
        background: drag ? "#eff6ff" : file ? "#f0fdf4" : "#f9fafb",
        transition: "all 0.2s",
      }}
    >
      <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={(e) => handle(e.target.files[0])} />
      <span style={{ fontSize: 32 }}>{file ? "✅" : icon}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#374151", textAlign: "center" }}>
        {file ? file.name : label}
      </span>
      {file && <span style={{ fontSize: 11, color: "#16a34a" }}>Clic para cambiar</span>}
    </div>
  );
}

function StatusBadge({ status }) {
  const cfg = {
    found:    { bg: "#dcfce7", text: "#166534", label: "✓ Encontrado" },
    verify:   { bg: "#fef9c3", text: "#854d0e", label: "⚠ Verificar" },
    notfound: { bg: "#fee2e2", text: "#991b1b", label: "✗ No encontrado" },
  };
  const c = cfg[status] || cfg.notfound;
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: c.bg, color: c.text }}>
      {c.label}
    </span>
  );
}

export default function App() {
  const [pdfFile,  setPdfFile]  = useState(null);
  const [xlsxFile, setXlsxFile] = useState(null);
  const [tasa,     setTasa]     = useState("");
  const [loading,  setLoading]  = useState(false);
  const [progress, setProgress] = useState("");
  const [results,  setResults]  = useState(null);
  const [error,    setError]    = useState("");

  const canRun = pdfFile && xlsxFile && tasa && Number(tasa) > 0 && !loading;

  const run = useCallback(async () => {
    setLoading(true); setError(""); setResults(null);
    try {
      const tasaNum = parseFloat(tasa);
      setProgress("📋 Leyendo inventario...");
      const inventory = await readInventory(xlsxFile);

      setProgress("🤖 Extrayendo ítems de la factura con IA...");
      const pdfB64 = await fileToBase64(pdfFile);
      const prompt = `Analiza esta factura y extrae TODOS los ítems.
Devuelve ÚNICAMENTE un JSON válido (sin markdown, sin texto extra) con este formato:
{"items":[{"descripcion":"nombre completo del producto","cantidad":número,"valor_unitario":número en pesos}]}`;

      const resp = await fetch(API_URL, {
        method: "POST",
       headers: {
  "Content-Type": "application/json",
  "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
},
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          messages: [{
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });
      if (!resp.ok) throw new Error(`Error API: ${resp.status}`);
      const apiData = await resp.json();
      const rawText = apiData.content.map((b) => b.text || "").join("").trim();
      const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
      const invoiceItems = parsed.items || [];

      setProgress("🔍 Cruzando con inventario...");
      const rows = invoiceItems.map((inv) => {
        const match = fuzzyMatch(inventory, inv.descripcion);
        const vr_usd = inv.valor_unitario ? +(inv.valor_unitario / tasaNum).toFixed(4) : null;
        let status = "notfound";
        if (match) status = match.score >= 0.75 ? "found" : "verify";
        return {
          desc_factura: inv.descripcion, cantidad: inv.cantidad,
          valor_cop: inv.valor_unitario, valor_usd: vr_usd,
          nombre_sistema: match ? match.nombre : null,
          codigo: match ? match.codigo : null,
          status,
        };
      });

      setResults({ rows, tasa: tasaNum, total: rows.length });
      setProgress("");
    } catch (e) {
      setError(e.message || "Error desconocido");
    }
    setLoading(false);
  }, [pdfFile, xlsxFile, tasa]);

  const found    = results?.rows.filter((r) => r.status === "found").length    || 0;
  const verify   = results?.rows.filter((r) => r.status === "verify").length   || 0;
  const notfound = results?.rows.filter((r) => r.status === "notfound").length || 0;

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #0f172a, #1e3a5f)", padding: "32px 16px", fontFamily: "Arial, sans-serif" }}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <h1 style={{ color: "#fff", fontSize: 32, fontWeight: 800, margin: 0 }}>🏗️ Yeikel's App</h1>
          <p style={{ color: "#93c5fd", margin: "6px 0 0" }}>Cruce de Facturas — Automatización de inventario</p>
        </div>

        {/* Config */}
        <div style={{ background: "#fff", borderRadius: 20, padding: 28, boxShadow: "0 8px 32px rgba(0,0,0,0.2)", marginBottom: 24 }}>
          <h2 style={{ margin: "0 0 16px", fontSize: 17, fontWeight: 700, borderBottom: "1px solid #e5e7eb", paddingBottom: 10 }}>⚙️ Configuración</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
            <DropZone label="Arrastra o clic — Factura PDF" accept=".pdf" icon="📄" file={pdfFile} onFile={setPdfFile} />
            <DropZone label="Arrastra o clic — Inventario Excel (.xlsx)" accept=".xlsx,.xls" icon="📊" file={xlsxFile} onFile={setXlsxFile} />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <label style={{ fontSize: 13, fontWeight: 700, color: "#374151", whiteSpace: "nowrap" }}>💱 Tasa COP → USD</label>
            <input
              type="number" value={tasa} onChange={(e) => setTasa(e.target.value)}
              placeholder="Ej: 4200"
              style={{ border: "1.5px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14, width: 140, outline: "none" }}
            />
            {tasa && Number(tasa) > 0 && (
              <span style={{ fontSize: 12, color: "#6b7280" }}>$1 USD = ${Number(tasa).toLocaleString("es-CO")} COP</span>
            )}
          </div>

          <button
            onClick={run} disabled={!canRun}
            style={{
              width: "100%", padding: "14px 0", borderRadius: 12, border: "none",
              fontWeight: 800, fontSize: 15, cursor: canRun ? "pointer" : "not-allowed",
              background: canRun ? "#2563eb" : "#d1d5db", color: "#fff",
              transition: "all 0.2s", boxShadow: canRun ? "0 4px 12px rgba(37,99,235,0.4)" : "none",
            }}
          >
            {loading ? "⏳ Procesando..." : "🚀 Procesar Factura"}
          </button>

          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#eff6ff", borderRadius: 10, padding: 12, marginTop: 12 }}>
              <div style={{ width: 18, height: 18, border: "2.5px solid #3b82f6", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <span style={{ fontSize: 13, color: "#1d4ed8", fontWeight: 600 }}>{progress}</span>
            </div>
          )}

          {error && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 10, padding: 12, marginTop: 12, fontSize: 13 }}>
              ❌ {error}
            </div>
          )}
        </div>

        {/* Results */}
        {results && (
          <div style={{ background: "#fff", borderRadius: 20, padding: 28, boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: "1px solid #e5e7eb", paddingBottom: 14, marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>📋 Resultados ({results.total} ítems)</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span style={{ padding: "4px 12px", background: "#dcfce7", color: "#166534", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>✓ {found} encontrados</span>
                <span style={{ padding: "4px 12px", background: "#fef9c3", color: "#854d0e", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>⚠ {verify} verificar</span>
                <span style={{ padding: "4px 12px", background: "#fee2e2", color: "#991b1b", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>✗ {notfound} no encontrados</span>
              </div>
              <button
                onClick={() => exportXLSX(results.rows, results.tasa)}
                style={{ padding: "8px 16px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >
                ⬇️ Descargar Excel
              </button>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#1e293b", color: "#fff" }}>
                    {["#", "Descripción Factura", "Nombre en Sistema", "Código", "Cant.", "COP", "USD", "Estado"].map((h) => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontWeight: 700, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                      <td style={{ padding: "7px 10px", color: "#9ca3af", fontFamily: "monospace" }}>{i + 1}</td>
                      <td style={{ padding: "7px 10px", color: "#374151", maxWidth: 220 }}>{r.desc_factura}</td>
                      <td style={{ padding: "7px 10px", fontWeight: 600, color: r.nombre_sistema ? "#111827" : "#dc2626", fontStyle: r.nombre_sistema ? "normal" : "italic", maxWidth: 220 }}>
                        {r.nombre_sistema || "NO ENCONTRADO"}
                      </td>
                      <td style={{ padding: "7px 10px", fontFamily: "monospace", color: "#1d4ed8" }}>{r.codigo || "—"}</td>
                      <td style={{ padding: "7px 10px", textAlign: "center" }}>{r.cantidad}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{r.valor_cop?.toLocaleString("es-CO") || "—"}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 700, color: "#16a34a" }}>
                        {r.valor_usd != null ? `$${r.valor_usd.toFixed(2)}` : "—"}
                      </td>
                      <td style={{ padding: "7px 10px" }}><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ textAlign: "center", fontSize: 11, color: "#9ca3af", marginTop: 12 }}>
              Tasa usada: 1 USD = ${results.tasa.toLocaleString("es-CO")} COP
            </p>
          </div>
        )}

        <p style={{ textAlign: "center", color: "#60a5fa", fontSize: 11, marginTop: 20 }}>
          Yeikel's App © 2026 — Powered by Claude AI
        </p>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
