import { useState, useMemo, useCallback, useEffect } from "react";

// ─── GOOGLE APPS SCRIPT ENDPOINT ──────────────────────────────────────────────
// Apps Script deployed som Web App. Læser og skriver alle data via dette ene endpoint.
// Sæt URL'en ind her efter du har deployet scriptet (se SHEETS_WRITE_SETUP.md).
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzq2AXvn-vxkhqBRBT_GMDEFMLZvjbWjounNbNHzRkPzfswXhG0lBuvoGO3mo68NBDj/exec";

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
// Bemærk: CSV-fallback understøtter ikke Center-kolonnen — brug Apps Script for det.
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
  // Detektér om Center-kolonnen er til stede (kolonne 3 før Kg)
  const hasCenter = looksLikeHeader && first[3] && /center/i.test(first[3]);
  return dataRows
    .filter(r => r.length >= 2 && (r[0] || "").trim())
    .map(r => {
      const offset = hasCenter ? 1 : 0;
      const kg = parseFloat((r[3 + offset] || "").replace(",", "."));
      const reps = parseInt(r[4 + offset]);
      return {
        date: (r[0] || "").trim(),
        exercise: (r[1] || "").trim(),
        equipment: (r[2] || "").trim(),
        center: hasCenter ? (r[3] || "").trim() : "",
        kg: Number.isFinite(kg) ? kg : null,
        reps: Number.isFinite(reps) ? reps : null,
        repsGoal: (r[5 + offset] || "").trim(),
        setType: (r[6 + offset] || "").trim() || "NORMAL SET",
        oneRepMax: parseFloat((r[7 + offset] || "").replace(",", ".")) || null,
        notes: (r[8 + offset] || "").trim(),
      };
    })
    .filter(r => r.exercise);
}

// Hent alt data fra Apps Script (sæt, øvelser, redskaber, centre)
async function fetchAllData() {
  if (!isAppsScriptConfigured()) {
    // Fallback: hent kun sæt via CSV, returner tomme lister for resten
    const sets = await fetchSetsFromCSV();
    return { sets, exercises: [], equipment: [], centers: [] };
  }
  let res;
  try {
    res = await fetch(APPS_SCRIPT_URL, { cache: "no-store", redirect: "follow" });
  } catch (e) {
    throw new Error(`Netværksfejl: ${e.message || e}`);
  }
  if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
  const text = await res.text();
  // Apps Script kan returnere HTML (login-side eller redirect) hvis deployment
  // ikke er sat til "Anyone" eller hvis URL'en peger på en gammel version
  if (text.trim().startsWith("<")) {
    console.error("Apps Script returnerede HTML — tjekkes nedenfor:", text.slice(0, 500));
    throw new Error("Apps Script returnerede HTML i stedet for JSON. Tjek at deployment access = 'Anyone' og at scriptet er redeployet med nyeste kode.");
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.error("JSON-parse fejl. Raw response:", text.slice(0, 500));
    throw new Error(`Apps Script returnerede ugyldig JSON: ${text.slice(0, 100)}`);
  }
  if (json.error) throw new Error(`Apps Script fejl: ${json.error}`);
  return {
    sets: Array.isArray(json.sets) ? json.sets : [],
    exercises: Array.isArray(json.exercises) ? json.exercises : [],
    equipment: Array.isArray(json.equipment) ? json.equipment : [],
    centers: Array.isArray(json.centers) ? json.centers : [],
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
    handle: set.handle || "",
    center: set.center || "",
    kg: String(set.kg),
    reps: String(set.reps),
    repsmaal: set.repsGoal || "",
    saettype: set.setType || "NORMAL SET",
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
    equipment: exercise.equipment || "",
  });
}

async function saveEquipmentToSheet(equipment) {
  return postToAppsScript({
    type: "equipment",
    name: equipment.name,
  });
}

async function saveCenterToSheet(center) {
  return postToAppsScript({
    type: "center",
    name: center.name,
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

// ─── HISTORISK DATA ───────────────────────────────────────────────────────────
// Sheet er nu eneste kilde for både øvelser, redskaber og træningsdata.
const SEED_DATA = [];

// Sheet er nu eneste sandhed for øvelser og redskaber.
// Hvis sheet ikke kan læses, viser appen ingen øvelser/redskaber til at vælge —
// brugeren skal i så fald tjekke sin Apps Script-opsætning.
const ALL_EXERCISES = [];
const ALL_EQUIPMENT = [];

const SET_TYPES = ["NORMAL SET","WARM-UP SET","DROP SET","AMRAP"];

// Handles til CABLE TOWER. Bruges som ekstra valg når redskab = CABLE TOWER.
const HANDLES = ["ROPE", "BAR", "CLOSE GRIP HANDLE", "WIDE GRIP HANDLE"];
const REP_RANGES = ["1-3","3-5","4-5","5","5-8","6-8","8-10","8-12","10-12","10-15","12-15","15-20","20-30","30-60 sek."];

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
  const [sheetExercises, setSheetExercises] = useState([]); // [{name, primaryMuscle, secondaryMuscles, equipment}]
  const [sheetEquipment, setSheetEquipment] = useState([]); // [{name}]
  const [sheetCenters, setSheetCenters] = useState([]); // [{name}]
  const [sheetLoading, setSheetLoading] = useState(true);
  const [sheetError, setSheetError] = useState(null);

  // LOG state — multi-sæt session builder
  const today = new Date().toISOString().slice(0, 10);
  const [sessionDate, setSessionDate] = useState(today);
  const [sessionCenter, setSessionCenter] = useState(""); // valgfri — kan være tom
  const newSetId = () => `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const blankEntry = () => ({
    id: newSetId(),
    exercise: "", equipment: "", handle: "", kg: "", reps: "",
    repsGoal: "8-10", setType: "NORMAL SET", notes: "",
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
  const [newExEquipment, setNewExEquipment] = useState("");
  const [savingEx, setSavingEx] = useState(false);

  // REDSKABER state
  const [eqSearch, setEqSearch] = useState("");
  const [expandedEq, setExpandedEq] = useState(null);
  const [showAddEq, setShowAddEq] = useState(false);
  const [newEqName, setNewEqName] = useState("");
  const [savingEq, setSavingEq] = useState(false);

  // GYMS (centre) state
  const [gymSearch, setGymSearch] = useState("");
  const [showAddGym, setShowAddGym] = useState(false);
  const [newGymName, setNewGymName] = useState("");
  const [savingGym, setSavingGym] = useState(false);

  // HISTORIK state
  const [histEx, setHistEx] = useState("");
  const [histEq, setHistEq] = useState("");
  const [histCenter, setHistCenter] = useState("");
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
    // Dedup-key: dato + øvelse + redskab + center + kg + reps. Sheet vinder over seed.
    const keyOf = r => `${r.date}|${r.exercise}|${r.equipment}|${r.center||""}|${r.kg}|${r.reps}`;
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
      .then(({ sets, exercises, equipment, centers }) => {
        if (cancelled) return;
        setSheetData(sets);
        setSheetExercises(exercises);
        setSheetEquipment(equipment);
        setSheetCenters(centers || []);
        setSheetError(null);
      })
      .catch(err => {
        if (cancelled) return;
        console.error("Sheet fetch fejlede:", err);
        setSheetError(err.message || "Could not load data from Google Sheets");
      })
      .finally(() => { if (!cancelled) setSheetLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── Manuel refresh af alle sheet-data ──
  const refreshSheet = useCallback(async () => {
    setSheetLoading(true);
    try {
      const { sets, exercises, equipment, centers } = await fetchAllData();
      setSheetData(sets);
      setSheetExercises(exercises);
      setSheetEquipment(equipment);
      setSheetCenters(centers || []);
      setSheetError(null);
      showToast(`${sets.length} sets loaded ✓`, true);
    } catch (err) {
      console.error(err);
      setSheetError(err.message || "Fejl");
      showToast("Could not load from Sheets", false);
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
      equipment: newExEquipment.trim(),
    });
    if (ok) {
      // Opdater lokalt så det vises straks
      setSheetExercises(prev => {
        if (prev.some(e => e.name.toLowerCase() === name.toLowerCase())) return prev;
        return [...prev, {
          name,
          primaryMuscle: newExPrimary.trim(),
          secondaryMuscles: newExSecondary.trim(),
          equipment: newExEquipment.trim(),
        }];
      });
      setNewExName(""); setNewExPrimary(""); setNewExSecondary(""); setNewExEquipment("");
      setShowAddEx(false);
      showToast(`"${name}" added ✓`, true);
    } else {
      // Fallback: gem lokalt så brugeren ikke mister det
      setCustomExercises(p => [...p, name]);
      setNewExName(""); setNewExPrimary(""); setNewExSecondary(""); setNewExEquipment("");
      setShowAddEx(false);
      showToast("Could not save to Sheets — local only", false);
    }
    setSavingEx(false);
  }, [newExName, newExPrimary, newExSecondary, newExEquipment]);

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
      showToast(`"${name}" added ✓`, true);
    } else {
      setNewEqName("");
      setShowAddEq(false);
      showToast("Could not save to Sheets", false);
    }
    setSavingEq(false);
  }, [newEqName]);

  // ── Tilføj nyt gym (gemmes i Sheets, Centre-arket) ──
  const handleAddGym = useCallback(async () => {
    const name = newGymName.trim();
    if (!name) return;
    setSavingGym(true);
    const ok = await saveCenterToSheet({ name });
    if (ok) {
      setSheetCenters(prev => {
        if (prev.some(e => e.name.toLowerCase() === name.toLowerCase())) return prev;
        return [...prev, { name }];
      });
      setNewGymName("");
      setShowAddGym(false);
      showToast(`"${name}" added ✓`, true);
    } else {
      setNewGymName("");
      setShowAddGym(false);
      showToast("Could not save to Sheets", false);
    }
    setSavingGym(false);
  }, [newGymName]);

  // ── best1RM map ──
  // Nøgle: exercise|equipment|handle|center — så samme øvelse på forskellig handle/center
  // har sit eget 1RM-track (fx Bicep Curl med Rope ≠ Bicep Curl med Bar).
  const best1RMMap = useMemo(() => {
    const map = {};
    for (const r of allRecords) {
      if (!r.exercise || !r.equipment || !r.oneRepMax) continue;
      const key = `${r.exercise}||${r.equipment}||${r.handle||""}||${r.center||""}`;
      if (!map[key] || r.oneRepMax > map[key]) map[key] = r.oneRepMax;
    }
    return map;
  }, [allRecords]);

  // Helper: hent bedste 1RM. Hvis handle/center er specificeret, vises kun det
  // matching slice. Hvis ikke, returneres bedste på tværs af alle varianter.
  const getBest1RM = useCallback((exercise, equipment, handle, center) => {
    if (!exercise || !equipment) return null;
    if (handle != null && center != null) {
      return best1RMMap[`${exercise}||${equipment}||${handle||""}||${center||""}`] || null;
    }
    // Aggregat: max på tværs af alle handle/center varianter
    const prefix = `${exercise}||${equipment}||`;
    let best = null;
    for (const key in best1RMMap) {
      if (key.startsWith(prefix)) {
        const v = best1RMMap[key];
        if (best == null || v > best) best = v;
      }
    }
    return best;
  }, [best1RMMap]);

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

  // Map øvelsesnavn → muskelgruppe-info og redskaber (fra Øvelser-arket)
  const exerciseMuscleMap = useMemo(() => {
    const map = {};
    for (const e of sheetExercises) {
      if (e.name) map[e.name] = {
        primaryMuscle: e.primaryMuscle || "",
        secondaryMuscles: e.secondaryMuscles || "",
        equipment: e.equipment || "",
      };
    }
    return map;
  }, [sheetExercises]);

  // Helper: hvilke redskaber kan en given øvelse laves med?
  // Prioritet: 1) Øvelser-arkets Redskab-kolonne, 2) hvad brugeren faktisk har brugt før, 3) alle redskaber
  const getEquipForExercise = useCallback((exerciseName) => {
    if (!exerciseName) return allEquipment;
    const meta = exerciseMuscleMap[exerciseName];
    if (meta && meta.equipment) {
      // Komma-separeret liste, fx "BARBELL, DUMBBELLS, MACHINE"
      return meta.equipment.split(",").map(s => s.trim()).filter(Boolean);
    }
    const used = [...new Set(allRecords
      .filter(r => r.exercise === exerciseName)
      .map(r => r.equipment).filter(Boolean))];
    return used.length ? used : allEquipment;
  }, [allEquipment, allRecords, exerciseMuscleMap]);

  const equipForExercise = useMemo(
    () => getEquipForExercise(entry.exercise),
    [entry.exercise, getEquipForExercise]
  );

  // ── Live 1RM estimate ──
  const liveOrm = useMemo(() => {
    const kg = parseFloat(entry.kg);
    const reps = parseInt(entry.reps);
    return calc1RM(kg, reps);
  }, [entry.kg, entry.reps]);

  const bestOrmForEntry = useMemo(() => {
    if (!entry.exercise || !entry.equipment) return null;
    return getBest1RM(entry.exercise, entry.equipment, entry.handle, sessionCenter);
  }, [entry.exercise, entry.equipment, entry.handle, sessionCenter, getBest1RM]);

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
      showToast("Fill in exercise, kg and reps for all sets", false);
      return;
    }
    setSaving(true);
    const records = entries.map(e => ({
      date: sessionDate, exercise: e.exercise, equipment: e.equipment,
      handle: e.handle || "",
      center: sessionCenter,
      kg: parseFloat(e.kg), reps: parseInt(e.reps),
      repsGoal: e.repsGoal, setType: e.setType, notes: e.notes,
      oneRepMax: calc1RM(parseFloat(e.kg), parseInt(e.reps)),
    }));
    // Send alle sæt parallelt direkte til Sheets
    const results = await Promise.all(records.map(r => logSetToSheet(r)));
    const allOk = results.every(Boolean);
    setLocalData(prev => [...prev, ...records]);
    // Nulstil til ét tomt sæt — men husk øvelse/redskab/handle/rep range/sæt type fra sidste sæt
    const last = entries[entries.length - 1];
    setEntries([{
      ...blankEntry(),
      exercise: last.exercise,
      equipment: last.equipment,
      handle: last.handle || "",
      repsGoal: last.repsGoal,
      setType: last.setType,
    }]);
    setSaving(false);
    showToast(
      allOk
        ? `${records.length} sets saved ✓`
        : "Could not save to Sheets — saved locally",
      allOk
    );
  }, [entries, sessionDate, sessionCenter]);

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
        handle: last?.handle || "",
        repsGoal: last?.repsGoal || "8-10",
        setType: last?.setType || "NORMAL SET",
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
      handle: r.handle || "",
      kg: r.kg != null ? String(r.kg) : "",
      reps: r.reps != null ? String(r.reps) : "",
      repsGoal: r.repsGoal || "8-10",
      setType: r.setType || "NORMAL SET",
      notes: r.notes || "",
      collapsed: true,
    }));

    // Hvis alle sæt fra dagen har samme center, sæt sessionCenter automatisk
    const centersInDay = [...new Set(day.records.map(r => r.center).filter(Boolean))];
    if (centersInDay.length === 1) {
      setSessionCenter(centersInDay[0]);
    }

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
    showToast(`${imported.length} sets imported — adjust kg/reps`, true);
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
            title={sheetError ? `Error: ${sheetError}` : `${sheetData.length} sets loaded from Sheets`}
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
              ? "↻ LOADING..."
              : sheetError
                ? "⚠ ERROR · TRY AGAIN"
                : `↻ ${sheetData.length} SÆT`}
          </button>
        </div>
        <div style={S.nav}>
          {[["log","LOG"],["resources","RESOURCES"],["history","HISTORY"],["insights","INSIGHTS"]].map(([k,l]) => (
            <button key={k} style={S.navBtn(view===k || (k==="resources" && ["exercises","equipment","gyms"].includes(view)))} onClick={() => setView(k === "resources" ? "exercises" : k)}>{l}</button>
          ))}
        </div>
        {/* Sub-nav for RESOURCES */}
        {["exercises","equipment","gyms"].includes(view) && (
          <div style={{...S.nav, marginTop:8, paddingLeft:8, borderLeft:"2px solid #1a2e00"}}>
            {[["exercises","EXERCISES"],["equipment","EQUIPMENT"],["gyms","GYMS"]].map(([k,l]) => (
              <button key={k} style={{...S.navBtn(view===k), fontSize:10}} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
        )}
      </div>

      {/* Fejl-banner — vises under header når data ikke kan hentes */}
      {sheetError && (
        <div style={{
          background:"#2a0a0a", border:"1px solid #5a1a1a", borderRadius:6,
          padding:"10px 12px", margin:"0 0 12px 0",
          fontSize:11, color:"#ff9999", lineHeight:1.5,
        }}>
          <div style={{ fontWeight:600, marginBottom:4, color:"#ff6b6b" }}>Could not load data from Google Sheets</div>
          <div style={{ fontSize:10, color:"#cc8888" }}>{sheetError}</div>
          <div style={{ fontSize:9, color:"#774444", marginTop:6, letterSpacing:"0.05em" }}>
            Check that Apps Script is deployed with "Anyone" access and that the URL in App.jsx is correct.
          </div>
        </div>
      )}

      {/* ── LOG (multi-set session builder) ── */}
      {view === "log" && (
        <div style={S.page}>
          {/* Session: date + gym — applies to all sets */}
          <div style={{...S.card, padding:"10px 14px", marginBottom:10}}>
            <div style={{...S.grid2}}>
              <div>
                <label style={S.label}>DATE</label>
                <input
                  type="date"
                  style={S.input}
                  value={sessionDate}
                  onChange={e => setSessionDate(e.target.value)}
                />
              </div>
              <div>
                <label style={S.label}>GYM</label>
                <select
                  style={S.select}
                  value={sessionCenter}
                  onChange={e => setSessionCenter(e.target.value)}
                >
                  <option value="">— CHOOSE GYM —</option>
                  {sheetCenters.map(c => <option key={c.name}>{c.name}</option>)}
                </select>
              </div>
            </div>
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
              {showImport ? "▲ CLOSE" : "↓ IMPORT EARLIER SESSION"}
            </button>
            {showImport && (
              <div style={{...S.card, marginTop:8, marginBottom:0}}>
                <label style={S.label}>CHOOSE EARLIER SESSION</label>
                <select
                  style={S.select}
                  value={importDay}
                  onChange={e => setImportDay(e.target.value)}
                >
                  <option value="">— CHOOSE DAY —</option>
                  {daysGrouped.map(d => (
                    <option key={d.date} value={d.date}>
                      {d.date} · {d.records.length} sets · {d.exercises.slice(0, 3).join(", ")}{d.exercises.length > 3 ? "…" : ""}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize:9, color:"#444", marginTop:8, letterSpacing:"0.05em", lineHeight:1.5 }}>
                  Copies all sets from the chosen day into the log. Date is set to {sessionDate}. Adjust kg/reps as you do them today.
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
              SESSION · {entries.length} {entries.length === 1 ? "set" : "sets"}
            </div>
            {entries.length > 1 && (
              <button
                style={{...S.btnGhost, padding:"4px 8px", fontSize:9}}
                onClick={() => setEntries(prev => {
                  const allCollapsed = prev.every(e => e.collapsed);
                  return prev.map(e => ({ ...e, collapsed: !allCollapsed }));
                })}
              >
                {entries.every(e => e.collapsed) ? "Expand all" : "Collapse all"}
              </button>
            )}
          </div>

          {entries.map((e, idx) => {
            const eLiveOrm = calc1RM(parseFloat(e.kg), parseInt(e.reps));
            const eBestOrm = getBest1RM(e.exercise, e.equipment, e.handle, sessionCenter);
            const eEquipForExercise = getEquipForExercise(e.exercise);
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
                            Not filled
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
                        aria-label="Remove set"
                        title="Remove set"
                      >×</button>
                    )}
                    <span style={{ color:"#444", fontSize:11 }}>{e.collapsed ? "▼" : "▲"}</span>
                  </div>
                </div>

                {/* Udfoldet form */}
                {!e.collapsed && (
                  <>
                    <div style={{ marginBottom:10 }}>
                      <label style={S.label}>EXERCISE</label>
                      <select style={S.select} value={e.exercise}
                        onChange={ev => updateEntry(e.id, { exercise: ev.target.value, equipment: "", handle: "" })}>
                        <option value="">— CHOOSE EXERCISE —</option>
                        {allExercises.map(ex => <option key={ex}>{ex}</option>)}
                      </select>
                    </div>

                    <div style={{ marginBottom:10 }}>
                      <label style={S.label}>EQUIPMENT</label>
                      <select style={S.select} value={e.equipment}
                        onChange={ev => updateEntry(e.id, {
                          equipment: ev.target.value,
                          // Nulstil handle hvis ikke CABLE TOWER
                          handle: ev.target.value === "CABLE TOWER" ? e.handle : "",
                        })}>
                        <option value="">— CHOOSE EQUIPMENT —</option>
                        {eEquipForExercise.map(eq => <option key={eq}>{eq}</option>)}
                      </select>
                    </div>

                    {/* Handle-dropdown vises kun for CABLE TOWER */}
                    {e.equipment === "CABLE TOWER" && (
                      <div style={{ marginBottom:10 }}>
                        <label style={S.label}>HANDLE</label>
                        <select style={S.select} value={e.handle || ""}
                          onChange={ev => updateEntry(e.id, { handle: ev.target.value })}>
                          <option value="">— CHOOSE HANDLE —</option>
                          {HANDLES.map(h => <option key={h}>{h}</option>)}
                        </select>
                      </div>
                    )}

                    {/* 1RM guide */}
                    {eBestOrm && (
                      <div style={S.orm}>
                        <div style={S.ormTitle}>BEST 1RM — {e.exercise} / {e.equipment}</div>
                        {[[40,"Warm-up"],[60,"Light"],[80,"Working"]].map(([pct, label]) => (
                          <div key={pct} style={S.ormRow}>
                            <span style={S.ormLabel}>{pct}% — {label}</span>
                            <span style={S.ormValue}>{Math.round(eBestOrm * pct / 100 * 2) / 2} kg</span>
                          </div>
                        ))}
                        <div style={{...S.ormRow, marginTop:6, borderTop:"1px solid #1a2e00", paddingTop:6}}>
                          <span style={S.ormLabel}>Best 1RM</span>
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
                        <label style={S.label}>REPS</label>
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
                        <label style={S.label}>REP RANGE</label>
                        <select style={S.select} value={e.repsGoal}
                          onChange={ev => updateEntry(e.id, { repsGoal: ev.target.value })}>
                          {REP_RANGES.map(r => <option key={r}>{r}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={S.label}>SET TYPE</label>
                        <select style={S.select} value={e.setType}
                          onChange={ev => updateEntry(e.id, { setType: ev.target.value })}>
                          {SET_TYPES.map(t => <option key={t}>{t}</option>)}
                        </select>
                      </div>
                    </div>

                    <div style={{ marginBottom:4 }}>
                      <label style={S.label}>NOTES</label>
                      <input type="text" style={S.input} placeholder="Optional..." value={e.notes}
                        onChange={ev => updateEntry(e.id, { notes: ev.target.value })} />
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {/* Add set button */}
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
            + ADD SET
          </button>

          {/* Gem-knap */}
          <button
            style={{...S.btn, width:"100%", opacity: saving ? 0.6 : 1}}
            onClick={handleSave}
            disabled={saving}
          >
            {saving
              ? "SAVING..."
              : `SAVE ${entries.length} ${entries.length === 1 ? "SET" : "SETS"}`}
          </button>

          <div style={{ fontSize:9, color:"#333", textAlign:"center", marginTop:6, letterSpacing:"0.08em" }}>
            Saved directly to Google Sheets
          </div>

          {/* Latest sets (this session, already saved) */}
          {localData.length > 0 && (
            <div style={{...S.card, marginTop:14}}>
              <div style={S.sectionTitle}>SESSION LOG</div>
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
            <input style={{...S.input, flex:1}} placeholder="Search exercise..." value={exSearch}
              onChange={e => setExSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => setShowAddEx(!showAddEx)}>+</button>
          </div>
          {showAddEx && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>NEW EXERCISE</label>
              <input style={{...S.input, marginBottom:8}} value={newExName}
                onChange={e => setNewExName(e.target.value)} placeholder="Name (e.g. BENCH PRESS)..." />
              <label style={S.label}>PRIMARY MUSCLE</label>
              <input style={{...S.input, marginBottom:8}} value={newExPrimary}
                onChange={e => setNewExPrimary(e.target.value)} placeholder="e.g. CHEST" />
              <label style={S.label}>SECONDARY MUSCLES</label>
              <input style={{...S.input, marginBottom:8}} value={newExSecondary}
                onChange={e => setNewExSecondary(e.target.value)} placeholder="e.g. TRICEPS, SHOULDERS (comma-separated)" />
              <label style={S.label}>EQUIPMENT</label>
              <input style={{...S.input, marginBottom:10}} value={newExEquipment}
                onChange={e => setNewExEquipment(e.target.value)} placeholder="e.g. BARBELL, DUMBBELLS (comma-separated)" />
              <div style={{ display:"flex", gap:8 }}>
                <button
                  style={{...S.btn, flex:1, opacity: savingEx ? 0.6 : 1}}
                  onClick={handleAddExercise}
                  disabled={savingEx || !newExName.trim()}
                >
                  {savingEx ? "SAVING..." : "SAVE"}
                </button>
                <button
                  style={S.btnGhost}
                  onClick={() => { setShowAddEx(false); setNewExName(""); setNewExPrimary(""); setNewExSecondary(""); setNewExEquipment(""); }}
                >Cancel</button>
              </div>
              <div style={{ fontSize:9, color:"#444", marginTop:8, letterSpacing:"0.05em" }}>
                Saved to the Exercises sheet. The equipment list determines which options you see when logging this exercise.
              </div>
            </div>
          )}
          {allExercises
            .filter(ex => ex.toLowerCase().includes(exSearch.toLowerCase()))
            .map(ex => {
              const key = expandedEx === ex;
              const eqList = [...new Set(allRecords.filter(r => r.exercise === ex).map(r => r.equipment).filter(Boolean))];
              const bestOrm = eqList.reduce((best, eq) => {
                const v = getBest1RM(ex, eq);
                return v && (!best || v > best) ? v : best;
              }, null);
              return (
                <div key={ex} style={S.card}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer" }}
                    onClick={() => setExpandedEx(key ? null : ex)}>
                    <div>
                      <div style={{ fontSize:13 }}>{ex}</div>
                      {eqList.length > 0 && <div style={{ fontSize:10, color:"#444", marginTop:2 }}>{eqList.length} equipment</div>}
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
                                PRIMARY: <span style={{ color:"#b8e840", fontWeight:600 }}>{m.primaryMuscle}</span>
                              </div>
                            )}
                            {m.secondaryMuscles && (
                              <div style={{ fontSize:10, color:"#888", letterSpacing:"0.1em" }}>
                                SECONDARY: <span style={{ color:"#6a8a30" }}>{m.secondaryMuscles}</span>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {/* Rep range dropdown */}
                      <div style={{ marginBottom:10 }}>
                        <label style={S.label}>REP RANGE</label>
                        <select style={S.select}>
                          {REP_RANGES.map(r => <option key={r}>{r}</option>)}
                        </select>
                      </div>
                      {/* Redskaber med 1RM */}
                      {eqList.length > 0 && (
                        <div style={{ marginBottom:10 }}>
                          <div style={S.label}>Redskaber</div>
                          {eqList.map(eq => {
                            const orm = getBest1RM(ex, eq);
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
                          Log set →
                        </button>
                        <button style={{...S.btnGhost, fontSize:10}}
                          onClick={() => { setStatsEx(ex); setView("insights"); setExpandedEx(null); }}>
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
            <input style={{...S.input, flex:1}} placeholder="Search equipment..." value={eqSearch}
              onChange={e => setEqSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => setShowAddEq(!showAddEq)}>+</button>
          </div>
          {showAddEq && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>NEW EQUIPMENT</label>
              <input style={{...S.input, marginBottom:10}} value={newEqName}
                onChange={e => setNewEqName(e.target.value)} placeholder="Name (e.g. Lat Pulldown Machine)..." />
              <div style={{ display:"flex", gap:8 }}>
                <button
                  style={{...S.btn, flex:1, opacity: savingEq ? 0.6 : 1}}
                  onClick={handleAddEquipment}
                  disabled={savingEq || !newEqName.trim()}
                >
                  {savingEq ? "SAVING..." : "SAVE"}
                </button>
                <button
                  style={S.btnGhost}
                  onClick={() => { setShowAddEq(false); setNewEqName(""); }}
                >Cancel</button>
              </div>
              <div style={{ fontSize:9, color:"#444", marginTop:8, letterSpacing:"0.05em" }}>
                Saved to the Equipment sheet. New equipment appears in all dropdowns.
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
                      {totalSets > 0 && <div style={{ fontSize:10, color:"#444", marginTop:2 }}>{totalSets} sets · {exercises.length} exercises</div>}
                    </div>
                    <span style={{ color:"#333", fontSize:12 }}>{key ? "▲" : "▼"}</span>
                  </div>
                  {key && (
                    <div style={{ marginTop:12, borderTop:"1px solid #1a1a1e", paddingTop:12 }}>
                      {exercises.length > 0 && (
                        <div style={{ marginBottom:10 }}>
                          <div style={S.label}>Øvelser du har lavet</div>
                          {exercises.map(ex => {
                            const orm = getBest1RM(ex, eq);
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
                        Log set with {eq} →
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {/* ── GYMS ── */}
      {view === "gyms" && (
        <div style={S.page}>
          <div style={{ display:"flex", gap:8, marginBottom:12 }}>
            <input style={{...S.input, flex:1}} placeholder="Search gym..." value={gymSearch}
              onChange={e => setGymSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => setShowAddGym(!showAddGym)}>+</button>
          </div>
          {showAddGym && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>NEW GYM</label>
              <input style={{...S.input, marginBottom:10}} value={newGymName}
                onChange={e => setNewGymName(e.target.value)} placeholder="Name (e.g. SATS NØRREBRO)..." />
              <div style={{ display:"flex", gap:8 }}>
                <button
                  style={{...S.btn, flex:1, opacity: savingGym ? 0.6 : 1}}
                  onClick={handleAddGym}
                  disabled={savingGym || !newGymName.trim()}
                >
                  {savingGym ? "SAVING..." : "SAVE"}
                </button>
                <button
                  style={S.btnGhost}
                  onClick={() => { setShowAddGym(false); setNewGymName(""); }}
                >Cancel</button>
              </div>
              <div style={{ fontSize:9, color:"#444", marginTop:8, letterSpacing:"0.05em" }}>
                Gemmes i Centre-arket. Nye gyms vises i dropdown'en når du logger.
              </div>
            </div>
          )}
          {sheetCenters
            .filter(c => !gymSearch || c.name.toLowerCase().includes(gymSearch.toLowerCase()))
            .map(c => {
              const setsHere = allRecords.filter(r => r.center === c.name).length;
              const exercisesHere = [...new Set(allRecords.filter(r => r.center === c.name).map(r => r.exercise).filter(Boolean))];
              return (
                <div key={c.name} style={S.card}>
                  <div style={{ fontSize:13, color:"#e4e4dc", fontWeight:600 }}>{c.name}</div>
                  <div style={{ fontSize:10, color:"#555", marginTop:4 }}>
                    {setsHere} sets · {exercisesHere.length} different exercises
                  </div>
                </div>
              );
            })}
          {!sheetCenters.length && (
            <div style={{ color:"#444", fontSize:12, textAlign:"center", marginTop:40 }}>
              No gyms yet. Add one with the + button above.
            </div>
          )}
        </div>
      )}

      {/* ── HISTORIK (grupperet pr. dag) ── */}
      {view === "history" && (
        <div style={S.page}>
          <div style={{...S.grid2, marginBottom:8}}>
            <select style={S.select} value={histEx} onChange={e => setHistEx(e.target.value)}>
              <option value="">All exercises</option>
              {allExercises.map(ex => <option key={ex}>{ex}</option>)}
            </select>
            <select style={S.select} value={histEq} onChange={e => setHistEq(e.target.value)}>
              <option value="">All equipment</option>
              {allEquipment.map(eq => <option key={eq}>{eq}</option>)}
            </select>
          </div>
          <select style={{...S.select, marginBottom:12, width:"100%"}} value={histCenter} onChange={e => setHistCenter(e.target.value)}>
            <option value="">All gyms</option>
            {sheetCenters.map(c => <option key={c.name}>{c.name}</option>)}
          </select>
          {(() => {
            // Filtrér dage så de kun viser sæt der matcher filter (og skjul dage uden match)
            const filteredDays = daysGrouped
              .map(d => ({
                ...d,
                records: d.records.filter(r =>
                  (!histEx || r.exercise === histEx) &&
                  (!histEq || r.equipment === histEq) &&
                  (!histCenter || r.center === histCenter)
                ),
              }))
              .filter(d => d.records.length > 0)
              .slice(0, 60);

            if (!filteredDays.length) {
              return (
                <div style={{ color:"#444", fontSize:12, textAlign:"center", marginTop:40 }}>
                  No sets match filter
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
                        {(() => {
                          const centersForDay = [...new Set(day.records.map(r => r.center).filter(Boolean))];
                          const centerLabel = centersForDay.length === 1 ? centersForDay[0]
                            : centersForDay.length > 1 ? `${centersForDay.length} centre` : "";
                          return (
                            <>
                              {day.records.length} sets · {exercisesForDay.slice(0, 3).join(", ")}{exercisesForDay.length > 3 ? "…" : ""}
                              {centerLabel && <span style={{ color:"#4a6a00", marginLeft:4 }}> · {centerLabel}</span>}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    <span style={{ color:"#444", fontSize:12, flexShrink:0, marginLeft:8 }}>{isOpen ? "▲" : "▼"}</span>
                  </div>

                  {/* Sæt-liste for dagen */}
                  {isOpen && (
                    <div style={{ marginTop:10, borderTop:"1px solid #1a1a1e", paddingTop:8 }}>
                      {day.records.map((r, i) => {
                        const isPR = r.oneRepMax && getBest1RM(r.exercise, r.equipment, r.handle, r.center) === r.oneRepMax;
                        return (
                          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #161618" }}>
                            <div style={{ minWidth:0, flex:1 }}>
                              <div style={{ fontSize:12, color:"#e4e4dc" }}>
                                {r.exercise}
                                {isPR && <span style={{...S.tagGreen, marginLeft:6}}>PR</span>}
                              </div>
                              <div style={{ fontSize:10, color:"#444", marginTop:1 }}>
                                {r.equipment}{r.handle ? ` · ${r.handle}` : ""}
                                {r.center && <span style={{ color:"#4a6a00" }}> · {r.center}</span>}
                              </div>
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
      {view === "insights" && (
        <div style={S.page}>
          <div style={{ marginBottom:12 }}>
            <label style={S.label}>EXERCISE</label>
            <select style={S.select} value={statsEx} onChange={e => setStatsEx(e.target.value)}>
              <option value="">— CHOOSE EXERCISE —</option>
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
      No data for {exercise}
    </div>
  );

  return (
    <div>
      {equipment.map(eq => {
        const recs = records.filter(r => r.equipment === eq).slice(0, 20).reverse();
        // Aggregat: max på tværs af alle handle/center varianter for denne (exercise, equipment)
        const prefix = `${exercise}||${eq}||`;
        let best = null;
        for (const key in best1RMMap) {
          if (key.startsWith(prefix)) {
            const v = best1RMMap[key];
            if (best == null || v > best) best = v;
          }
        }
        return (
          <div key={eq} style={{ marginBottom:20 }}>
            <div style={{ fontSize:11, color:"#b8e840", letterSpacing:"0.1em", marginBottom:8 }}>{eq}</div>
            {best && (
              <div style={{ background:"#0c1800", border:"1px solid #1a2e00", borderRadius:8, padding:"10px 12px", marginBottom:10 }}>
                <div style={{ fontSize:9, color:"#4a6a00", letterSpacing:"0.12em", marginBottom:6 }}>BEST 1RM: {best} kg</div>
                {[[40,"Warm-up"],[60,"Light"],[80,"Working"]].map(([pct, label]) => (
                  <div key={pct} style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                    <span style={{ fontSize:10, color:"#555" }}>{pct}% — {label}</span>
                    <span style={{ fontSize:11, color:"#b8e840", fontWeight:600 }}>{Math.round(best * pct / 100 * 2) / 2} kg</span>
                  </div>
                ))}
              </div>
            )}
            {/* Simpel progressionskurve */}
            <ProgressChart records={recs} />
            {/* Latest sets */}
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
