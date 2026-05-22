import { useState, useMemo, useCallback } from "react";

// ─── ZAPIER WEBHOOK ───────────────────────────────────────────────────────────
const WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/27699599/4og973e/";

async function logSetToExcel(set) {
  try {
    const payload = {
      dato: set.date,
      oevelse: set.exercise,
      redskab: set.equipment,
      kg: set.kg,
      reps: set.reps,
      repsmaal: set.repsGoal,
      saettype: set.setType,
      orm: set.oneRepMax,
      noter: set.notes || "",
    };
    await fetch(WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return true;
  } catch (e) {
    console.error("Webhook fejl:", e);
    return false;
  }
}

// ─── 1RM BEREGNING ────────────────────────────────────────────────────────────
function calc1RM(kg, reps) {
  if (!kg || !reps || reps <= 0) return null;
  if (reps === 1) return kg;
  return Math.round(kg * (1 + reps / 30) * 10) / 10;
}

function normalizeKg(kg, equipment) {
  if (!equipment) return kg;
  return equipment.toLowerCase().includes("dumbbell") ? kg * 2 : kg;
}

// ─── HISTORISK DATA (kompakt) ─────────────────────────────────────────────────
// Format: [dato, øvelse, kg, reps, repsGoal, equipment, notes]
const SEED_DATA = [
  ["2026-05-20","Bænkpres","80","5","5","Barbell",""],
  ["2026-05-20","Bænkpres","85","3","3","Barbell","PR"],
  ["2026-05-20","Squat","100","5","5","Barbell",""],
  ["2026-05-20","Squat","110","3","3","Barbell",""],
  ["2026-05-18","Lat Pulldown","70","10","10","Machine (New)",""],
  ["2026-05-18","Lat Pulldown","75","8","8","Machine (New)",""],
  ["2026-05-18","Chest Press","60","10","8-10","Machine (New)",""],
  ["2026-05-15","Dødløft","120","5","5","Barbell",""],
  ["2026-05-15","Dødløft","130","3","3","Barbell","PR"],
  ["2026-05-15","Bent Over Row","70","8","8-10","Barbell",""],
  ["2026-05-13","Skulderpress","50","8","8-10","Dumbbell",""],
  ["2026-05-13","Lateral Raise","15","12","12-15","Dumbbell",""],
  ["2026-05-13","Bicep Curl","25","10","10-12","Dumbbell",""],
  ["2026-05-10","Bænkpres","75","8","8","Barbell",""],
  ["2026-05-10","Bænkpres","80","5","5","Barbell",""],
  ["2026-05-10","Incline Press","55","10","8-10","Dumbbell",""],
  ["2026-05-08","Squat","95","6","6","Barbell",""],
  ["2026-05-08","Leg Press","140","12","10-12","Machine (New)",""],
  ["2026-05-08","Leg Curl","50","12","10-12","Machine (New)",""],
  ["2026-05-06","Wide Grip Pulldown","65","10","10","Machine (Old)",""],
  ["2026-05-06","Wide Grip Pulldown","70","8","8-10","Machine (Old)",""],
  ["2026-05-06","Seated Row","60","10","10","Cable",""],
  ["2026-05-03","Bænkpres","77.5","6","6","Barbell",""],
  ["2026-05-01","Dødløft","125","4","4-5","Barbell",""],
  ["2026-04-28","Lat Pulldown","72.5","8","8-10","Machine (New)",""],
  ["2026-04-26","Squat","105","4","4-5","Barbell",""],
  ["2026-04-24","Skulderpress","52.5","8","8","Dumbbell",""],
  ["2026-04-22","Bænkpres","82.5","3","3","Barbell","PR"],
  ["2026-04-20","Leg Press","150","10","10","Machine (New)",""],
  ["2026-04-18","Dødløft","132.5","2","2-3","Barbell","PR"],
];

const ALL_EXERCISES = [
  "Bænkpres","Squat","Dødløft","Overhead Press","Bent Over Row",
  "Lat Pulldown","Wide Grip Pulldown","Seated Row","Chest Press",
  "Leg Press","Leg Curl","Leg Extension","Skulderpress","Lateral Raise",
  "Front Raise","Bicep Curl","Hammer Curl","Tricep Pushdown",
  "Incline Press","Cable Fly","Face Pull","Shrugs","Hip Thrust",
  "Romanian Deadlift","Bulgarian Split Squat","Assisted Pull-Up","Assisted Dips",
  "Back Extension","Calf Raise","Preacher Curl",
];

const ALL_EQUIPMENT = [
  "Barbell","Dumbbell","Machine (New)","Machine (Old)","Cable",
  "Kettlebell","Smith Machine","Bodyweight","Resistance Band",
];

const SET_TYPES = ["Working","Warm-up","Drop Set","AMRAP","Failure"];
const REP_RANGES = ["1-3","3-5","4-5","5","5-8","6-8","8-10","8-12","10-12","10-15","12-15","15-20","20-30"];

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app: {
    minHeight:"100vh", background:"#0d0d10", color:"#e4e4dc",
    fontFamily:"'DM Mono', monospace", maxWidth:480, margin:"0 auto",
    paddingBottom:80,
  },
  header: {
    padding:"16px 16px 0", borderBottom:"1px solid #1a1a1e",
    background:"#0d0d10", position:"sticky", top:0, zIndex:10,
  },
  title: {
    fontSize:11, letterSpacing:"0.2em", color:"#b8e840", fontWeight:600,
    textTransform:"uppercase", marginBottom:12,
  },
  nav: {
    display:"flex", gap:0, overflowX:"auto",
  },
  navBtn: (active) => ({
    flex:"none", padding:"8px 14px", fontSize:10, letterSpacing:"0.15em",
    fontFamily:"'DM Mono', monospace", border:"none", borderRadius:0,
    background:"none", cursor:"pointer", fontWeight:600,
    color: active ? "#b8e840" : "#444",
    borderBottom: active ? "2px solid #b8e840" : "2px solid transparent",
    transition:"all 0.15s",
  }),
  page: { padding:"16px" },
  card: {
    background:"#111114", border:"1px solid #1c1c20", borderRadius:10,
    padding:14, marginBottom:10,
  },
  label: {
    fontSize:9, letterSpacing:"0.15em", color:"#555", textTransform:"uppercase",
    display:"block", marginBottom:4,
  },
  input: {
    width:"100%", background:"#0d0d10", border:"1px solid #252528",
    borderRadius:6, padding:"8px 10px", color:"#e4e4dc",
    fontFamily:"'DM Mono', monospace", fontSize:13, boxSizing:"border-box",
    outline:"none",
  },
  select: {
    width:"100%", background:"#0d0d10", border:"1px solid #252528",
    borderRadius:6, padding:"8px 10px", color:"#e4e4dc",
    fontFamily:"'DM Mono', monospace", fontSize:13, boxSizing:"border-box",
  },
  btn: {
    background:"#b8e840", color:"#0d0d10", border:"none", borderRadius:6,
    padding:"10px 16px", fontSize:11, letterSpacing:"0.1em", fontWeight:700,
    cursor:"pointer", fontFamily:"'DM Mono', monospace",
  },
  btnGhost: {
    background:"none", color:"#666", border:"1px solid #252528", borderRadius:6,
    padding:"8px 12px", fontSize:10, letterSpacing:"0.1em",
    cursor:"pointer", fontFamily:"'DM Mono', monospace",
  },
  grid2: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 },
  tag: {
    display:"inline-block", fontSize:9, padding:"3px 7px",
    background:"#1c1c20", borderRadius:4, color:"#888",
    letterSpacing:"0.08em",
  },
  tagGreen: {
    display:"inline-block", fontSize:9, padding:"3px 7px",
    background:"#1a2a00", borderRadius:4, color:"#b8e840",
    letterSpacing:"0.08em",
  },
  orm: {
    background:"#0c1800", border:"1px solid #1a2e00", borderRadius:8,
    padding:"10px 12px", marginTop:8,
  },
  ormTitle: { fontSize:9, color:"#4a6a00", letterSpacing:"0.12em", marginBottom:6 },
  ormRow: { display:"flex", justifyContent:"space-between", marginBottom:3 },
  ormLabel: { fontSize:10, color:"#555" },
  ormValue: { fontSize:11, color:"#b8e840", fontWeight:600 },
  section: { marginBottom:16 },
  sectionTitle: {
    fontSize:9, letterSpacing:"0.2em", color:"#444", textTransform:"uppercase",
    marginBottom:8, borderBottom:"1px solid #1a1a1e", paddingBottom:6,
  },
  toast: {
    position:"fixed", bottom:90, left:"50%", transform:"translateX(-50%)",
    background:"#b8e840", color:"#0d0d10", padding:"10px 20px",
    borderRadius:8, fontSize:11, fontWeight:700, letterSpacing:"0.1em",
    zIndex:50, whiteSpace:"nowrap",
  },
  toastErr: {
    position:"fixed", bottom:90, left:"50%", transform:"translateX(-50%)",
    background:"#3d0000", color:"#ff6b6b", padding:"10px 20px", border:"1px solid #600",
    borderRadius:8, fontSize:11, fontWeight:700, letterSpacing:"0.1em",
    zIndex:50, whiteSpace:"nowrap",
  },
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("log");
  const [localData, setLocalData] = useState([]);
  const [toast, setToast] = useState(null); // { msg, ok }

  // LOG state
  const today = new Date().toISOString().slice(0, 10);
  const [entry, setEntry] = useState({
    date: today, exercise: "", equipment: "", kg: "", reps: "",
    repsGoal: "8-10", setType: "Working", notes: "",
  });
  const [saving, setSaving] = useState(false);

  // ØVELSER state
  const [exSearch, setExSearch] = useState("");
  const [expandedEx, setExpandedEx] = useState(null);
  const [customExercises, setCustomExercises] = useState([]);
  const [showAddEx, setShowAddEx] = useState(false);
  const [newExName, setNewExName] = useState("");

  // REDSKABER state
  const [eqSearch, setEqSearch] = useState("");
  const [expandedEq, setExpandedEq] = useState(null);

  // HISTORIK state
  const [histEx, setHistEx] = useState("");
  const [histEq, setHistEq] = useState("");

  // STATS state
  const [statsEx, setStatsEx] = useState("");

  // ── Alle records ──
  const allData = useMemo(() => SEED_DATA.map(r => ({
    date: r[0], exercise: r[1], kg: parseFloat(r[2]) || null,
    reps: parseInt(r[3]) || null, repsGoal: r[4], equipment: r[5],
    notes: r[6],
    oneRepMax: calc1RM(parseFloat(r[2]), parseInt(r[3])),
  })), []);

  const allRecords = useMemo(() => [...allData, ...localData]
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [allData, localData]);

  // ── best1RM map ──
  const best1RMMap = useMemo(() => {
    const map = {};
    for (const r of allRecords) {
      if (!r.exercise || !r.equipment || !r.oneRepMax) continue;
      const key = `${r.exercise}||${r.equipment}`;
      if (!map[key] || r.oneRepMax > map[key]) map[key] = r.oneRepMax;
    }
    return map;
  }, [allRecords]);

  // ── Exercise lists ──
  const allExercises = useMemo(() => {
    const fromData = [...new Set(allRecords.map(r => r.exercise).filter(Boolean))];
    const merged = [...new Set([...ALL_EXERCISES, ...fromData, ...customExercises])];
    return merged.sort();
  }, [allRecords, customExercises]);

  const allEquipment = useMemo(() => {
    const fromData = [...new Set(allRecords.map(r => r.equipment).filter(Boolean))];
    return [...new Set([...ALL_EQUIPMENT, ...fromData])].sort();
  }, [allRecords]);

  const equipForExercise = useMemo(() => {
    if (!entry.exercise) return allEquipment;
    const used = [...new Set(allRecords
      .filter(r => r.exercise === entry.exercise)
      .map(r => r.equipment).filter(Boolean))];
    return used.length ? used : allEquipment;
  }, [entry.exercise, allRecords, allEquipment]);

  // ── Live 1RM estimate ──
  const liveOrm = useMemo(() => {
    const kg = parseFloat(entry.kg);
    const reps = parseInt(entry.reps);
    return calc1RM(kg, reps);
  }, [entry.kg, entry.reps]);

  const bestOrmForEntry = useMemo(() => {
    if (!entry.exercise || !entry.equipment) return null;
    return best1RMMap[`${entry.exercise}||${entry.equipment}`] || null;
  }, [entry.exercise, entry.equipment, best1RMMap]);

  // ── Show toast ──
  function showToast(msg, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  // ── Save set ──
  const handleSave = useCallback(async () => {
    if (!entry.exercise || !entry.kg || !entry.reps) {
      showToast("Udfyld øvelse, kg og reps", false); return;
    }
    setSaving(true);
    const newRecord = {
      ...entry,
      kg: parseFloat(entry.kg),
      reps: parseInt(entry.reps),
      oneRepMax: calc1RM(parseFloat(entry.kg), parseInt(entry.reps)),
    };
    const ok = await logSetToExcel(newRecord);
    setLocalData(prev => [...prev, newRecord]);
    setEntry(p => ({ ...p, kg: "", reps: "", notes: "" }));
    setSaving(false);
    showToast(ok ? "Sæt gemt i Excel ✓" : "Gemt lokalt (webhook fejl)", ok);
  }, [entry]);

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Bebas+Neue&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={S.header}>
        <div style={S.title}>⚡ STYRKE TRACKER</div>
        <div style={S.nav}>
          {[["log","LOG"],["exercises","ØVELSER"],["equipment","REDSKABER"],["history","HISTORIK"],["stats","STATS"]].map(([k,l]) => (
            <button key={k} style={S.navBtn(view===k)} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
      </div>

      {/* ── LOG ── */}
      {view === "log" && (
        <div style={S.page}>
          <div style={S.card}>
            <div style={S.sectionTitle}>NYT SÆT</div>

            <div style={{ marginBottom:10 }}>
              <label style={S.label}>Dato</label>
              <input type="date" style={S.input} value={entry.date}
                onChange={e => setEntry(p => ({...p, date: e.target.value}))} />
            </div>

            <div style={{ marginBottom:10 }}>
              <label style={S.label}>Øvelse</label>
              <select style={S.select} value={entry.exercise}
                onChange={e => setEntry(p => ({...p, exercise: e.target.value, equipment:""}))}>
                <option value="">— vælg øvelse —</option>
                {allExercises.map(ex => <option key={ex}>{ex}</option>)}
              </select>
            </div>

            <div style={{ marginBottom:10 }}>
              <label style={S.label}>Redskab</label>
              <select style={S.select} value={entry.equipment}
                onChange={e => setEntry(p => ({...p, equipment: e.target.value}))}>
                <option value="">— vælg redskab —</option>
                {equipForExercise.map(eq => <option key={eq}>{eq}</option>)}
              </select>
            </div>

            {/* 1RM guide */}
            {bestOrmForEntry && (
              <div style={S.orm}>
                <div style={S.ormTitle}>BEDSTE 1RM — {entry.exercise} / {entry.equipment}</div>
                {[[40,"Opvarm"],[60,"Let"],[80,"Arbejds"]].map(([pct, label]) => (
                  <div key={pct} style={S.ormRow}>
                    <span style={S.ormLabel}>{pct}% — {label}</span>
                    <span style={S.ormValue}>{Math.round(bestOrmForEntry * pct / 100 * 2) / 2} kg</span>
                  </div>
                ))}
                <div style={{...S.ormRow, marginTop:6, borderTop:"1px solid #1a2e00", paddingTop:6}}>
                  <span style={S.ormLabel}>Bedste 1RM</span>
                  <span style={{...S.ormValue, fontSize:13}}>{bestOrmForEntry} kg</span>
                </div>
              </div>
            )}

            <div style={{...S.grid2, margin:"10px 0"}}>
              <div>
                <label style={S.label}>Kg</label>
                <input type="number" style={S.input} placeholder="0" value={entry.kg}
                  onChange={e => setEntry(p => ({...p, kg: e.target.value}))} />
              </div>
              <div>
                <label style={S.label}>Reps</label>
                <input type="number" style={S.input} placeholder="0" value={entry.reps}
                  onChange={e => setEntry(p => ({...p, reps: e.target.value}))} />
              </div>
            </div>

            {/* Live 1RM */}
            {liveOrm && (
              <div style={{ fontSize:10, color:"#b8e840", textAlign:"right", marginBottom:8, letterSpacing:"0.08em" }}>
                Est. 1RM: <strong>{liveOrm} kg</strong>
              </div>
            )}

            <div style={{...S.grid2, marginBottom:10}}>
              <div>
                <label style={S.label}>Rep Range</label>
                <select style={S.select} value={entry.repsGoal}
                  onChange={e => setEntry(p => ({...p, repsGoal: e.target.value}))}>
                  {REP_RANGES.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>Sæt Type</label>
                <select style={S.select} value={entry.setType}
                  onChange={e => setEntry(p => ({...p, setType: e.target.value}))}>
                  {SET_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginBottom:12 }}>
              <label style={S.label}>Noter</label>
              <input type="text" style={S.input} placeholder="Valgfrit..." value={entry.notes}
                onChange={e => setEntry(p => ({...p, notes: e.target.value}))} />
            </div>

            <button style={{...S.btn, width:"100%", opacity: saving ? 0.6 : 1}}
              onClick={handleSave} disabled={saving}>
              {saving ? "GEMMER..." : "GEM SÆT → GOOGLE SHEETS"}
            </button>

            <div style={{ fontSize:9, color:"#333", textAlign:"center", marginTop:6, letterSpacing:"0.08em" }}>
              Zapier → Træningslog / Google Sheets
            </div>
          </div>

          {/* Seneste sæt */}
          {localData.length > 0 && (
            <div style={S.card}>
              <div style={S.sectionTitle}>DENNE SESSION</div>
              {[...localData].reverse().map((r, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #161618" }}>
                  <div>
                    <div style={{ fontSize:12, color:"#e4e4dc" }}>{r.exercise}</div>
                    <div style={{ fontSize:10, color:"#555" }}>{r.equipment} · {r.date}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:13, color:"#b8e840", fontWeight:600 }}>{r.kg} kg × {r.reps}</div>
                    {r.oneRepMax && <div style={{ fontSize:9, color:"#444" }}>1RM ~{r.oneRepMax}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ØVELSER ── */}
      {view === "exercises" && (
        <div style={S.page}>
          <div style={{ display:"flex", gap:8, marginBottom:12 }}>
            <input style={{...S.input, flex:1}} placeholder="Søg øvelse..." value={exSearch}
              onChange={e => setExSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => setShowAddEx(!showAddEx)}>+</button>
          </div>
          {showAddEx && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>Ny øvelse</label>
              <div style={{ display:"flex", gap:8 }}>
                <input style={{...S.input, flex:1}} value={newExName}
                  onChange={e => setNewExName(e.target.value)} placeholder="Navn..." />
                <button style={S.btn} onClick={() => {
                  if (newExName.trim()) { setCustomExercises(p => [...p, newExName.trim()]); setNewExName(""); setShowAddEx(false); }
                }}>Tilføj</button>
              </div>
            </div>
          )}
          {allExercises
            .filter(ex => ex.toLowerCase().includes(exSearch.toLowerCase()))
            .map(ex => {
              const key = expandedEx === ex;
              const eqList = [...new Set(allRecords.filter(r => r.exercise === ex).map(r => r.equipment).filter(Boolean))];
              const bestOrm = eqList.reduce((best, eq) => {
                const v = best1RMMap[`${ex}||${eq}`];
                return v && (!best || v > best) ? v : best;
              }, null);
              return (
                <div key={ex} style={S.card}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer" }}
                    onClick={() => setExpandedEx(key ? null : ex)}>
                    <div>
                      <div style={{ fontSize:13 }}>{ex}</div>
                      {eqList.length > 0 && <div style={{ fontSize:10, color:"#444", marginTop:2 }}>{eqList.length} redskaber</div>}
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {bestOrm && <span style={S.tagGreen}>{bestOrm} kg 1RM</span>}
                      <span style={{ color:"#333", fontSize:12 }}>{key ? "▲" : "▼"}</span>
                    </div>
                  </div>
                  {key && (
                    <div style={{ marginTop:12, borderTop:"1px solid #1a1a1e", paddingTop:12 }}>
                      {/* Rep range dropdown */}
                      <div style={{ marginBottom:10 }}>
                        <label style={S.label}>Rep Range</label>
                        <select style={S.select}>
                          {REP_RANGES.map(r => <option key={r}>{r}</option>)}
                        </select>
                      </div>
                      {/* Redskaber med 1RM */}
                      {eqList.length > 0 && (
                        <div style={{ marginBottom:10 }}>
                          <div style={S.label}>Redskaber</div>
                          {eqList.map(eq => {
                            const orm = best1RMMap[`${ex}||${eq}`];
                            return (
                              <div key={eq} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid #161618" }}>
                                <button style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#b8e840", fontSize:11, fontFamily:"'DM Mono', monospace", letterSpacing:"0.05em" }}
                                  onClick={() => { setExpandedEq(eq); setView("equipment"); }}>
                                  {eq} ↗
                                </button>
                                {orm && <span style={{ fontSize:11, color:"#555" }}>{orm} kg 1RM</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Knapper */}
                      <div style={{ display:"flex", gap:8 }}>
                        <button style={{...S.btn, flex:1, fontSize:10}}
                          onClick={() => { setEntry(p => ({...p, exercise: ex})); setView("log"); setExpandedEx(null); }}>
                          Log sæt →
                        </button>
                        <button style={{...S.btnGhost, fontSize:10}}
                          onClick={() => { setStatsEx(ex); setView("stats"); setExpandedEx(null); }}>
                          Se progression →
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {/* ── REDSKABER ── */}
      {view === "equipment" && (
        <div style={S.page}>
          <input style={{...S.input, marginBottom:12}} placeholder="Søg redskab..." value={eqSearch}
            onChange={e => setEqSearch(e.target.value)} />
          {allEquipment
            .filter(eq => eq.toLowerCase().includes(eqSearch.toLowerCase()))
            .map(eq => {
              const key = expandedEq === eq;
              const exercises = [...new Set(allRecords.filter(r => r.equipment === eq).map(r => r.exercise).filter(Boolean))];
              const totalSets = allRecords.filter(r => r.equipment === eq).length;
              return (
                <div key={eq} style={S.card}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer" }}
                    onClick={() => setExpandedEq(key ? null : eq)}>
                    <div>
                      <div style={{ fontSize:13 }}>{eq}</div>
                      {totalSets > 0 && <div style={{ fontSize:10, color:"#444", marginTop:2 }}>{totalSets} sæt · {exercises.length} øvelser</div>}
                    </div>
                    <span style={{ color:"#333", fontSize:12 }}>{key ? "▲" : "▼"}</span>
                  </div>
                  {key && (
                    <div style={{ marginTop:12, borderTop:"1px solid #1a1a1e", paddingTop:12 }}>
                      {exercises.length > 0 && (
                        <div style={{ marginBottom:10 }}>
                          <div style={S.label}>Øvelser du har lavet</div>
                          {exercises.map(ex => {
                            const orm = best1RMMap[`${ex}||${eq}`];
                            return (
                              <div key={ex} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid #161618" }}>
                                <button style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#ccc", fontSize:11, fontFamily:"'DM Mono', monospace" }}
                                  onClick={() => { setExpandedEx(ex); setView("exercises"); setExpandedEq(null); }}>
                                  {ex}
                                </button>
                                {orm && <span style={{ fontSize:11, color:"#555" }}>{orm} kg 1RM</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <button style={{...S.btn, width:"100%", fontSize:10}}
                        onClick={() => { setEntry(p => ({...p, equipment: eq})); setView("log"); setExpandedEq(null); }}>
                        Log sæt med {eq} →
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {/* ── HISTORIK ── */}
      {view === "history" && (
        <div style={S.page}>
          <div style={{...S.grid2, marginBottom:12}}>
            <select style={S.select} value={histEx} onChange={e => setHistEx(e.target.value)}>
              <option value="">Alle øvelser</option>
              {allExercises.map(ex => <option key={ex}>{ex}</option>)}
            </select>
            <select style={S.select} value={histEq} onChange={e => setHistEq(e.target.value)}>
              <option value="">Alle redskaber</option>
              {allEquipment.map(eq => <option key={eq}>{eq}</option>)}
            </select>
          </div>
          {allRecords
            .filter(r => (!histEx || r.exercise === histEx) && (!histEq || r.equipment === histEq))
            .slice(0, 100)
            .map((r, i) => {
              const isPR = r.oneRepMax && best1RMMap[`${r.exercise}||${r.equipment}`] === r.oneRepMax;
              return (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid #161618" }}>
                  <div>
                    <div style={{ fontSize:12, color:"#e4e4dc" }}>{r.exercise}
                      {isPR && <span style={{...S.tagGreen, marginLeft:6}}>PR</span>}
                    </div>
                    <div style={{ fontSize:10, color:"#444", marginTop:1 }}>{r.equipment} · {r.date}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:13, color:"#b8e840", fontWeight:600 }}>{r.kg} kg × {r.reps}</div>
                    {r.oneRepMax && <div style={{ fontSize:9, color:"#444" }}>1RM ~{r.oneRepMax}</div>}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* ── STATS ── */}
      {view === "stats" && (
        <div style={S.page}>
          <div style={{ marginBottom:12 }}>
            <label style={S.label}>Øvelse</label>
            <select style={S.select} value={statsEx} onChange={e => setStatsEx(e.target.value)}>
              <option value="">— vælg øvelse —</option>
              {allExercises.map(ex => <option key={ex}>{ex}</option>)}
            </select>
          </div>
          {statsEx && <StatsView exercise={statsEx} allRecords={allRecords} best1RMMap={best1RMMap} />}
        </div>
      )}

      {/* Toast */}
      {toast && <div style={toast.ok ? S.toast : S.toastErr}>{toast.msg}</div>}
    </div>
  );
}

// ─── STATS VIEW ───────────────────────────────────────────────────────────────
function StatsView({ exercise, allRecords, best1RMMap }) {
  const records = allRecords.filter(r => r.exercise === exercise && r.oneRepMax);
  const equipment = [...new Set(records.map(r => r.equipment).filter(Boolean))];

  if (!records.length) return (
    <div style={{ color:"#444", fontSize:12, textAlign:"center", marginTop:40 }}>
      Ingen data for {exercise}
    </div>
  );

  return (
    <div>
      {equipment.map(eq => {
        const recs = records.filter(r => r.equipment === eq).slice(0, 20).reverse();
        const best = best1RMMap[`${exercise}||${eq}`];
        return (
          <div key={eq} style={{ marginBottom:20 }}>
            <div style={{ fontSize:11, color:"#b8e840", letterSpacing:"0.1em", marginBottom:8 }}>{eq}</div>
            {best && (
              <div style={{ background:"#0c1800", border:"1px solid #1a2e00", borderRadius:8, padding:"10px 12px", marginBottom:10 }}>
                <div style={{ fontSize:9, color:"#4a6a00", letterSpacing:"0.12em", marginBottom:6 }}>BEDSTE 1RM: {best} kg</div>
                {[[40,"Opvarm"],[60,"Let"],[80,"Arbejds"]].map(([pct, label]) => (
                  <div key={pct} style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                    <span style={{ fontSize:10, color:"#555" }}>{pct}% — {label}</span>
                    <span style={{ fontSize:11, color:"#b8e840", fontWeight:600 }}>{Math.round(best * pct / 100 * 2) / 2} kg</span>
                  </div>
                ))}
              </div>
            )}
            {/* Simpel progressionskurve */}
            <ProgressChart records={recs} />
            {/* Seneste sæt */}
            <div style={{ marginTop:8 }}>
              {[...recs].reverse().slice(0, 5).map((r, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"4px 0", borderBottom:"1px solid #161618" }}>
                  <span style={{ fontSize:10, color:"#555" }}>{r.date}</span>
                  <span style={{ fontSize:11, color:"#ccc" }}>{r.kg} kg × {r.reps} → <span style={{ color:"#b8e840" }}>{r.oneRepMax} 1RM</span></span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProgressChart({ records }) {
  if (records.length < 2) return null;
  const W = 340, H = 80, PAD = 8;
  const orms = records.map(r => r.oneRepMax);
  const minV = Math.min(...orms), maxV = Math.max(...orms);
  const range = maxV - minV || 1;
  const pts = records.map((r, i) => ({
    x: PAD + (i / (records.length - 1)) * (W - PAD * 2),
    y: H - PAD - ((r.oneRepMax - minV) / range) * (H - PAD * 2),
    date: r.date,
  }));
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  return (
    <svg width={W} height={H} style={{ display:"block", overflow:"visible" }}>
      <polyline points={pts.map(p => `${p.x},${p.y}`).join(" ")}
        fill="none" stroke="#1a3000" strokeWidth={8} />
      <path d={path} fill="none" stroke="#b8e840" strokeWidth={1.5} />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === pts.length - 1 ? 3 : 2}
          fill={i === pts.length - 1 ? "#b8e840" : "#555"} />
      ))}
      <text x={pts[0].x} y={H - 2} textAnchor="middle" fill="#333" fontSize={7} fontFamily="DM Mono, monospace">{pts[0].date?.slice(5)}</text>
      <text x={pts[pts.length-1].x} y={H - 2} textAnchor="middle" fill="#333" fontSize={7} fontFamily="DM Mono, monospace">{pts[pts.length-1].date?.slice(5)}</text>
    </svg>
  );
}
