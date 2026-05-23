import { useState, useMemo, useCallback, useEffect } from "react";

// ─── GOOGLE APPS SCRIPT ENDPOINT ──────────────────────────────────────────────
// Apps Script deployed som Web App. Læser og skriver alle data via dette ene endpoint.
// Sæt URL'en ind her efter du har deployet scriptet (se SHEETS_WRITE_SETUP.md).
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxCPqkI5Bu9_20FdZ6TIC4viM7d5ylE69t0PLEJefK4s_udLBO39vWr6C24RkqtaJGW/exec";

// Fallback til CSV-eksport hvis Apps Script-læsning ikke er konfigureret/fejler.
// Kræver at sheet er delt som "Anyone with the link can view".
const SHEET_ID = "1wg53KV9hdsFq46nhDm8kMmx1iZ1NDye5phKYxN6fIjg";
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

function isAppsScriptConfigured() {
  return APPS_SCRIPT_URL && !APPS_SCRIPT_URL.startsWith("REPLACE_");
}

// Simpel CSV parser (håndterer quoted values + kommaer i felter)
function parseCSV(text) {
  // Strip UTF-8 BOM hvis til stede (Google Sheets eksporterer ofte med det)
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => (c || "").trim() !== ""));
}

// CSV-fallback til at læse sæt (bruges kun hvis Apps Script ikke er sat op)
async function fetchSetsFromCSV() {
  const res = await fetch(SHEET_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheets CSV HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const first = rows[0];
  const looksLikeHeader = first.some(c =>
    /^(dato|øvelse|oevelse|exercise|redskab|equipment|kg|reps)/i.test((c || "").trim())
  );
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;
  return dataRows
    .filter(r => r.length >= 2 && (r[0] || "").trim())
    .map(r => {
      const kg = parseFloat((r[3] || "").replace(",", "."));
      const reps = parseInt(r[4]);
      return {
        date: (r[0] || "").trim(),
        exercise: (r[1] || "").trim(),
        equipment: (r[2] || "").trim(),
        kg: Number.isFinite(kg) ? kg : null,
        reps: Number.isFinite(reps) ? reps : null,
        repsGoal: (r[5] || "").trim(),
        setType: (r[6] || "").trim() || "Working",
        oneRepMax: parseFloat((r[7] || "").replace(",", ".")) || null,
        notes: (r[8] || "").trim(),
      };
    })
    .filter(r => r.exercise);
}

// Hent alt data fra Apps Script (sæt, øvelser, redskaber)
async function fetchAllData() {
  if (!isAppsScriptConfigured()) {
    // Fallback: hent kun sæt via CSV, returner tomme lister for resten
    const sets = await fetchSetsFromCSV();
    return { sets, exercises: [], equipment: [] };
  }
  const res = await fetch(APPS_SCRIPT_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return {
    sets: Array.isArray(json.sets) ? json.sets : [],
    exercises: Array.isArray(json.exercises) ? json.exercises : [],
    equipment: Array.isArray(json.equipment) ? json.equipment : [],
  };
}

// Generisk POST-helper til Apps Script
async function postToAppsScript(payload) {
  if (!isAppsScriptConfigured()) {
    console.warn("Apps Script URL ikke konfigureret");
    return false;
  }
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
    return true;
  } catch (e) {
    console.error("Apps Script skrive-fejl:", e);
    return false;
  }
}

async function logSetToSheet(set) {
  return postToAppsScript({
    type: "set",
    dato: set.date,
    oevelse: set.exercise,
    redskab: set.equipment,
    kg: String(set.kg),
    reps: String(set.reps),
    repsmaal: set.repsGoal || "",
    saettype: set.setType || "Working",
    orm: set.oneRepMax != null ? String(set.oneRepMax) : "",
    noter: set.notes || "",
  });
}

async function saveExerciseToSheet(exercise) {
  return postToAppsScript({
    type: "exercise",
    name: exercise.name,
    primaryMuscle: exercise.primaryMuscle || "",
    secondaryMuscles: exercise.secondaryMuscles || "",
  });
}

async function saveEquipmentToSheet(equipment) {
  return postToAppsScript({
    type: "equipment",
    name: equipment.name,
  });
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

  // ── Google Sheets data ──
  const [sheetData, setSheetData] = useState([]);
  const [sheetExercises, setSheetExercises] = useState([]); // [{name, primaryMuscle, secondaryMuscles}]
  const [sheetEquipment, setSheetEquipment] = useState([]); // [{name}]
  const [sheetLoading, setSheetLoading] = useState(true);
  const [sheetError, setSheetError] = useState(null);

  // LOG state — multi-sæt session builder
  const today = new Date().toISOString().slice(0, 10);
  const [sessionDate, setSessionDate] = useState(today);
  const newSetId = () => `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const blankEntry = () => ({
    id: newSetId(),
    exercise: "", equipment: "", kg: "", reps: "",
    repsGoal: "8-10", setType: "Working", notes: "",
    collapsed: false,
  });
  const [entries, setEntries] = useState([blankEntry()]);
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importDay, setImportDay] = useState("");

  // Helper: opdater et enkelt sæt by id
  const updateEntry = useCallback((id, patch) => {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e));
  }, []);
  // Setter shim — for code paths der stadig sætter "entry" (fx ØVELSER/REDSKABER tabs)
  // Opdaterer det sidste sæt i listen (det man arbejder på)
  const setEntry = useCallback((updater) => {
    setEntries(prev => {
      if (!prev.length) return prev;
      const next = [...prev];
      const last = next[next.length - 1];
      const patched = typeof updater === "function" ? updater(last) : { ...last, ...updater };
      next[next.length - 1] = { ...patched, id: last.id, collapsed: false };
      return next;
    });
  }, []);
  // For at gøre eksisterende kode der læser "entry" simpelt: vi peger på sidste sæt
  const entry = entries[entries.length - 1] || blankEntry();

  // ØVELSER state
  const [exSearch, setExSearch] = useState("");
  const [expandedEx, setExpandedEx] = useState(null);
  const [customExercises, setCustomExercises] = useState([]);
  const [showAddEx, setShowAddEx] = useState(false);
  const [newExName, setNewExName] = useState("");
  const [newExPrimary, setNewExPrimary] = useState("");
  const [newExSecondary, setNewExSecondary] = useState("");
  const [savingEx, setSavingEx] = useState(false);

  // REDSKABER state
  const [eqSearch, setEqSearch] = useState("");
  const [expandedEq, setExpandedEq] = useState(null);
  const [showAddEq, setShowAddEq] = useState(false);
  const [newEqName, setNewEqName] = useState("");
  const [savingEq, setSavingEq] = useState(false);

  // HISTORIK state
  const [histEx, setHistEx] = useState("");
  const [histEq, setHistEq] = useState("");
  const [expandedDay, setExpandedDay] = useState(null);

  // STATS state
  const [statsEx, setStatsEx] = useState("");

  // ── Alle records ──
  const allData = useMemo(() => SEED_DATA.map(r => ({
    date: r[0], exercise: r[1], kg: parseFloat(r[2]) || null,
    reps: parseInt(r[3]) || null, repsGoal: r[4], equipment: r[5],
    notes: r[6],
    oneRepMax: calc1RM(parseFloat(r[2]), parseInt(r[3])),
  })), []);

  const allRecords = useMemo(() => {
    // Dedup-key: dato + øvelse + redskab + kg + reps. Sheet vinder over seed.
    const keyOf = r => `${r.date}|${r.exercise}|${r.equipment}|${r.kg}|${r.reps}`;
    const sheetKeys = new Set(sheetData.map(keyOf));
    const seedNotInSheet = allData.filter(r => !sheetKeys.has(keyOf(r)));
    return [...seedNotInSheet, ...sheetData, ...localData]
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }, [allData, sheetData, localData]);

  // ── Hent alt data fra Google Sheets ved opstart ──
  useEffect(() => {
    let cancelled = false;
    setSheetLoading(true);
    fetchAllData()
      .then(({ sets, exercises, equipment }) => {
        if (cancelled) return;
        setSheetData(sets);
        setSheetExercises(exercises);
        setSheetEquipment(equipment);
        setSheetError(null);
      })
      .catch(err => {
        if (cancelled) return;
        console.error("Sheet fetch fejlede:", err);
        setSheetError(err.message || "Kunne ikke hente data fra Google Sheets");
      })
      .finally(() => { if (!cancelled) setSheetLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── Manuel refresh af alle sheet-data ──
  const refreshSheet = useCallback(async () => {
    setSheetLoading(true);
    try {
      const { sets, exercises, equipment } = await fetchAllData();
      setSheetData(sets);
      setSheetExercises(exercises);
      setSheetEquipment(equipment);
      setSheetError(null);
      showToast(`Hentet ${sets.length} sæt fra Sheets ✓`, true);
    } catch (err) {
      console.error(err);
      setSheetError(err.message || "Fejl");
      showToast("Kunne ikke hente fra Sheets", false);
    } finally {
      setSheetLoading(false);
    }
  }, []);

  // ── Tilføj ny øvelse (gemmes i Sheets med muskelgruppe-info) ──
  const handleAddExercise = useCallback(async () => {
    const name = newExName.trim();
    if (!name) return;
    setSavingEx(true);
    const ok = await saveExerciseToSheet({
      name,
      primaryMuscle: newExPrimary.trim(),
      secondaryMuscles: newExSecondary.trim(),
    });
    if (ok) {
      // Opdater lokalt så det vises straks
      setSheetExercises(prev => {
        if (prev.some(e => e.name.toLowerCase() === name.toLowerCase())) return prev;
        return [...prev, {
          name,
          primaryMuscle: newExPrimary.trim(),
          secondaryMuscles: newExSecondary.trim(),
        }];
      });
      setNewExName(""); setNewExPrimary(""); setNewExSecondary("");
      setShowAddEx(false);
      showToast(`"${name}" tilføjet ✓`, true);
    } else {
      // Fallback: gem lokalt så brugeren ikke mister det
      setCustomExercises(p => [...p, name]);
      setNewExName(""); setNewExPrimary(""); setNewExSecondary("");
      setShowAddEx(false);
      showToast("Kunne ikke gemme i Sheets — kun lokalt", false);
    }
    setSavingEx(false);
  }, [newExName, newExPrimary, newExSecondary]);

  // ── Tilføj nyt redskab (gemmes i Sheets) ──
  const handleAddEquipment = useCallback(async () => {
    const name = newEqName.trim();
    if (!name) return;
    setSavingEq(true);
    const ok = await saveEquipmentToSheet({ name });
    if (ok) {
      setSheetEquipment(prev => {
        if (prev.some(e => e.name.toLowerCase() === name.toLowerCase())) return prev;
        return [...prev, { name }];
      });
      setNewEqName("");
      setShowAddEq(false);
      showToast(`"${name}" tilføjet ✓`, true);
    } else {
      setNewEqName("");
      setShowAddEq(false);
      showToast("Kunne ikke gemme i Sheets", false);
    }
    setSavingEq(false);
  }, [newEqName]);

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

  // ── Grupperet pr. dag (til Historik + Import) ──
  const daysGrouped = useMemo(() => {
    const map = new Map();
    for (const r of allRecords) {
      if (!r.date) continue;
      if (!map.has(r.date)) map.set(r.date, []);
      map.get(r.date).push(r);
    }
    // Sortér nyeste først
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, records]) => ({
        date,
        records,
        exercises: [...new Set(records.map(r => r.exercise).filter(Boolean))],
      }));
  }, [allRecords]);

  // ── Exercise lists ──
  const allExercises = useMemo(() => {
    const fromSheet = sheetExercises.map(e => e.name).filter(Boolean);
    const fromData = [...new Set(allRecords.map(r => r.exercise).filter(Boolean))];
    const merged = [...new Set([...ALL_EXERCISES, ...fromSheet, ...fromData, ...customExercises])];
    return merged.sort();
  }, [allRecords, customExercises, sheetExercises]);

  const allEquipment = useMemo(() => {
    const fromSheet = sheetEquipment.map(e => e.name).filter(Boolean);
    const fromData = [...new Set(allRecords.map(r => r.equipment).filter(Boolean))];
    return [...new Set([...ALL_EQUIPMENT, ...fromSheet, ...fromData])].sort();
  }, [allRecords, sheetEquipment]);

  // Map øvelsesnavn → muskelgruppe-info (fra Øvelser-arket)
  const exerciseMuscleMap = useMemo(() => {
    const map = {};
    for (const e of sheetExercises) {
      if (e.name) map[e.name] = {
        primaryMuscle: e.primaryMuscle || "",
        secondaryMuscles: e.secondaryMuscles || "",
      };
    }
    return map;
  }, [sheetExercises]);

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

  // ── Save sets (alle sæt fra session) ──
  const handleSave = useCallback(async () => {
    // Validér: alle sæt skal have øvelse, kg, reps
    const invalid = entries.find(e => !e.exercise || !e.kg || !e.reps);
    if (invalid) {
      // Udfold det første ugyldige sæt så brugeren ser hvad der mangler
      setEntries(prev => prev.map(e => e.id === invalid.id ? { ...e, collapsed: false } : e));
      showToast("Udfyld øvelse, kg og reps på alle sæt", false);
      return;
    }
    setSaving(true);
    const records = entries.map(e => ({
      date: sessionDate, exercise: e.exercise, equipment: e.equipment,
      kg: parseFloat(e.kg), reps: parseInt(e.reps),
      repsGoal: e.repsGoal, setType: e.setType, notes: e.notes,
      oneRepMax: calc1RM(parseFloat(e.kg), parseInt(e.reps)),
    }));
    // Send alle sæt parallelt direkte til Sheets
    const results = await Promise.all(records.map(r => logSetToSheet(r)));
    const allOk = results.every(Boolean);
    setLocalData(prev => [...prev, ...records]);
    // Nulstil til ét tomt sæt — men husk øvelse/redskab/rep range/sæt type fra sidste sæt
    const last = entries[entries.length - 1];
    setEntries([{
      ...blankEntry(),
      exercise: last.exercise,
      equipment: last.equipment,
      repsGoal: last.repsGoal,
      setType: last.setType,
    }]);
    setSaving(false);
    showToast(
      allOk
        ? `${records.length} sæt gemt i Sheets ✓`
        : "Kunne ikke gemme i Sheets — gemt lokalt",
      allOk
    );
  }, [entries, sessionDate]);

  // ── Tilføj nyt sæt (arver smart defaults fra det forrige) ──
  const addSet = useCallback(() => {
    setEntries(prev => {
      const last = prev[prev.length - 1];
      // Kollaps det forrige sæt automatisk
      const collapsedPrev = prev.map((e, i) =>
        i === prev.length - 1 ? { ...e, collapsed: true } : e
      );
      return [...collapsedPrev, {
        ...blankEntry(),
        exercise: last?.exercise || "",
        equipment: last?.equipment || "",
        repsGoal: last?.repsGoal || "8-10",
        setType: last?.setType || "Working",
      }];
    });
  }, []);

  // ── Fjern et sæt ──
  const removeSet = useCallback((id) => {
    setEntries(prev => {
      if (prev.length === 1) {
        // Hvis det er det eneste tilbage, nulstil det i stedet for at fjerne
        return [blankEntry()];
      }
      return prev.filter(e => e.id !== id);
    });
  }, []);

  // ── Toggle collapse ──
  const toggleCollapse = useCallback((id) => {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, collapsed: !e.collapsed } : e));
  }, []);

  // ── Importér tidligere træningsdag ──
  const importFromDay = useCallback((date) => {
    if (!date) return;
    const day = daysGrouped.find(d => d.date === date);
    if (!day || !day.records.length) return;

    // Byg sæt ud fra dagens records — kg/reps udfyldes på forhånd, brugeren retter til
    const imported = day.records.map(r => ({
      id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      exercise: r.exercise || "",
      equipment: r.equipment || "",
      kg: r.kg != null ? String(r.kg) : "",
      reps: r.reps != null ? String(r.reps) : "",
      repsGoal: r.repsGoal || "8-10",
      setType: r.setType || "Working",
      notes: r.notes || "",
      collapsed: true, // alle kollapsede så man har overblik
    }));

    setEntries(prev => {
      // Hvis nuværende state kun er ét tomt sæt → erstat
      const isOnlyBlank = prev.length === 1
        && !prev[0].exercise && !prev[0].kg && !prev[0].reps;
      if (isOnlyBlank) return imported;
      // Ellers append så brugeren ikke mister deres arbejde,
      // og kollaps eksisterende sæt så de nye importerede er tydelige
      const collapsedExisting = prev.map(e => ({ ...e, collapsed: true }));
      return [...collapsedExisting, ...imported];
    });
    setShowImport(false);
    setImportDay("");
    showToast(`${imported.length} sæt importeret — ret kg/reps`, true);
  }, [daysGrouped]);

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Bebas+Neue&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={S.header}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div style={{...S.title, marginBottom:0}}>⚡ STYRKE TRACKER</div>
          <button
            onClick={refreshSheet}
            disabled={sheetLoading}
            title={sheetError ? `Fejl: ${sheetError}` : `${sheetData.length} sæt hentet fra Sheets`}
            style={{
              background:"none", border:"none", cursor:"pointer",
              fontSize:9, letterSpacing:"0.1em",
              color: sheetError ? "#ff6b6b" : sheetLoading ? "#666" : "#4a6a00",
              fontFamily:"'DM Mono', monospace",
              padding:"4px 8px",
              opacity: sheetLoading ? 0.6 : 1,
            }}
          >
            {sheetLoading
              ? "↻ HENTER..."
              : sheetError
                ? "⚠ FEJL · GENPRØV"
                : `↻ ${sheetData.length} SÆT`}
          </button>
        </div>
        <div style={S.nav}>
          {[["log","LOG"],["exercises","ØVELSER"],["equipment","REDSKABER"],["history","HISTORIK"],["stats","STATS"]].map(([k,l]) => (
            <button key={k} style={S.navBtn(view===k)} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
      </div>

      {/* ── LOG (multi-sæt session builder) ── */}
      {view === "log" && (
        <div style={S.page}>
          {/* Session-dato — gælder alle sæt */}
          <div style={{...S.card, padding:"10px 14px", marginBottom:10}}>
            <label style={S.label}>Dato for session</label>
            <input
              type="date"
              style={S.input}
              value={sessionDate}
              onChange={e => setSessionDate(e.target.value)}
            />
          </div>

          {/* Importér tidligere træning */}
          <div style={{ marginBottom:10 }}>
            <button
              style={{
                ...S.btnGhost,
                width:"100%",
                padding:"10px",
                fontSize:10,
                letterSpacing:"0.12em",
                color: showImport ? "#b8e840" : "#888",
                borderColor: showImport ? "#1a2e00" : "#252528",
              }}
              onClick={() => setShowImport(s => !s)}
            >
              {showImport ? "▲ LUK" : "↓ IMPORTÉR TIDLIGERE TRÆNING"}
            </button>
            {showImport && (
              <div style={{...S.card, marginTop:8, marginBottom:0}}>
                <label style={S.label}>Vælg træningsdag</label>
                <select
                  style={S.select}
                  value={importDay}
                  onChange={e => setImportDay(e.target.value)}
                >
                  <option value="">— vælg dag —</option>
                  {daysGrouped.map(d => (
                    <option key={d.date} value={d.date}>
                      {d.date} · {d.records.length} sæt · {d.exercises.slice(0, 3).join(", ")}{d.exercises.length > 3 ? "…" : ""}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize:9, color:"#444", marginTop:8, letterSpacing:"0.05em", lineHeight:1.5 }}>
                  Kopierer alle sæt fra den valgte dag ind i log. Datoen sættes til {sessionDate}. Ret kg/reps som du tager dem i dag.
                </div>
                <button
                  style={{...S.btn, width:"100%", marginTop:10, opacity: importDay ? 1 : 0.4}}
                  onClick={() => importFromDay(importDay)}
                  disabled={!importDay}
                >
                  IMPORTÉR →
                </button>
              </div>
            )}
          </div>

          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <div style={{...S.sectionTitle, marginBottom:0, border:"none", padding:0}}>
              SESSION · {entries.length} {entries.length === 1 ? "sæt" : "sæt"}
            </div>
            {entries.length > 1 && (
              <button
                style={{...S.btnGhost, padding:"4px 8px", fontSize:9}}
                onClick={() => setEntries(prev => {
                  const allCollapsed = prev.every(e => e.collapsed);
                  return prev.map(e => ({ ...e, collapsed: !allCollapsed }));
                })}
              >
                {entries.every(e => e.collapsed) ? "Fold ud alle" : "Fold ind alle"}
              </button>
            )}
          </div>

          {entries.map((e, idx) => {
            const eLiveOrm = calc1RM(parseFloat(e.kg), parseInt(e.reps));
            const eBestOrm = (e.exercise && e.equipment)
              ? best1RMMap[`${e.exercise}||${e.equipment}`] || null
              : null;
            const eEquipForExercise = (() => {
              if (!e.exercise) return allEquipment;
              const used = [...new Set(allRecords
                .filter(r => r.exercise === e.exercise)
                .map(r => r.equipment).filter(Boolean))];
              return used.length ? used : allEquipment;
            })();
            const isComplete = e.exercise && e.kg && e.reps;

            return (
              <div key={e.id} style={S.card}>
                {/* Header: altid synlig — klikbar for at toggle collapse */}
                <div
                  style={{
                    display:"flex", justifyContent:"space-between", alignItems:"center",
                    cursor:"pointer", userSelect:"none",
                    marginBottom: e.collapsed ? 0 : 10,
                  }}
                  onClick={() => toggleCollapse(e.id)}
                >
                  <div style={{ display:"flex", alignItems:"center", gap:8, minWidth:0, flex:1 }}>
                    <span style={{
                      fontSize:9, color:"#b8e840", letterSpacing:"0.15em",
                      background:"#1a2a00", padding:"3px 7px", borderRadius:4, fontWeight:600,
                      flexShrink:0,
                    }}>
                      SÆT {idx + 1}
                    </span>
                    {e.collapsed ? (
                      // Kompakt overblik når collapsed
                      <div style={{ minWidth:0, flex:1, overflow:"hidden" }}>
                        {isComplete ? (
                          <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:11 }}>
                            <span style={{ color:"#e4e4dc", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                              {e.exercise}
                            </span>
                            <span style={{ color:"#b8e840", fontWeight:600, whiteSpace:"nowrap" }}>
                              {e.kg}×{e.reps}
                            </span>
                            {eLiveOrm && (
                              <span style={{ color:"#444", fontSize:10, whiteSpace:"nowrap" }}>
                                1RM ~{eLiveOrm}
                              </span>
                            )}
                          </div>
                        ) : (
                          <div style={{ fontSize:11, color:"#555", fontStyle:"italic" }}>
                            Ikke udfyldt
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize:11, color:"#666" }}>
                        {isComplete ? "Udfyldt" : "Udfyld felter ↓"}
                      </div>
                    )}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
                    {entries.length > 1 && (
                      <button
                        onClick={(ev) => { ev.stopPropagation(); removeSet(e.id); }}
                        style={{
                          background:"none", border:"none", color:"#555",
                          fontSize:16, cursor:"pointer", padding:"0 4px", lineHeight:1,
                          fontFamily:"'DM Mono', monospace",
                        }}
                        aria-label="Fjern sæt"
                        title="Fjern sæt"
                      >×</button>
                    )}
                    <span style={{ color:"#444", fontSize:11 }}>{e.collapsed ? "▼" : "▲"}</span>
                  </div>
                </div>

                {/* Udfoldet form */}
                {!e.collapsed && (
                  <>
                    <div style={{ marginBottom:10 }}>
                      <label style={S.label}>Øvelse</label>
                      <select style={S.select} value={e.exercise}
                        onChange={ev => updateEntry(e.id, { exercise: ev.target.value, equipment: "" })}>
                        <option value="">— vælg øvelse —</option>
                        {allExercises.map(ex => <option key={ex}>{ex}</option>)}
                      </select>
                    </div>

                    <div style={{ marginBottom:10 }}>
                      <label style={S.label}>Redskab</label>
                      <select style={S.select} value={e.equipment}
                        onChange={ev => updateEntry(e.id, { equipment: ev.target.value })}>
                        <option value="">— vælg redskab —</option>
                        {eEquipForExercise.map(eq => <option key={eq}>{eq}</option>)}
                      </select>
                    </div>

                    {/* 1RM guide */}
                    {eBestOrm && (
                      <div style={S.orm}>
                        <div style={S.ormTitle}>BEDSTE 1RM — {e.exercise} / {e.equipment}</div>
                        {[[40,"Opvarm"],[60,"Let"],[80,"Arbejds"]].map(([pct, label]) => (
                          <div key={pct} style={S.ormRow}>
                            <span style={S.ormLabel}>{pct}% — {label}</span>
                            <span style={S.ormValue}>{Math.round(eBestOrm * pct / 100 * 2) / 2} kg</span>
                          </div>
                        ))}
                        <div style={{...S.ormRow, marginTop:6, borderTop:"1px solid #1a2e00", paddingTop:6}}>
                          <span style={S.ormLabel}>Bedste 1RM</span>
                          <span style={{...S.ormValue, fontSize:13}}>{eBestOrm} kg</span>
                        </div>
                      </div>
                    )}

                    <div style={{...S.grid2, margin:"10px 0"}}>
                      <div>
                        <label style={S.label}>Kg</label>
                        <input type="number" style={S.input} placeholder="0" value={e.kg}
                          onChange={ev => updateEntry(e.id, { kg: ev.target.value })} />
                      </div>
                      <div>
                        <label style={S.label}>Reps</label>
                        <input type="number" style={S.input} placeholder="0" value={e.reps}
                          onChange={ev => updateEntry(e.id, { reps: ev.target.value })} />
                      </div>
                    </div>

                    {eLiveOrm && (
                      <div style={{ fontSize:10, color:"#b8e840", textAlign:"right", marginBottom:8, letterSpacing:"0.08em" }}>
                        Est. 1RM: <strong>{eLiveOrm} kg</strong>
                      </div>
                    )}

                    <div style={{...S.grid2, marginBottom:10}}>
                      <div>
                        <label style={S.label}>Rep Range</label>
                        <select style={S.select} value={e.repsGoal}
                          onChange={ev => updateEntry(e.id, { repsGoal: ev.target.value })}>
                          {REP_RANGES.map(r => <option key={r}>{r}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={S.label}>Sæt Type</label>
                        <select style={S.select} value={e.setType}
                          onChange={ev => updateEntry(e.id, { setType: ev.target.value })}>
                          {SET_TYPES.map(t => <option key={t}>{t}</option>)}
                        </select>
                      </div>
                    </div>

                    <div style={{ marginBottom:4 }}>
                      <label style={S.label}>Noter</label>
                      <input type="text" style={S.input} placeholder="Valgfrit..." value={e.notes}
                        onChange={ev => updateEntry(e.id, { notes: ev.target.value })} />
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {/* Tilføj sæt-knap */}
          <button
            style={{
              ...S.btnGhost,
              width:"100%",
              padding:"12px",
              fontSize:11,
              letterSpacing:"0.12em",
              fontWeight:600,
              color:"#b8e840",
              borderColor:"#1a2e00",
              borderStyle:"dashed",
              background:"transparent",
              marginBottom:10,
            }}
            onClick={addSet}
          >
            + TILFØJ SÆT
          </button>

          {/* Gem-knap */}
          <button
            style={{...S.btn, width:"100%", opacity: saving ? 0.6 : 1}}
            onClick={handleSave}
            disabled={saving}
          >
            {saving
              ? "GEMMER..."
              : `GEM ${entries.length} ${entries.length === 1 ? "SÆT" : "SÆT"} → GOOGLE SHEETS`}
          </button>

          <div style={{ fontSize:9, color:"#333", textAlign:"center", marginTop:6, letterSpacing:"0.08em" }}>
            Direkte til Træningslog / Google Sheets
          </div>

          {/* Seneste sæt (denne session, allerede gemt) */}
          {localData.length > 0 && (
            <div style={{...S.card, marginTop:14}}>
              <div style={S.sectionTitle}>GEMT I DAG</div>
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
              <input style={{...S.input, marginBottom:8}} value={newExName}
                onChange={e => setNewExName(e.target.value)} placeholder="Navn (fx Bænkpres)..." />
              <label style={S.label}>Primær muskel</label>
              <input style={{...S.input, marginBottom:8}} value={newExPrimary}
                onChange={e => setNewExPrimary(e.target.value)} placeholder="Fx Bryst" />
              <label style={S.label}>Sekundær muskler</label>
              <input style={{...S.input, marginBottom:10}} value={newExSecondary}
                onChange={e => setNewExSecondary(e.target.value)} placeholder="Fx Triceps, Skulder (komma-separeret)" />
              <div style={{ display:"flex", gap:8 }}>
                <button
                  style={{...S.btn, flex:1, opacity: savingEx ? 0.6 : 1}}
                  onClick={handleAddExercise}
                  disabled={savingEx || !newExName.trim()}
                >
                  {savingEx ? "GEMMER..." : "TILFØJ TIL SHEETS"}
                </button>
                <button
                  style={S.btnGhost}
                  onClick={() => { setShowAddEx(false); setNewExName(""); setNewExPrimary(""); setNewExSecondary(""); }}
                >Annuller</button>
              </div>
              <div style={{ fontSize:9, color:"#444", marginTop:8, letterSpacing:"0.05em" }}>
                Gemmes i Øvelser-arket. Sekundær muskler bruges senere til muskelgruppe-statistik.
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
                      {/* Muskelgrupper (hvis kendt) */}
                      {(() => {
                        const m = exerciseMuscleMap[ex];
                        if (!m || (!m.primaryMuscle && !m.secondaryMuscles)) return null;
                        return (
                          <div style={{ marginBottom:12, padding:"8px 10px", background:"#0d1700", borderRadius:4, border:"1px solid #1a2e00" }}>
                            {m.primaryMuscle && (
                              <div style={{ fontSize:10, color:"#888", letterSpacing:"0.1em", marginBottom:4 }}>
                                PRIMÆR: <span style={{ color:"#b8e840", fontWeight:600 }}>{m.primaryMuscle}</span>
                              </div>
                            )}
                            {m.secondaryMuscles && (
                              <div style={{ fontSize:10, color:"#888", letterSpacing:"0.1em" }}>
                                SEKUNDÆR: <span style={{ color:"#6a8a30" }}>{m.secondaryMuscles}</span>
                              </div>
                            )}
                          </div>
                        );
                      })()}
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
          <div style={{ display:"flex", gap:8, marginBottom:12 }}>
            <input style={{...S.input, flex:1}} placeholder="Søg redskab..." value={eqSearch}
              onChange={e => setEqSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => setShowAddEq(!showAddEq)}>+</button>
          </div>
          {showAddEq && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>Nyt redskab</label>
              <input style={{...S.input, marginBottom:10}} value={newEqName}
                onChange={e => setNewEqName(e.target.value)} placeholder="Navn (fx Lat Pulldown Machine)..." />
              <div style={{ display:"flex", gap:8 }}>
                <button
                  style={{...S.btn, flex:1, opacity: savingEq ? 0.6 : 1}}
                  onClick={handleAddEquipment}
                  disabled={savingEq || !newEqName.trim()}
                >
                  {savingEq ? "GEMMER..." : "TILFØJ TIL SHEETS"}
                </button>
                <button
                  style={S.btnGhost}
                  onClick={() => { setShowAddEq(false); setNewEqName(""); }}
                >Annuller</button>
              </div>
              <div style={{ fontSize:9, color:"#444", marginTop:8, letterSpacing:"0.05em" }}>
                Gemmes i Redskaber-arket. Nye redskaber vises i alle dropdowns.
              </div>
            </div>
          )}
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

      {/* ── HISTORIK (grupperet pr. dag) ── */}
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
          {(() => {
            // Filtrér dage så de kun viser sæt der matcher filter (og skjul dage uden match)
            const filteredDays = daysGrouped
              .map(d => ({
                ...d,
                records: d.records.filter(r =>
                  (!histEx || r.exercise === histEx) &&
                  (!histEq || r.equipment === histEq)
                ),
              }))
              .filter(d => d.records.length > 0)
              .slice(0, 60);

            if (!filteredDays.length) {
              return (
                <div style={{ color:"#444", fontSize:12, textAlign:"center", marginTop:40 }}>
                  Ingen sæt matcher filteret
                </div>
              );
            }

            return filteredDays.map(day => {
              const isOpen = expandedDay === day.date;
              const exercisesForDay = [...new Set(day.records.map(r => r.exercise).filter(Boolean))];
              return (
                <div key={day.date} style={S.card}>
                  {/* Dag-header (klikbar) */}
                  <div
                    style={{ display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer", userSelect:"none" }}
                    onClick={() => setExpandedDay(isOpen ? null : day.date)}
                  >
                    <div style={{ minWidth:0, flex:1 }}>
                      <div style={{ fontSize:13, color:"#e4e4dc", fontWeight:600 }}>{day.date}</div>
                      <div style={{ fontSize:10, color:"#555", marginTop:2 }}>
                        {day.records.length} sæt · {exercisesForDay.slice(0, 3).join(", ")}{exercisesForDay.length > 3 ? "…" : ""}
                      </div>
                    </div>
                    <span style={{ color:"#444", fontSize:12, flexShrink:0, marginLeft:8 }}>{isOpen ? "▲" : "▼"}</span>
                  </div>

                  {/* Sæt-liste for dagen */}
                  {isOpen && (
                    <div style={{ marginTop:10, borderTop:"1px solid #1a1a1e", paddingTop:8 }}>
                      {day.records.map((r, i) => {
                        const isPR = r.oneRepMax && best1RMMap[`${r.exercise}||${r.equipment}`] === r.oneRepMax;
                        return (
                          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #161618" }}>
                            <div style={{ minWidth:0, flex:1 }}>
                              <div style={{ fontSize:12, color:"#e4e4dc" }}>
                                {r.exercise}
                                {isPR && <span style={{...S.tagGreen, marginLeft:6}}>PR</span>}
                              </div>
                              <div style={{ fontSize:10, color:"#444", marginTop:1 }}>{r.equipment}</div>
                            </div>
                            <div style={{ textAlign:"right", flexShrink:0 }}>
                              <div style={{ fontSize:13, color:"#b8e840", fontWeight:600 }}>{r.kg} kg × {r.reps}</div>
                              {r.oneRepMax && <div style={{ fontSize:9, color:"#444" }}>1RM ~{r.oneRepMax}</div>}
                            </div>
                          </div>
                        );
                      })}
                      {/* Hurtig-knap: importér dagen til LOG */}
                      <button
                        style={{...S.btnGhost, width:"100%", marginTop:10, padding:"8px", fontSize:10, color:"#b8e840", borderColor:"#1a2e00"}}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          importFromDay(day.date);
                          setView("log");
                          setExpandedDay(null);
                        }}
                      >
                        ↓ IMPORTÉR DENNE DAG TIL LOG
                      </button>
                    </div>
                  )}
                </div>
              );
            });
          })()}
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
