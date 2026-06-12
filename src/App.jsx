import { useState, useMemo, useCallback, useEffect, useRef } from "react";

// ─── GOOGLE APPS SCRIPT ENDPOINT ──────────────────────────────────────────────
// Apps Script deployed som Web App. Læser og skriver alle data via dette ene endpoint.
// Sæt URL'en ind her efter du har deployet scriptet (se SHEETS_WRITE_SETUP.md).
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzBJ4_R4nTNkHmRLk6u-5IURCiz8KaEoLt3iN-S8NrdjRurZTdEASZUZvZcs_-Ko2sM/exec";

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

// Hent alt data fra Apps Script (sæt, øvelser, redskaber, centre, handles, plans)
async function fetchAllData() {
  if (!isAppsScriptConfigured()) {
    const sets = await fetchSetsFromCSV();
    return { sets, exercises: [], equipment: [], centers: [], handles: [], plans: [], videos: [] };
  }
  let res;
  try {
    res = await fetch(APPS_SCRIPT_URL, { cache: "no-store", redirect: "follow" });
  } catch (e) {
    throw new Error(`Network error: ${e.message || e}`);
  }
  if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
  const text = await res.text();
  if (text.trim().startsWith("<")) {
    console.error("Apps Script returned HTML — first 500:", text.slice(0, 500));
    throw new Error("Apps Script returned HTML instead of JSON. Check that deployment access = 'Anyone' and that the script is redeployed.");
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.error("JSON parse failed. Raw response:", text.slice(0, 500));
    throw new Error(`Apps Script returned invalid JSON: ${text.slice(0, 100)}`);
  }
  if (json.error) throw new Error(`Apps Script error: ${json.error}`);
  return {
    sets: Array.isArray(json.sets) ? json.sets : [],
    best1RMMap: json.best1RMMap || {},
    exercises: Array.isArray(json.exercises) ? json.exercises : [],
    equipment: Array.isArray(json.equipment) ? json.equipment : [],
    centers: Array.isArray(json.centers) ? json.centers : [],
    handles: Array.isArray(json.handles) ? json.handles : [],
    plans: Array.isArray(json.plans) ? json.plans : [],
    videos: Array.isArray(json.videos) ? json.videos : [],
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

// Gemmer ALLE sessionens sæt i ÉT kald (ét request, atomisk skrivning i arket).
// Returnerer { ok, saved } — saved er antal rækker bekræftet skrevet af Apps Script.
async function logSetBatchToSheet(sets) {
  if (!isAppsScriptConfigured()) {
    console.warn("Apps Script URL ikke konfigureret");
    return { ok: false, saved: 0 };
  }
  const payloadSets = sets.map(function(set) {
    return {
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
    };
  });
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ type: "set_batch", sets: payloadSets }),
      redirect: "follow",
    });
    if (!res.ok) throw new Error("Apps Script HTTP " + res.status);
    var json = null;
    try { json = await res.json(); } catch (parseErr) { json = null; }
    if (json && json.ok === false) throw new Error(json.error || "Batch save failed");
    var saved = (json && typeof json.saved === "number") ? json.saved : payloadSets.length;
    return { ok: true, saved: saved };
  } catch (e) {
    console.error("Apps Script batch skrive-fejl:", e);
    return { ok: false, saved: 0 };
  }
}

async function saveExerciseToSheet(exercise) {
  return postToAppsScript({
    type: "exercise",
    name: exercise.name,
    primaryMuscle: exercise.primaryMuscle || "",
    secondaryMuscles: exercise.secondaryMuscles || "",
    equipment: exercise.equipment || "",
    defaultRepRange: exercise.defaultRepRange || "",
  });
}

async function updateExerciseRepRange(name, defaultRepRange) {
  return postToAppsScript({
    type: "exercise_update_rep_range",
    name,
    defaultRepRange,
  });
}

async function saveVideoToSheet(exercise, equipment, url) {
  return postToAppsScript({
    type: "video_save",
    exercise,
    equipment: equipment || "",
    url: url || "",
  });
}

async function saveHandleToSheet(handle) {
  return postToAppsScript({
    type: "handle",
    name: handle.name,
    equipment: handle.equipment || "",
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
  if (reps === 1) return parseFloat(kg.toFixed(1));
  return parseFloat((kg * (1 + reps / 30)).toFixed(1));
}

function normalizeKg(kg, equipment) {
  if (!equipment) return kg;
  return equipment.toLowerCase().includes("dumbbell") ? kg * 2 : kg;
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────
function toDisplay(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}
function fromDisplay(display) {
  if (!display) return "";
  const [d, m, y] = display.split("/");
  return d && m && y ? `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}` : display;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ─── YOUTUBE HELPERS ──────────────────────────────────────────────────────────
// Parser YouTube URL → embed URL. Understøtter youtu.be, watch?v=, /embed/
function getYouTubeEmbedUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    let id = null;
    if (u.hostname === "youtu.be") {
      id = u.pathname.slice(1).split("?")[0];
    } else if (u.hostname.includes("youtube.com")) {
      if (u.pathname.includes("/embed/")) {
        id = u.pathname.split("/embed/")[1].split("?")[0];
      } else {
        id = u.searchParams.get("v");
      }
    }
    if (id) return `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1`;
  } catch(e) {}
  return null;
}

// ─── REP RANGE HELPERS ────────────────────────────────────────────────────────
function parseRepRange(str) {
  if (!str) return { min: "", max: "" };
  const clean = str.replace(/\s*sek\.?\s*$/i, "").trim();
  const dashIdx = clean.lastIndexOf("-");
  // Undgå at splitte på "30-60 sek." ved negativt indeks
  if (dashIdx > 0) return { min: clean.slice(0, dashIdx).trim(), max: clean.slice(dashIdx + 1).trim() };
  return { min: clean, max: "" };
}
function buildRepRange(min, max) {
  const m = String(min || "").trim();
  const x = String(max || "").trim();
  if (!m && !x) return "";
  if (!x) return m;
  return `${m}-${x}`;
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

// Farver pr. set type — bruges i collapsed badge så typer er visuelt adskilte.
const SET_TYPE_COLORS = {
  "NORMAL SET": { bg: "var(--accent-bg-mid)", fg: "var(--accent)" },
  "WARM-UP SET": { bg: "#2a2200", fg: "#e8c840" },
  "DROP SET": { bg: "#2a1200", fg: "#e88040" },
  "AMRAP": { bg: "#1a0a2a", fg: "#b080e8" },
};

// Handles til CABLE TOWER. Bruges som ekstra valg når redskab = CABLE TOWER.
const HANDLES = ["ROPE", "BAR", "CLOSE GRIP HANDLE", "WIDE GRIP HANDLE"];
const REP_RANGES = ["1-3","3-5","4-5","5","5-8","6-8","8-10","8-12","10-12","10-15","12-15","15-20","20-30","30-60 sek."];

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app: {
    minHeight:"100vh", background:"var(--bg)", color:"var(--text-primary)",
    fontFamily:"'DM Mono', monospace", maxWidth:480, margin:"0 auto",
    paddingBottom:80,
  },
  header: {
    padding:"16px 16px 0", borderBottom:"1px solid var(--border-subtle)",
    background:"var(--bg)", position:"sticky", top:0, zIndex:10,
  },
  title: {
    fontSize:11, letterSpacing:"0.2em", color:"var(--accent)", fontWeight:600,
    textTransform:"uppercase", marginBottom:12,
  },
  nav: {
    display:"flex", gap:0, overflowX:"auto",
  },
  navBtn: (active) => ({
    flex:"none", padding:"8px 14px", fontSize:10, letterSpacing:"0.15em",
    fontFamily:"'DM Mono', monospace", border:"none", borderRadius:0,
    background:"none", cursor:"pointer", fontWeight:600,
    color: active ? "var(--accent)" : "var(--text-faint)",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    transition:"all 0.15s",
  }),
  page: { padding:"16px" },
  card: {
    background:"var(--card)", border:"1px solid var(--border)", borderRadius:10,
    padding:14, marginBottom:10,
  },
  label: {
    fontSize:9, letterSpacing:"0.15em", color:"var(--text-label)", textTransform:"uppercase",
    display:"block", marginBottom:4,
  },
  input: {
    width:"100%", background:"var(--bg)", border:"1px solid var(--border-input)",
    borderRadius:6, padding:"8px 10px", color:"var(--text-primary)",
    fontFamily:"'DM Mono', monospace", fontSize:16, boxSizing:"border-box",
    outline:"none",
  },
  select: {
    width:"100%", background:"var(--bg)", border:"1px solid var(--border-input)",
    borderRadius:6, padding:"8px 10px", color:"var(--text-primary)",
    fontFamily:"'DM Mono', monospace", fontSize:16, boxSizing:"border-box",
  },
  btn: {
    background:"var(--accent)", color:"var(--bg)", border:"none", borderRadius:6,
    padding:"10px 16px", fontSize:11, letterSpacing:"0.1em", fontWeight:700,
    cursor:"pointer", fontFamily:"'DM Mono', monospace",
  },
  btnGhost: {
    background:"none", color:"var(--text-dim)", border:"1px solid var(--border-input)", borderRadius:6,
    padding:"8px 12px", fontSize:10, letterSpacing:"0.1em",
    cursor:"pointer", fontFamily:"'DM Mono', monospace",
  },
  grid2: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 },
  tag: {
    display:"inline-block", fontSize:9, padding:"3px 7px",
    background:"var(--border)", borderRadius:4, color:"var(--text-muted)",
    letterSpacing:"0.08em",
  },
  tagGreen: {
    display:"inline-block", fontSize:9, padding:"3px 7px",
    background:"var(--accent-bg-mid)", borderRadius:4, color:"var(--accent)",
    letterSpacing:"0.08em",
  },
  orm: {
    background:"var(--accent-bg)", border:"1px solid var(--accent-border)", borderRadius:8,
    padding:"10px 12px", marginTop:8,
  },
  ormTitle: { fontSize:9, color:"var(--accent-dim)", letterSpacing:"0.12em", marginBottom:6 },
  ormRow: { display:"flex", justifyContent:"space-between", marginBottom:3 },
  ormLabel: { fontSize:10, color:"var(--text-label)" },
  ormValue: { fontSize:11, color:"var(--accent)", fontWeight:600 },
  section: { marginBottom:16 },
  sectionTitle: {
    fontSize:9, letterSpacing:"0.2em", color:"var(--text-faint)", textTransform:"uppercase",
    marginBottom:8, borderBottom:"1px solid var(--border-subtle)", paddingBottom:6,
  },
  toast: {
    position:"fixed", bottom:90, left:"50%", transform:"translateX(-50%)",
    background:"var(--accent)", color:"var(--bg)", padding:"10px 20px",
    borderRadius:8, fontSize:11, fontWeight:700, letterSpacing:"0.1em",
    zIndex:50, whiteSpace:"nowrap",
  },
  toastErr: {
    position:"fixed", bottom:90, left:"50%", transform:"translateX(-50%)",
    background:"var(--error-bg)", color:"var(--error)", padding:"10px 20px", border:"1px solid var(--error-border)",
    borderRadius:8, fontSize:11, fontWeight:700, letterSpacing:"0.1em",
    zIndex:50, whiteSpace:"nowrap",
  },
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("log");
  const [localData, setLocalData] = useState([]);
  const [toast, setToast] = useState(null); // { msg, ok }

  // ── Theme toggle ──
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('st-theme');
    if (saved) return saved;
    return prefersDark ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    localStorage.setItem('st-theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  }, []);

  // ── Google Sheets data ──
  const [sheetData, setSheetData] = useState([]);
  const [serverBest1RMMap, setServerBest1RMMap] = useState({}); // præ-aggregeret fra server
  const [sheetExercises, setSheetExercises] = useState([]); // [{name, primaryMuscle, secondaryMuscles, equipment, defaultRepRange}]
  const [sheetEquipment, setSheetEquipment] = useState([]); // [{name}]
  const [sheetCenters, setSheetCenters] = useState([]); // [{name}]
  const [sheetHandles, setSheetHandles] = useState([]); // [{name, equipment}]
  const [sheetPlans, setSheetPlans] = useState([]); // [{name, sets:[{exercise, equipment, handle, kg, reps, repsGoal, setType, notes, order}]}]
  const [sheetVideos, setSheetVideos] = useState([]); // [{exercise, equipment, url}]
  const [sheetLoading, setSheetLoading] = useState(true);
  const [sheetError, setSheetError] = useState(null);

  // LOG state — multi-sæt session builder med auto-save draft
  const today = todayISO();

  // Hjælpefunktion til at læse draft
  const getDraft = () => {
    try {
      const d = JSON.parse(localStorage.getItem('st-draft') || 'null');
      // Brug kun draft hvis det er fra i dag
      return (d && d.sessionDate === todayISO()) ? d : null;
    } catch(e) { return null; }
  };

  const [sessionDate, setSessionDate] = useState(() => getDraft()?.sessionDate || today);
  const [sessionCenter, setSessionCenter] = useState(() => getDraft()?.sessionCenter || "");
  const newSetId = () => `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const blankEntry = () => ({
    id: newSetId(),
    exercise: "", equipment: "", handle: "", kg: "", reps: "",
    repsGoal: "8-10", setType: "NORMAL SET", notes: "",
    collapsed: false, showExtras: false, showVideo: false,
  });
  const [entries, setEntries] = useState(() => {
    const draft = getDraft();
    return (draft?.entries?.length > 0) ? draft.entries : [];
  });
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importDay, setImportDay] = useState("");

  // Auto-save draft til localStorage ved enhver ændring af session
  useEffect(() => {
    try {
      const hasData = entries.some(e => e.exercise || e.kg || e.reps);
      if (hasData) {
        localStorage.setItem('st-draft', JSON.stringify({ sessionDate, sessionCenter, entries }));
      }
    } catch(e) {}
  }, [entries, sessionDate, sessionCenter]);

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
  const [newExRepMin, setNewExRepMin] = useState("8");
  const [newExRepMax, setNewExRepMax] = useState("12");
  const [savingEx, setSavingEx] = useState(false);

  // REDSKABER state
  const [eqSearch, setEqSearch] = useState("");
  const [expandedEq, setExpandedEq] = useState(null);
  const [showAddEq, setShowAddEq] = useState(false);
  const [newEqName, setNewEqName] = useState("");
  const [newEqHandles, setNewEqHandles] = useState("");
  const [savingEq, setSavingEq] = useState(false);

  // GYMS (centre) state
  const [gymSearch, setGymSearch] = useState("");
  const [showAddGym, setShowAddGym] = useState(false);
  const [newGymName, setNewGymName] = useState("");
  const [savingGym, setSavingGym] = useState(false);

  // HANDLES (under equipment) state
  const [showAddHandle, setShowAddHandle] = useState(null);
  const [newHandleName, setNewHandleName] = useState("");
  const [savingHandle, setSavingHandle] = useState(false);

  const handleAddHandle = useCallback(async (equipmentName) => {
    const name = newHandleName.trim().toUpperCase();
    if (!name) return;
    setSavingHandle(true);
    const ok = await saveHandleToSheet({ name, equipment: equipmentName });
    if (ok) {
      setSheetHandles(prev => {
        if (prev.some(h => h.name === name && h.equipment === equipmentName)) return prev;
        return [...prev, { name, equipment: equipmentName }];
      });
      setNewHandleName("");
      setShowAddHandle(null);
      showToast(`Handle "${name}" ADDED ✓`, true);
    } else {
      showToast("COULD NOT SAVE HANDLE — TRY AGAIN", false);
    }
    setSavingHandle(false);
  }, [newHandleName]);

  // WORKOUT PLAN state
  const [planSearch, setPlanSearch] = useState("");
  const [expandedPlan, setExpandedPlan] = useState(null);
  const [planName, setPlanName] = useState("");
  const [planSets, setPlanSets] = useState([{
    id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    exercise: "", equipment: "", handle: "",
    kg: "", reps: "",
    repsGoal: "8-10", setType: "NORMAL SET", notes: "",
  }]);
  const [savingPlan, setSavingPlan] = useState(false);
  const [editingPlanName, setEditingPlanName] = useState(null); // null = ny plan, string = navn på plan der redigeres

  const newPlanSetId = () => `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const updatePlanSet = useCallback((id, updates) => {
    setPlanSets(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);
  const removePlanSet = useCallback((id) => {
    setPlanSets(prev => prev.length > 1 ? prev.filter(s => s.id !== id) : prev);
  }, []);
  const movePlanSet = useCallback((id, dir) => {
    setPlanSets(prev => {
      const idx = prev.findIndex(s => s.id === id);
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  }, []);
  const addPlanSet = useCallback(() => {
    setPlanSets(prev => {
      const last = prev[prev.length - 1];
      return [...prev, {
        id: newPlanSetId(),
        exercise: last?.exercise || "",
        equipment: last?.equipment || "",
        handle: last?.handle || "",
        kg: "", reps: "",
        repsGoal: last?.repsGoal || "8-10",
        setType: last?.setType || "NORMAL SET",
        notes: "",
      }];
    });
  }, []);

  const handleSavePlan = useCallback(async () => {
    const name = planName.trim();
    if (!name) { showToast("NAME YOUR PROGRAM BEFORE SAVING", false); return; }
    const validSets = planSets.filter(s => s.exercise);
    if (!validSets.length) { showToast("ADD AT LEAST ONE SET BEFORE SAVING", false); return; }
    setSavingPlan(true);

    // Hvis vi redigerer og har omdøbt planen — slet den gamle
    if (editingPlanName && editingPlanName !== name) {
      await postToAppsScript({ type: "plan_delete", name: editingPlanName });
      setSheetPlans(prev => prev.filter(p => p.name !== editingPlanName));
    }

    const setsPayload = validSets.map((s, i) => ({
      order: i + 1,
      exercise: s.exercise, equipment: s.equipment, handle: s.handle || "",
      kg: s.kg || "", reps: s.reps || "", repsGoal: s.repsGoal || "",
      setType: s.setType || "NORMAL SET", notes: s.notes || "",
    }));
    const ok = await postToAppsScript({ type: "plan_save", name, sets: setsPayload });
    if (ok) {
      setSheetPlans(prev => {
        const filtered = prev.filter(p => p.name !== name && p.name !== editingPlanName);
        return [...filtered, { name, sets: setsPayload }];
      });
      setPlanName("");
      setPlanSets([{ id: newPlanSetId(), exercise: "", equipment: "", handle: "", kg: "", reps: "", repsGoal: "8-10", setType: "NORMAL SET", notes: "" }]);
      setEditingPlanName(null);
      showToast(editingPlanName ? `PROGRAM "${name}" UPDATED ✓` : `PROGRAM "${name}" SAVED ✓`, true);
      setView("existing-plans");
    } else {
      showToast("COULD NOT SAVE PROGRAM — TRY AGAIN", false);
    }
    setSavingPlan(false);
  }, [planName, planSets, editingPlanName]);

  const handleDeletePlan = useCallback(async (name) => {
    if (!confirm(`Delete plan "${name}"?`)) return;
    const ok = await postToAppsScript({ type: "plan_delete", name });
    if (ok) {
      setSheetPlans(prev => prev.filter(p => p.name !== name));
      showToast(`PROGRAM "${name}" DELETED`, true);
    } else {
      showToast("COULD NOT DELETE PROGRAM — TRY AGAIN", false);
    }
  }, []);

  // Import plan into LOG
  const importPlan = useCallback((planName) => {
    const plan = sheetPlans.find(p => p.name === planName);
    if (!plan || !plan.sets || !plan.sets.length) return;
    const imported = plan.sets
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(s => ({
        id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        exercise: s.exercise || "",
        equipment: s.equipment || "",
        handle: s.handle || "",
        kg: s.kg != null ? String(s.kg) : "",
        reps: s.reps != null ? String(s.reps) : "",
        repsGoal: s.repsGoal || "8-10",
        setType: s.setType || "NORMAL SET",
        notes: s.notes || "",
        collapsed: true,
      }));
    setEntries(prev => {
      const isOnlyBlank = prev.length === 1 && !prev[0].exercise && !prev[0].kg && !prev[0].reps;
      if (isOnlyBlank) return imported;
      const collapsedExisting = prev.map(e => ({ ...e, collapsed: true }));
      return [...collapsedExisting, ...imported];
    });
    setShowImportPlan(false);
    showToast(`Plan "${planName}" loaded — ADJUST WEIGHT AND REPS`, true);
  }, [sheetPlans]);

  const [showImportPlan, setShowImportPlan] = useState(false);
  const [importPlanName, setImportPlanName] = useState("");
  const [showImportSessionToPlan, setShowImportSessionToPlan] = useState(false);
  const [importSessionForPlan, setImportSessionForPlan] = useState("");

  // HISTORIK state
  const [histEx, setHistEx] = useState("");
  const [histEq, setHistEq] = useState("");
  const [histCenter, setHistCenter] = useState("");
  const [expandedDay, setExpandedDay] = useState(null);
  const [historyEditKey, setHistoryEditKey] = useState(null); // "date_idx"
  const [historyEditData, setHistoryEditData] = useState(null);

  const handleHistorySave = useCallback(async (original, edited, editKey) => {
    const updatedRecord = {
      ...original,
      kg: parseFloat(edited.kg) || original.kg,
      reps: parseInt(edited.reps) || original.reps,
      notes: edited.notes ?? original.notes,
      oneRepMax: calc1RM(parseFloat(edited.kg) || original.kg, parseInt(edited.reps) || original.reps),
    };
    // Send update til Apps Script
    const ok = await postToAppsScript({
      type: "set_update",
      // Nøgle: original data til at finde rækken
      original: {
        dato: original.date,
        oevelse: original.exercise,
        redskab: original.equipment,
        handle: original.handle || "",
        center: original.center || "",
        kg: String(original.kg ?? ""),
        reps: String(original.reps ?? ""),
      },
      // Ny data
      updated: {
        kg: String(updatedRecord.kg),
        reps: String(updatedRecord.reps),
        notes: updatedRecord.notes || "",
        orm: String(updatedRecord.oneRepMax || ""),
      },
    });
    if (ok) {
      // Opdater lokalt i sheetData
      setSheetData(prev => prev.map(r => {
        if (r.date === original.date
          && r.exercise === original.exercise
          && r.equipment === original.equipment
          && String(r.kg) === String(original.kg)
          && String(r.reps) === String(original.reps)) {
          return updatedRecord;
        }
        return r;
      }));
      showToast("SET UPDATED ✓", true);
    } else {
      showToast("COULD NOT UPDATE SET — TRY AGAIN", false);
    }
    setHistoryEditKey(null);
    setHistoryEditData(null);
  }, []);

  // STATS state + lazy loading
  const [statsEx, setStatsEx] = useState("");
  const [exerciseDetailCache, setExerciseDetailCache] = useState({});
  const [loadingDetail, setLoadingDetail] = useState(false);

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
      .then(({ sets, best1RMMap, exercises, equipment, centers, handles, plans, videos }) => {
        if (cancelled) return;
        setSheetData(sets);
        if (best1RMMap && Object.keys(best1RMMap).length) setServerBest1RMMap(best1RMMap);
        setSheetExercises(exercises);
        setSheetEquipment(equipment);
        setSheetCenters(centers || []);
        setSheetHandles(handles || []);
        setSheetPlans(plans || []);
        setSheetVideos(videos || []);
        setSheetError(null);
      })
      .catch(err => {
        if (cancelled) return;
        console.error("Sheet fetch failed:", err);
        setSheetError(err.message || "COULD NOT LOAD DATA");
      })
      .finally(() => { if (!cancelled) setSheetLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── Manuel refresh af alle sheet-data ──
  const refreshSheet = useCallback(async () => {
    setSheetLoading(true);
    try {
      const { sets, best1RMMap, exercises, equipment, centers, handles, plans, videos } = await fetchAllData();
      setSheetData(sets);
      if (best1RMMap && Object.keys(best1RMMap).length) setServerBest1RMMap(best1RMMap);
      setSheetExercises(exercises);
      setSheetEquipment(equipment);
      setSheetCenters(centers || []);
      setSheetHandles(handles || []);
      setSheetPlans(plans || []);
      setSheetVideos(videos || []);
      setSheetError(null);
      showToast(`${sets.length} SETS LOADED ✓`, true);
    } catch (err) {
      console.error(err);
      setSheetError(err.message || "Error");
      showToast("COULD NOT LOAD DATA", false);
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
      defaultRepRange: buildRepRange(newExRepMin, newExRepMax),
    });
    if (ok) {
      setSheetExercises(prev => {
        if (prev.some(e => e.name.toLowerCase() === name.toLowerCase())) return prev;
        return [...prev, {
          name,
          primaryMuscle: newExPrimary.trim(),
          secondaryMuscles: newExSecondary.trim(),
          equipment: newExEquipment.trim(),
          defaultRepRange: buildRepRange(newExRepMin, newExRepMax),
            }];
      });
      setNewExName(""); setNewExPrimary(""); setNewExSecondary(""); setNewExEquipment(""); setNewExRepMin("8"); setNewExRepMax("12");
      setShowAddEx(false);
      showToast(`"${name}" ADDED ✓`, true);
    } else {
      setCustomExercises(p => [...p, name]);
      setNewExName(""); setNewExPrimary(""); setNewExSecondary(""); setNewExEquipment(""); setNewExRepMin("8"); setNewExRepMax("12");
      setShowAddEx(false);
      showToast("⚠ ERROR WHILE SAVING · DATA SAVED LOCALLY", false);
    }
    setSavingEx(false);
  }, [newExName, newExPrimary, newExSecondary, newExEquipment, buildRepRange(newExRepMin, newExRepMax)]);

  // Update default rep range for an existing exercise
  const handleUpdateRepRange = useCallback(async (exName, newRange) => {
    const ok = await updateExerciseRepRange(exName, newRange);
    if (ok) {
      setSheetExercises(prev => prev.map(e =>
        e.name === exName ? { ...e, defaultRepRange: newRange } : e
      ));
      showToast(`Rep range updated for ${exName}`, true);
    } else {
      showToast("COULD NOT UPDATE REP RANGE — TRY AGAIN", false);
    }
  }, []);

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
      // Gem handles hvis angivet
      if (newEqHandles.trim()) {
        const handles = newEqHandles.split(",").map(h => h.trim().toUpperCase()).filter(Boolean);
        for (const h of handles) {
          await saveHandleToSheet({ name: h, equipment: name });
          setSheetHandles(prev => {
            if (prev.some(x => x.name === h && x.equipment === name)) return prev;
            return [...prev, { name: h, equipment: name }];
          });
        }
      }
      setNewEqName("");
      setNewEqHandles("");
      setShowAddEq(false);
      showToast(`"${name}" ADDED ✓`, true);
    } else {
      setNewEqName("");
      setNewEqHandles("");
      setShowAddEq(false);
      showToast("⚠ ERROR · TRY AGAIN", false);
    }
    setSavingEq(false);
  }, [newEqName, newEqHandles]);

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
      showToast(`"${name}" ADDED ✓`, true);
    } else {
      setNewGymName("");
      setShowAddGym(false);
      showToast("⚠ ERROR · TRY AGAIN", false);
    }
    setSavingGym(false);
  }, [newGymName]);

  // ── best1RM map ──
  // Nøgle: exercise|equipment|handle|center — så samme øvelse på forskellig handle/center
  // best1RMMap: merger server-præ-aggregeret (dækker alle sæt) med lokalt beregnet (dækker recent + nye)
  const best1RMMap = useMemo(() => {
    // Start med server-aggregat (dækker hele historikken)
    const map = { ...serverBest1RMMap };
    // Merge med lokalt beregnede (seneste sæt + ny session-data)
    for (const r of allRecords) {
      if (!r.exercise || !r.equipment || !r.oneRepMax) continue;
      const key = `${r.exercise}||${r.equipment}||${r.handle||""}||${r.center||""}`;
      if (!map[key] || r.oneRepMax > map[key]) map[key] = r.oneRepMax;
    }
    return map;
  }, [allRecords, serverBest1RMMap]);

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

  // ── Lazy loading til INSIGHTS ──
  const loadExerciseDetail = useCallback(async (exercise) => {
    if (!exercise) return;
    if (exerciseDetailCache[exercise]) return;
    if (!isAppsScriptConfigured()) return;
    setLoadingDetail(true);
    try {
      const url = `${APPS_SCRIPT_URL}?type=exercise_detail&exercise=${encodeURIComponent(exercise)}`;
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const text = await res.text();
        if (!text.trim().startsWith("<")) {
          const json = JSON.parse(text);
          if (json.sets) setExerciseDetailCache(prev => ({ ...prev, [exercise]: json.sets }));
        }
      }
    } catch (e) {
      console.error("Exercise detail fetch failed:", e);
    } finally {
      setLoadingDetail(false);
    }
  }, [exerciseDetailCache]);

  const getRecordsForExercise = useCallback((exercise) => {
    if (exerciseDetailCache[exercise]) return exerciseDetailCache[exercise];
    return allRecords.filter(r => r.exercise === exercise);
  }, [exerciseDetailCache, allRecords]);

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

  // Få handles for et specifikt redskab — merger sheet + hardcoded fallback
  const getHandlesForEquipment = useCallback((equipmentName) => {
    if (!equipmentName) return [];
    const fromSheet = sheetHandles
      .filter(h => !h.equipment || h.equipment === equipmentName)
      .map(h => h.name)
      .filter(Boolean);
    // For CABLE TOWER: merger med default handles hvis sheet er tomt
    if (equipmentName === "CABLE TOWER" && fromSheet.length === 0) {
      return [...HANDLES];
    }
    // Find også handles der er brugt i historik for dette equipment
    const fromHistory = [...new Set(
      allRecords.filter(r => r.equipment === equipmentName && r.handle).map(r => r.handle)
    )];
    return [...new Set([...fromSheet, ...fromHistory])].sort();
  }, [sheetHandles, allRecords]);

  // Map øvelsesnavn → muskelgruppe-info, redskaber og default rep range (fra Øvelser-arket)
  const exerciseMuscleMap = useMemo(() => {
    const map = {};
    for (const e of sheetExercises) {
      if (e.name) map[e.name] = {
        primaryMuscle: e.primaryMuscle || "",
        secondaryMuscles: e.secondaryMuscles || "",
        equipment: e.equipment || "",
        defaultRepRange: e.defaultRepRange || "",
      };
    }
    return map;
  }, [sheetExercises]);

  // Video lookup: [{exercise, equipment, handle, url}] — henter URL pr. (øvelse, redskab, handle)
  const getVideoUrl = useCallback((exercise, equipment, handle) => {
    if (!exercise) return null;
    const eq = equipment || "";
    const h = handle || "";
    // 1. Præcist match: øvelse + redskab + handle
    const exact = sheetVideos.find(v => v.exercise === exercise && v.equipment === eq && (v.handle||"") === h);
    if (exact) return exact.url;
    // 2. Match: øvelse + redskab (ingen handle)
    if (h) {
      const withoutHandle = sheetVideos.find(v => v.exercise === exercise && v.equipment === eq && !v.handle);
      if (withoutHandle) return withoutHandle.url;
    }
    // 3. Generel: kun øvelse
    return sheetVideos.find(v => v.exercise === exercise && !v.equipment)?.url || null;
  }, [sheetVideos]);

  // Helper: hvilke øvelser er lavet med et givet redskab? (rettelse 8)
  const getExercisesForEquipment = useCallback((equipmentName) => {
    if (!equipmentName) return [];
    // 1) Fra øvelses-masterlistens equipment-kolonne
    const fromMaster = sheetExercises
      .filter(e => e.name && (e.equipment || "").split(",").map(s => s.trim()).filter(Boolean).includes(equipmentName))
      .map(e => e.name);
    // 2) Fra faktisk historik
    const fromHistory = [...new Set(allRecords.filter(r => r.equipment === equipmentName && r.exercise).map(r => r.exercise))];
    return [...new Set([...fromMaster, ...fromHistory])].sort();
  }, [sheetExercises, allRecords]);

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

  // Koblede filter-lister til WORKOUT HISTORY (rettelse 9):
  // - Hvis et equipment er valgt, vis kun øvelser brugt med det.
  // - Hvis en øvelse er valgt, vis kun equipment brugt til den.
  const histExerciseOptions = useMemo(() => {
    if (!histEq) return allExercises;
    const used = getExercisesForEquipment(histEq);
    return used.length ? used : allExercises;
  }, [histEq, allExercises, getExercisesForEquipment]);

  const histEquipmentOptions = useMemo(() => {
    if (!histEx) return allEquipment;
    const used = getEquipForExercise(histEx);
    return used.length ? used : allEquipment;
  }, [histEx, allEquipment, getEquipForExercise]);

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
      showToast("FILL IN EXERCISE, WEIGHT AND REPS FOR EACH SET", false);
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
    // Send ALLE sæt i ÉT batch-kald — undgår at overbelaste Apps Script med
    // mange samtidige requests (årsagen til at kun nogle sæt blev gemt).
    const result = await logSetBatchToSheet(records);
    setSaving(false);
    if (!result.ok) {
      // Intet blev skrevet til arket. Behold ALLE sæt + draft så intet går tabt,
      // og lad brugeren prøve igen.
      showToast("⚠ ERROR · NOTHING SAVED — SETS KEPT, TRY AGAIN", false);
      return;
    }
    // Succes: gem lokalt, nulstil til ét tomt sæt (husk smart defaults), ryd draft.
    setLocalData(prev => [...prev, ...records]);
    const last = entries[entries.length - 1];
    setEntries([{
      ...blankEntry(),
      exercise: last.exercise,
      equipment: last.equipment,
      handle: last.handle || "",
      repsGoal: last.repsGoal,
      setType: last.setType,
    }]);
    try { localStorage.removeItem('st-draft'); } catch(e) {}
    showToast(`${result.saved} SETS SAVED ✓`, true);
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
    showToast(`${imported.length} SETS DUPLICATED — ADJUST WEIGHT AND REPS`, true);
  }, [daysGrouped]);

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Bebas+Neue&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={S.header}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div style={{...S.title, marginBottom:0}}>⚡ STRENGTH TRACKER</div>
          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              style={{
                background:"none", border:"1px solid var(--border-input)",
                borderRadius:6, cursor:"pointer", padding:"3px 7px",
                fontSize:12, lineHeight:1, color:"var(--text-dim)",
              }}
            >
              {theme === 'dark' ? '☀' : '🌙'}
            </button>
            <button
              onClick={refreshSheet}
              disabled={sheetLoading}
              title={sheetError ? `Error: ${sheetError}` : `${sheetData.length} sets loaded from Sheets`}
              style={{
                background:"none", border:"none", cursor:"pointer",
                fontSize:9, letterSpacing:"0.1em",
                color: sheetError ? "var(--error)" : sheetLoading ? "var(--text-dim)" : "var(--accent-dim)",
                fontFamily:"'DM Mono', monospace",
                padding:"4px 8px",
                opacity: sheetLoading ? 0.6 : 1,
              }}
            >
              {sheetLoading
                ? "↻ LOADING..."
                : sheetError
                  ? "⚠ ERROR · TRY AGAIN"
                  : `↻ ${sheetData.length} SETS`}
            </button>
          </div>
        </div>
        <div style={S.nav}>
          {[["log","LOG WORKOUT"],["resources","RESOURCES"],["plans","PROGRAM"],["performance","PERFORMANCE"]].map(([k,l]) => (
            <button key={k} style={S.navBtn(view===k || (k==="resources" && (view==="exercises" || view==="equipment" || view==="gyms")) || (k==="plans" && (view==="existing-plans" || view==="create-plan")) || (k==="performance" && (view==="history" || view==="insights")))} onClick={() => setView(k === "resources" ? "exercises" : k === "plans" ? "existing-plans" : k === "performance" ? "history" : k)}>{l}</button>
          ))}
        </div>
        {/* Sub-nav for RESOURCES */}
        {(view==="exercises" || view==="equipment" || view==="gyms") && (
          <div style={{...S.nav, marginTop:8, paddingLeft:8, borderLeft:"2px solid var(--accent-border)"}}>
            {[["exercises","EXERCISES"],["equipment","EQUIPMENT"],["gyms","GYMS"]].map(([k,l]) => (
              <button key={k} style={{...S.navBtn(view===k), fontSize:10}} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
        )}
        {/* Sub-nav for WORKOUT PLAN */}
        {(view==="existing-plans" || view==="create-plan") && (
          <div style={{...S.nav, marginTop:8, paddingLeft:8, borderLeft:"2px solid var(--accent-border)"}}>
            {[["existing-plans","EXISTING PROGRAMS"],["create-plan","NEW PROGRAM"]].map(([k,l]) => (
              <button key={k} style={{...S.navBtn(view===k), fontSize:10}} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
        )}
        {/* Sub-nav for PERFORMANCE */}
        {(view==="history" || view==="insights") && (
          <div style={{...S.nav, marginTop:8, paddingLeft:8, borderLeft:"2px solid var(--accent-border)"}}>
            {[["history","HISTORY"],["insights","INSIGHTS"]].map(([k,l]) => (
              <button key={k} style={{...S.navBtn(view===k), fontSize:10}} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
        )}
      </div>

      {/* Fejl-banner — vises under header når data ikke kan hentes */}
      {sheetError && (
        <div style={{
          background:"var(--error-bg)", border:"1px solid var(--error-border)", borderRadius:6,
          padding:"10px 12px", margin:"0 0 12px 0",
          fontSize:11, color:"var(--error-light)", lineHeight:1.5,
        }}>
          <div style={{ fontWeight:600, marginBottom:4, color:"var(--error)" }}>Could not load data from Google Sheets</div>
          <div style={{ fontSize:10, color:"var(--error-muted)" }}>{sheetError}</div>
          <div style={{ fontSize:9, color:"var(--error-dim)", marginTop:6, letterSpacing:"0.05em" }}>
            ⚠ ERROR WHILE FETCHING DATA
          </div>
        </div>
      )}

      {/* ── LOG (multi-set session builder) ── */}
      {view === "log" && (
        <div style={S.page}>
          {/* Draft-indikator: vises når der er et auto-gemt draft */}
          {entries.some(e => e.exercise || e.kg || e.reps) && (
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 10px", marginBottom:8, background:"var(--accent-bg)", border:"1px solid var(--accent-border)", borderRadius:6 }}>
              <div style={{ fontSize:9, color:"var(--accent-dim)", letterSpacing:"0.08em" }}>
                DRAFT AUTO-SAVED · {entries.filter(e => e.exercise).length} SET{entries.filter(e => e.exercise).length !== 1 ? "S" : ""}
              </div>
              <button
                style={{ background:"none", border:"none", cursor:"pointer", fontSize:9, color:"var(--text-faint)", fontFamily:"'DM Mono', monospace", letterSpacing:"0.06em", padding:"2px 4px" }}
                onClick={() => {
                  setEntries([blankEntry()]);
                  setSessionDate(todayISO());
                  setSessionCenter("");
                  try { localStorage.removeItem('st-draft'); } catch(e) {}
                }}>
                CLEAR ✕
              </button>
            </div>
          )}
          {/* Session: date + gym — applies to all sets */}
          <div style={{...S.card, padding:"12px 14px", marginBottom:10}}>
            <div style={S.grid2}>
              <div>
                <label style={S.label}>DATE</label>
                <input
                  type="text"
                  style={S.input}
                  placeholder="DD/MM/YYYY"
                  value={toDisplay(sessionDate)}
                  onChange={e => {
                    const iso = fromDisplay(e.target.value);
                    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) setSessionDate(iso);
                    else if (e.target.value.length <= 10) setSessionDate(iso || sessionDate);
                  }}
                  maxLength={10}
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

          {/* Import: tidligere session eller plan */}
          <div style={{ display:"flex", gap:8, marginBottom:10 }}>
            <button
              style={{
                ...S.btnGhost,
                flex:1,
                padding:"10px",
                fontSize:10,
                letterSpacing:"0.1em",
                color: showImport ? "var(--accent)" : "var(--text-muted)",
                borderColor: showImport ? "var(--accent-border)" : "var(--border-input)",
              }}
              onClick={() => { setShowImport(s => !s); setShowImportPlan(false); }}
            >
              {showImport ? "▲ CLOSE" : "+ DUPLICATE WORKOUT"}
            </button>
            <button
              style={{
                ...S.btnGhost,
                flex:1,
                padding:"10px",
                fontSize:10,
                letterSpacing:"0.1em",
                color: showImportPlan ? "var(--accent)" : "var(--text-muted)",
                borderColor: showImportPlan ? "var(--accent-border)" : "var(--border-input)",
              }}
              onClick={() => { setShowImportPlan(s => !s); setShowImport(false); }}
            >
              {showImportPlan ? "▲ CLOSE" : "+ DUPLICATE PROGRAM"}
            </button>
          </div>
          {showImport && (
            <div style={{...S.card, marginBottom:10}}>
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
              <div style={{ fontSize:9, color:"var(--text-faint)", marginTop:8, letterSpacing:"0.05em", lineHeight:1.5 }}>
                Copies all sets from the chosen day into the log. Date is set to {toDisplay(sessionDate)}. Adjust kg/reps as you do them today.
              </div>
              <button
                style={{...S.btn, width:"100%", marginTop:10, opacity: importDay ? 1 : 0.4}}
                onClick={() => importFromDay(importDay)}
                disabled={!importDay}
              >
                IMPORT →
              </button>
            </div>
          )}
          {showImportPlan && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>CHOOSE PLAN</label>
              <select
                style={S.select}
                value={importPlanName}
                onChange={e => setImportPlanName(e.target.value)}
              >
                <option value="">— CHOOSE PLAN —</option>
                {sheetPlans.map(p => (
                  <option key={p.name} value={p.name}>
                    {p.name} · {p.sets ? p.sets.length : 0} sets
                  </option>
                ))}
              </select>
              <div style={{ fontSize:9, color:"var(--text-faint)", marginTop:8, letterSpacing:"0.05em", lineHeight:1.5 }}>
                Loads all sets from the plan as templates. Adjust kg/reps to what you actually do.
              </div>
              <button
                style={{...S.btn, width:"100%", marginTop:10, opacity: importPlanName ? 1 : 0.4}}
                onClick={() => importPlan(importPlanName)}
                disabled={!importPlanName}
              >
                IMPORT →
              </button>
            </div>
          )}

          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <div style={{...S.sectionTitle, marginBottom:0, border:"none", padding:0}}>
              WORKOUT · {entries.length} {entries.length === 1 ? "SET" : "SETS"}
            </div>
            {entries.length > 1 && (
              <button
                style={{...S.btnGhost, padding:"4px 8px", fontSize:9}}
                onClick={() => setEntries(prev => {
                  const allCollapsed = prev.every(e => e.collapsed);
                  return prev.map(e => ({ ...e, collapsed: !allCollapsed }));
                })}
              >
                {entries.every(e => e.collapsed) ? "EXPAND ALL" : "COLLAPSE ALL"}
              </button>
            )}
          </div>

          {entries.map((e, idx) => {
            const eLiveOrm = calc1RM(parseFloat(e.kg), parseInt(e.reps));
            const eBestOrm = getBest1RM(e.exercise, e.equipment, e.handle, sessionCenter);
            const eEquipForExercise = getEquipForExercise(e.exercise);
            const isComplete = e.exercise && e.kg && e.reps;

            // Badge-label: DROP SET viser kun type, andre viser "N TYPE"
            const setTypeCounts = {};
            for (let i = 0; i <= idx; i++) {
              const t = entries[i].setType || "NORMAL SET";
              setTypeCounts[t] = (setTypeCounts[t] || 0) + 1;
            }
            const thisType = e.setType || "NORMAL SET";
            const typeCount = setTypeCounts[thisType];
            const badgeLabel = thisType === "DROP SET"
              ? "DROP SET"
              : `${typeCount} ${thisType}`;

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
                      fontSize:9, letterSpacing:"0.12em",
                      color: (SET_TYPE_COLORS[thisType] || SET_TYPE_COLORS["NORMAL SET"]).fg,
                      background: (SET_TYPE_COLORS[thisType] || SET_TYPE_COLORS["NORMAL SET"]).bg,
                      padding:"3px 7px", borderRadius:4, fontWeight:600,
                      flexShrink:0, whiteSpace:"nowrap",
                    }}>
                      {badgeLabel}
                    </span>
                    {e.collapsed ? (
                      // Kompakt overblik når collapsed
                      <div style={{ minWidth:0, flex:1, overflow:"hidden" }}>
                        {isComplete ? (
                          <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:11 }}>
                            <span style={{ color:"var(--text-primary)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                              {e.exercise}
                            </span>
                            <span style={{ color:"var(--accent)", fontWeight:600, whiteSpace:"nowrap" }}>
                              {e.kg}×{e.reps}
                            </span>
                          </div>
                        ) : (
                          <div style={{ fontSize:11, color:"var(--text-label)", fontStyle:"italic" }}>
                            Not filled
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize:11, color:"var(--text-dim)" }}>
                        {isComplete ? "Filled" : "Fill fields ↓"}
                      </div>
                    )}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
                    {entries.length > 1 && (
                      <button
                        onClick={(ev) => { ev.stopPropagation(); removeSet(e.id); }}
                        style={{
                          background:"none", border:"none", color:"var(--text-label)",
                          fontSize:16, cursor:"pointer", padding:"0 4px", lineHeight:1,
                          fontFamily:"'DM Mono', monospace",
                        }}
                        aria-label="Remove set"
                        title="Remove set"
                      >×</button>
                    )}
                    <span style={{ color:"var(--text-faint)", fontSize:11 }}>{e.collapsed ? "▼" : "▲"}</span>
                  </div>
                </div>

                {/* Udfoldet form */}
                {!e.collapsed && (
                  <>
                    <div style={{ marginBottom:10 }}>
                      <label style={S.label}>EXERCISE</label>
                      <select style={S.select} value={e.exercise}
                        onChange={ev => {
                          const newEx = ev.target.value;
                          const meta = exerciseMuscleMap[newEx];
                          updateEntry(e.id, {
                            exercise: newEx,
                            equipment: "",
                            handle: "",
                            // Overskriv kun repsGoal hvis sættet bruger en øvelses-default
                            // (dvs. ikke fra plan eller import)
                            repsGoal: (meta && meta.defaultRepRange) || e.repsGoal || "8-10",
                          });
                        }}>
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
                          {getHandlesForEquipment("CABLE TOWER").map(h => <option key={h}>{h}</option>)}
                        </select>
                      </div>
                    )}

                    <div style={{...S.grid2, margin:"10px 0"}}>
                      <div>
                        <label style={S.label}>WEIGHT</label>
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
                      <div style={{ fontSize:10, color:"var(--accent)", textAlign:"right", marginBottom:8, letterSpacing:"0.08em" }}>
                        ESTIMATED 1RM: <strong>{eLiveOrm} kg</strong>
                      </div>
                    )}

                    {/* REP RANGE read-only */}
                    {e.repsGoal && (
                      <div style={{ marginBottom:10, padding:"6px 10px", background:"var(--accent-bg)", border:"1px solid var(--accent-border)", borderRadius:4 }}>
                        <div style={{ fontSize:9, color:"var(--accent-dim)", letterSpacing:"0.1em" }}>
                          REP RANGE: <span style={{ color:"var(--accent)", fontWeight:600 }}>{e.repsGoal}</span>
                        </div>
                      </div>
                    )}

                    {/* SET TYPE — altid synlig */}
                    <div style={{ marginBottom:10 }}>
                      <label style={S.label}>SET TYPE</label>
                      <select style={S.select} value={e.setType}
                        onChange={ev => updateEntry(e.id, { setType: ev.target.value })}>
                        {SET_TYPES.map(t => <option key={t}>{t}</option>)}
                      </select>
                    </div>

                    {/* NOTES + 1RM guide + video under ⋯ MORE */}
                    {(() => {
                      const hasExtra = e.notes;
                      const videoUrl = getVideoUrl(e.exercise, e.equipment, e.handle);
                      return (
                        <>
                          <div style={{ display:"flex", gap:6, marginBottom: e.showExtras ? 10 : 0, flexWrap:"wrap", alignItems:"center" }}>
                            {/* Notes badge */}
                            {e.notes && (
                              <span style={{ ...S.tag, fontSize:9, maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                📝 {e.notes}
                              </span>
                            )}
                            {/* Video badge */}
                            {videoUrl && (
                              <button
                                style={{ ...S.tag, fontSize:9, color:"var(--error-mid)", background:"none",
                                  border:`1px solid var(--error-border)`, cursor:"pointer",
                                  fontFamily:"'DM Mono', monospace", letterSpacing:"0.06em" }}
                                onClick={ev => { ev.stopPropagation(); updateEntry(e.id, { showVideo: !e.showVideo }); }}>
                                {e.showVideo ? "▶ HIDE VIDEO" : "▶ VIDEO"}
                              </button>
                            )}
                            {/* Toggle MORE */}
                            <button
                              style={{ background:"none", border:"none", cursor:"pointer", fontSize:9, color:"var(--text-faint)", padding:"3px 6px", letterSpacing:"0.06em", fontFamily:"'DM Mono', monospace" }}
                              onClick={() => updateEntry(e.id, { showExtras: !e.showExtras })}>
                              {e.showExtras ? "▲ LESS" : `⋯ MORE${hasExtra || eBestOrm ? " ●" : ""}`}
                            </button>
                          </div>
                          {/* Embedded YouTube video */}
                          {e.showVideo && videoUrl && (
                            getYouTubeEmbedUrl(videoUrl) ? (
                              <div style={{ marginTop:12, marginBottom:8, borderRadius:8, overflow:"hidden", background:"#000", aspectRatio:"16/9" }}>
                                <iframe
                                  src={getYouTubeEmbedUrl(videoUrl)}
                                  style={{ width:"100%", height:"100%", border:"none", display:"block" }}
                                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                  allowFullScreen
                                  title="Exercise video"
                                />
                              </div>
                            ) : (
                              <a href={videoUrl} target="_blank" rel="noopener noreferrer"
                                style={{ display:"block", fontSize:10, color:"var(--error-mid)", marginTop:12, marginBottom:8 }}>
                                {"▶ Open video ↗"}
                              </a>
                            )
                          )}
                          {e.showExtras && (
                            <div style={{ borderTop:"1px solid var(--border-faint)", paddingTop:10, marginTop:4 }}>
                              {/* 1RM guide under MORE */}
                              {eBestOrm && (
                                <div style={{...S.orm, marginBottom:10}}>
                                  <div style={S.ormTitle}>BEST 1RM — {e.exercise} / {e.equipment}</div>
                                  {[[40,"WARM-UP SET"],[60,"LIGHT SET"],[80,"WORKING SET"]].map(([pct, label]) => (
                                    <div key={pct} style={S.ormRow}>
                                      <span style={S.ormLabel}>{pct}% — {label}</span>
                                      <span style={S.ormValue}>{Math.round(eBestOrm * pct / 100 * 2) / 2} kg</span>
                                    </div>
                                  ))}
                                  <div style={{...S.ormRow, marginTop:6, borderTop:"1px solid var(--accent-border)", paddingTop:6}}>
                                    <span style={S.ormLabel}>BEST 1RM</span>
                                    <span style={{...S.ormValue, fontSize:13}}>{eBestOrm} kg</span>
                                  </div>
                                </div>
                              )}
                              <div style={{ marginBottom:4 }}>
                                <label style={S.label}>NOTES</label>
                                <input type="text" style={S.input} placeholder="SET NOTES (OPTIONAL)" value={e.notes}
                                  onChange={ev => updateEntry(e.id, { notes: ev.target.value })} />
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()}
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
              color:"var(--accent)",
              borderColor:"var(--accent-border)",
              borderStyle:"dashed",
              background:"transparent",
              marginBottom:10,
            }}
            onClick={addSet}
          >
            + ADD SET
          </button>

          {entries.length === 0 && (
            <div style={{...S.card, textAlign:"center", padding:"24px 14px", marginBottom:10}}>
              <div style={{ fontSize:12, color:"var(--text-muted)", marginBottom:4 }}>{"No sets yet"}</div>
              <div style={{ fontSize:10, color:"var(--text-faint)", letterSpacing:"0.05em" }}>
                {"Tap + ADD SET to start, or DUPLICATE an earlier workout."}
              </div>
            </div>
          )}

          {/* Gem-knap */}
          {entries.length > 0 && (
            <button
              style={{...S.btn, width:"100%", opacity: saving ? 0.6 : 1}}
              onClick={handleSave}
              disabled={saving}
            >
              {saving
                ? "SAVING..."
                : "SAVE " + entries.length + " " + (entries.length === 1 ? "SET" : "SETS")}
            </button>
          )}


          {/* Latest sets (this session, already saved) */}
          {localData.length > 0 && (
            <div style={{...S.card, marginTop:14}}>
              <div style={S.sectionTitle}>SESSION LOG</div>
              {[...localData].reverse().map((r, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #161618" }}>
                  <div>
                    <div style={{ fontSize:12, color:"var(--text-primary)" }}>{r.exercise}</div>
                    <div style={{ fontSize:10, color:"var(--text-label)" }}>{r.equipment} · {r.date}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:13, color:"var(--accent)", fontWeight:600 }}>{r.kg} kg × {r.reps}</div>
                    {r.oneRepMax && <div style={{ fontSize:9, color:"var(--text-faint)" }}>1RM ~{r.oneRepMax}</div>}
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
            <input style={{...S.input, flex:1}} placeholder="SEARCH EXERCISE…" value={exSearch}
              onChange={e => setExSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => setShowAddEx(!showAddEx)}>+</button>
          </div>
          {showAddEx && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>NEW EXERCISE</label>
              <input style={{...S.input, marginBottom:8}} value={newExName}
                onChange={e => setNewExName(e.target.value)} placeholder="NAME (E.G. BENCH PRESS)" />
              <label style={S.label}>PRIMARY MUSCLE</label>
              <input style={{...S.input, marginBottom:8}} value={newExPrimary}
                onChange={e => setNewExPrimary(e.target.value)} placeholder="E.G. CHEST" />
              <label style={S.label}>SECONDARY MUSCLES</label>
              <input style={{...S.input, marginBottom:8}} value={newExSecondary}
                onChange={e => setNewExSecondary(e.target.value)} placeholder="COMMA-SEPARATED — E.G. TRICEPS, SHOULDERS..." />
              <label style={S.label}>EQUIPMENT</label>
              <input style={{...S.input, marginBottom:8}} value={newExEquipment}
                onChange={e => setNewExEquipment(e.target.value)} placeholder="COMMA-SEPARATED — E.G. BARBELL, DUMBBELLS..." />
              <label style={S.label}>DEFAULT REP RANGE</label>
              <div style={{...S.grid2, marginBottom:8}}>
                <input type="number" style={S.input} value={newExRepMin} placeholder="MINIMUM — E.G. 8"
                  onChange={e => setNewExRepMin(e.target.value)} />
                <input type="number" style={S.input} value={newExRepMax} placeholder="MAXIMUM — E.G. 12"
                  onChange={e => setNewExRepMax(e.target.value)} />
              </div>

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
                  onClick={() => { setShowAddEx(false); setNewExName(""); setNewExPrimary(""); setNewExSecondary(""); setNewExEquipment(""); setNewExRepMin("8"); setNewExRepMax("12"); }}
                >Cancel</button>
              </div>
              <div style={{ fontSize:9, color:"var(--text-faint)", marginTop:8, letterSpacing:"0.05em" }}>
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
                      {eqList.length > 0 && <div style={{ fontSize:10, color:"var(--text-faint)", marginTop:2 }}>{eqList.length} equipment</div>}
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {bestOrm && <span style={S.tagGreen}>{bestOrm} kg 1RM</span>}
                      <span style={{ color:"var(--text-dim)", fontSize:12 }}>{key ? "▲" : "▼"}</span>
                    </div>
                  </div>
                  {key && (
                    <div style={{ marginTop:12, borderTop:"1px solid var(--border-subtle)", paddingTop:12 }}>
                      {/* Muskelgrupper (hvis kendt) */}
                      {(() => {
                        const m = exerciseMuscleMap[ex];
                        if (!m || (!m.primaryMuscle && !m.secondaryMuscles)) return null;
                        return (
                          <div style={{ marginBottom:12, padding:"8px 10px", background:"var(--accent-bg)", borderRadius:4, border:"1px solid var(--accent-border)" }}>
                            {m.primaryMuscle && (
                              <div style={{ fontSize:10, color:"var(--text-muted)", letterSpacing:"0.1em", marginBottom:4 }}>
                                PRIMARY MUSCLES WORKED: <span style={{ color:"var(--accent)", fontWeight:600 }}>{m.primaryMuscle}</span>
                              </div>
                            )}
                            {m.secondaryMuscles && (
                              <div style={{ fontSize:10, color:"var(--text-muted)", letterSpacing:"0.1em" }}>
                                SECONDARY MUSCLES WORKED: <span style={{ color:"var(--accent-dim)" }}>{m.secondaryMuscles}</span>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {/* Default rep range — lokal state, gem med knap */}
                      <div style={{ marginBottom:10 }}>
                        <label style={S.label}>DEFAULT REP RANGE</label>
                        <RepRangeEditor
                          initialValue={(exerciseMuscleMap[ex] && exerciseMuscleMap[ex].defaultRepRange) || ""}
                          onSave={newRange => handleUpdateRepRange(ex, newRange)}
                        />
                      </div>
                      {/* Video URLs — pr. (redskab + handle) */}
                      <div style={{ marginBottom:10 }}>
                        <label style={S.label}>VIDEOS</label>
                        <div style={{ fontSize:9, color:"var(--text-faint)", marginBottom:6, letterSpacing:"0.04em" }}>
                          Add a YouTube link per equipment/handle combination. Shown as ▶ VIDEO in LOG.
                        </div>
                        {/* Byg kombinationer fra historik + eksisterende videoer */}
                        {(() => {
                          // Find alle (equipment, handle) kombinationer for denne øvelse
                          const combos = [];
                          const seen = new Set();
                          // Fra historik
                          allRecords.filter(r => r.exercise === ex).forEach(r => {
                            const key = `${r.equipment||""}::${r.handle||""}`;
                            if (!seen.has(key)) { seen.add(key); combos.push({ equipment: r.equipment||"", handle: r.handle||"" }); }
                          });
                          // Fra eksisterende videoer (kan have kombinationer der ikke er i de 90 dage)
                          sheetVideos.filter(v => v.exercise === ex).forEach(v => {
                            const key = `${v.equipment||""}::${v.handle||""}`;
                            if (!seen.has(key)) { seen.add(key); combos.push({ equipment: v.equipment||"", handle: v.handle||"" }); }
                          });
                          // Tilføj "ingen redskab" fallback
                          if (!seen.has("::")) combos.push({ equipment: "", handle: "" });

                          return combos.sort((a, b) => a.equipment.localeCompare(b.equipment) || a.handle.localeCompare(b.handle)).map(({ equipment: eq, handle: h }) => {
                            const existingUrl = sheetVideos.find(v => v.exercise === ex && v.equipment === eq && (v.handle||"") === h)?.url || "";
                            return (
                              <VideoRow
                                key={`${eq}::${h}`}
                                exercise={ex} equipment={eq} handle={h}
                                existingUrl={existingUrl}
                                onSave={(url) => {
                                  postToAppsScript({ type:"video_save", exercise: ex, equipment: eq, handle: h, url })
                                    .then(ok => {
                                      if (ok) {
                                        setSheetVideos(prev => {
                                          const filtered = prev.filter(v => !(v.exercise === ex && v.equipment === eq && (v.handle||"") === h));
                                          return url ? [...filtered, { exercise: ex, equipment: eq, handle: h, url }] : filtered;
                                        });
                                        showToast(url ? "VIDEO SAVED ✓" : "VIDEO REMOVED", true);
                                      } else {
                                        showToast("COULD NOT SAVE VIDEO — TRY AGAIN", false);
                                      }
                                    });
                                }}
                              />
                            );
                          });
                        })()}
                      </div>
                      {/* Redskaber med 1RM */}
                      {eqList.length > 0 && (
                        <div style={{ marginBottom:10 }}>
                          <div style={S.label}>Redskaber</div>
                          {eqList.map(eq => {
                            const orm = getBest1RM(ex, eq);
                            return (
                              <div key={eq} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid #161618" }}>
                                <button style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"var(--accent)", fontSize:11, fontFamily:"'DM Mono', monospace", letterSpacing:"0.05em" }}
                                  onClick={() => { setExpandedEq(eq); setView("equipment"); }}>
                                  {eq} ↗
                                </button>
                                {orm && <span style={{ fontSize:11, color:"var(--text-label)" }}>{orm} kg 1RM</span>}
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
            <input style={{...S.input, flex:1}} placeholder="SEARCH EQUIPMENT…" value={eqSearch}
              onChange={e => setEqSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => setShowAddEq(!showAddEq)}>+</button>
          </div>
          {showAddEq && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>NEW EQUIPMENT</label>
              <input style={{...S.input, marginBottom:8}} value={newEqName}
                onChange={e => setNewEqName(e.target.value)} placeholder="NAME — E.G. LAT PULLDOWN MACHINE" />
              <label style={S.label}>HANDLES / GRIPS (optional)</label>
              <input style={{...S.input, marginBottom:10}} value={newEqHandles}
                onChange={e => setNewEqHandles(e.target.value)} placeholder="COMMA-SEPARATED — E.G. WIDE GRIP, ROPE, V-BAR..." />
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
                  onClick={() => { setShowAddEq(false); setNewEqName(""); setNewEqHandles(""); }}
                >Cancel</button>
              </div>
              <div style={{ fontSize:9, color:"var(--text-faint)", marginTop:8, letterSpacing:"0.05em" }}>
                Saved to the Equipment sheet. Handles saved to the Handles sheet.
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
                      {totalSets > 0 && <div style={{ fontSize:10, color:"var(--text-faint)", marginTop:2 }}>{totalSets} sets · {exercises.length} exercises</div>}
                    </div>
                    <span style={{ color:"var(--text-dim)", fontSize:12 }}>{key ? "▲" : "▼"}</span>
                  </div>
                  {key && (
                    <div style={{ marginTop:12, borderTop:"1px solid var(--border-subtle)", paddingTop:12 }}>
                      {/* Handles-administration: vises for alle redskaber */}
                      {(() => {
                        const handles = getHandlesForEquipment(eq);
                        const hasHandleHistory = allRecords.some(r => r.equipment === eq && r.handle);
                        // Vis handles-sektion hvis: CABLE TOWER, eller redskabet har handles i historik, eller sheet-handles
                        const showHandles = eq === "CABLE TOWER" || hasHandleHistory || handles.length > 0;
                        if (!showHandles) return null;
                        return (
                          <div style={{ marginBottom:14 }}>
                            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                              <div style={S.label}>HANDLES / GRIPS</div>
                              <button style={{...S.btnGhost, fontSize:10, padding:"3px 8px"}}
                                onClick={(ev) => { ev.stopPropagation(); setShowAddHandle(showAddHandle === eq ? null : eq); }}>
                                + ADD
                              </button>
                            </div>
                            {showAddHandle === eq && (
                              <div style={{ background:"var(--accent-bg)", border:"1px solid var(--accent-border)", borderRadius:4, padding:"8px 10px", marginBottom:8 }}>
                                <input style={{...S.input, marginBottom:6}} value={newHandleName}
                                  onChange={(ev) => setNewHandleName(ev.target.value)}
                                  placeholder="COMMA-SEPARATED — E.G. WIDE GRIP, ROPE, V-BAR..." />
                                <div style={{ display:"flex", gap:6 }}>
                                  <button style={{...S.btn, flex:1, fontSize:10, padding:"6px"}}
                                    disabled={savingHandle || !newHandleName.trim()}
                                    onClick={() => handleAddHandle(eq)}>
                                    {savingHandle ? "SAVING..." : "SAVE"}
                                  </button>
                                  <button style={{...S.btnGhost, fontSize:10}}
                                    onClick={() => { setShowAddHandle(null); setNewHandleName(""); }}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                            {handles.map(h => {
                              const setsWithHandle = allRecords.filter(r => r.equipment === eq && r.handle === h).length;
                              return (
                                <div key={h} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid var(--border-faint)" }}>
                                  <span style={{ fontSize:11, color:"var(--text-secondary)" }}>{h}</span>
                                  <span style={{ fontSize:10, color:"var(--text-faint)" }}>{setsWithHandle} sets</span>
                                </div>
                              );
                            })}
                            {handles.length === 0 && (
                              <div style={{ fontSize:10, color:"var(--text-faint)", padding:"6px 0" }}>
                                No handles yet — add one above.
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {exercises.length > 0 && (
                        <div style={{ marginBottom:10 }}>
                          <div style={S.label}>EXERCISES YOU'VE DONE</div>
                          {exercises.map(ex => {
                            const orm = getBest1RM(ex, eq);
                            return (
                              <div key={ex} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid #161618" }}>
                                <button style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"var(--text-secondary)", fontSize:11, fontFamily:"'DM Mono', monospace" }}
                                  onClick={() => { setExpandedEx(ex); setView("exercises"); setExpandedEq(null); }}>
                                  {ex}
                                </button>
                                {orm && <span style={{ fontSize:11, color:"var(--text-label)" }}>{orm} kg 1RM</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <button style={{...S.btnGhost, width:"100%", fontSize:10, marginBottom:8}}
                        onClick={() => {
                          setNewExEquipment(eq);
                          setShowAddEx(true);
                          setExpandedEq(null);
                          setView("exercises");
                        }}>
                        {"+ ADD EXERCISE FOR " + eq}
                      </button>
                      <button style={{...S.btn, width:"100%", fontSize:10}}
                        onClick={() => { setEntry(p => ({...p, equipment: eq})); setView("log"); setExpandedEq(null); }}>
                        {"LOG SET WITH " + eq + " →"}
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
            <input style={{...S.input, flex:1}} placeholder="SEARCH GYM…" value={gymSearch}
              onChange={e => setGymSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => setShowAddGym(!showAddGym)}>+</button>
          </div>
          {showAddGym && (
            <div style={{...S.card, marginBottom:10}}>
              <label style={S.label}>NEW GYM</label>
              <input style={{...S.input, marginBottom:10}} value={newGymName}
                onChange={e => setNewGymName(e.target.value)} placeholder="NAME — E.G. FITNESS ADELGADE" />
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
              <div style={{ fontSize:9, color:"var(--text-faint)", marginTop:8, letterSpacing:"0.05em" }}>
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
                  <div style={{ fontSize:13, color:"var(--text-primary)", fontWeight:600 }}>{c.name}</div>
                  <div style={{ fontSize:10, color:"var(--text-label)", marginTop:4 }}>
                    {setsHere} sets · {exercisesHere.length} different exercises
                  </div>
                </div>
              );
            })}
          {!sheetCenters.length && (
            <div style={{ color:"var(--text-faint)", fontSize:12, textAlign:"center", marginTop:40 }}>
              No gyms yet. Add one with the + button above.
            </div>
          )}
        </div>
      )}

      {/* ── EXISTING PLANS ── */}
      {view === "existing-plans" && (
        <div style={S.page}>
          <div style={{ display:"flex", gap:8, marginBottom:12 }}>
            <input style={{...S.input, flex:1}} placeholder="SEARCH PROGRAMS…" value={planSearch}
              onChange={e => setPlanSearch(e.target.value)} />
            <button style={S.btnGhost} onClick={() => {
              setEditingPlanName(null);
              setPlanName("");
              setPlanSets([{
                id: `p_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
                exercise: "", equipment: "", handle: "",
                kg: "", reps: "", repsGoal: "8-10", setType: "NORMAL SET", notes: "",
              }]);
              setView("create-plan");
            }}>+ NEW</button>
          </div>
          {sheetPlans
            .filter(p => !planSearch || p.name.toLowerCase().includes(planSearch.toLowerCase()))
            .map(plan => {
              const open = expandedPlan === plan.name;
              const totalSets = plan.sets ? plan.sets.length : 0;
              const exercises = plan.sets ? [...new Set(plan.sets.map(s => s.exercise))] : [];
              return (
                <div key={plan.name} style={S.card}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer" }}
                    onClick={() => setExpandedPlan(open ? null : plan.name)}>
                    <div style={{ minWidth:0, flex:1 }}>
                      <div style={{ fontSize:13, color:"var(--text-primary)", fontWeight:600 }}>{plan.name}</div>
                      <div style={{ fontSize:10, color:"var(--text-label)", marginTop:2 }}>
                        {totalSets} sets · {exercises.slice(0, 3).join(", ")}{exercises.length > 3 ? "…" : ""}
                      </div>
                    </div>
                    <span style={{ color:"var(--text-dim)", fontSize:12 }}>{open ? "▲" : "▼"}</span>
                  </div>
                  {open && (
                    <div style={{ marginTop:12, borderTop:"1px solid var(--border-subtle)", paddingTop:10 }}>
                      {plan.sets && plan.sets
                        .sort((a, b) => (a.order || 0) - (b.order || 0))
                        .map((s, i) => (
                          <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid #161618" }}>
                            <div style={{ minWidth:0, flex:1 }}>
                              <div style={{ fontSize:12, color:"var(--text-primary)" }}>{s.exercise}</div>
                              <div style={{ fontSize:10, color:"var(--text-faint)", marginTop:1 }}>
                                {s.equipment}{s.handle ? ` · ${s.handle}` : ""} · {s.setType || "NORMAL SET"}
                              </div>
                            </div>
                            <div style={{ textAlign:"right", flexShrink:0 }}>
                              <div style={{ fontSize:11, color:"var(--accent)" }}>
                                {s.kg ? `${s.kg} kg` : ""} {s.reps ? `× ${s.reps}` : ""}
                              </div>
                              {s.repsGoal && <div style={{ fontSize:9, color:"var(--text-faint)" }}>range: {s.repsGoal}</div>}
                            </div>
                          </div>
                        ))}
                      <div style={{ display:"flex", gap:8, marginTop:10 }}>
                        <button style={{...S.btn, flex:1, fontSize:10}}
                          onClick={() => { importPlan(plan.name); setView("log"); setExpandedPlan(null); }}>
                          DUPLICATE TO WORKOUT LOG →
                        </button>
                        <button style={{...S.btnGhost, fontSize:10}}
                          onClick={() => {
                            setPlanName(plan.name);
                            setEditingPlanName(plan.name); // marker at vi redigerer
                            setPlanSets((plan.sets || [])
                              .sort((a, b) => (a.order || 0) - (b.order || 0))
                              .map(s => ({
                                id: `p_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
                                exercise: s.exercise || "", equipment: s.equipment || "",
                                handle: s.handle || "", kg: s.kg ? String(s.kg) : "",
                                reps: s.reps ? String(s.reps) : "",
                                repsGoal: s.repsGoal || "", setType: s.setType || "NORMAL SET",
                                notes: s.notes || "",
                              })));
                            setExpandedPlan(null);
                            setView("create-plan");
                          }}>
                          EDIT
                        </button>
                        <button style={{...S.btnGhost, fontSize:10, color:"var(--error-mid)", borderColor:"var(--error-border)"}}
                          onClick={() => handleDeletePlan(plan.name)}>
                          DELETE
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          {!sheetPlans.length && (
            <div style={{ color:"var(--text-faint)", fontSize:12, textAlign:"center", marginTop:40 }}>
              No plans yet. Tap + NEW to create one.
            </div>
          )}
        </div>
      )}

      {/* ── CREATE PLAN ── */}
      {view === "create-plan" && (
        <div style={S.page}>
          <div style={{...S.card, padding:"10px 14px", marginBottom:10}}>
            <label style={S.label}>PROGRAM NAME</label>
            <input style={S.input} value={planName} onChange={e => setPlanName(e.target.value)}
              placeholder="E.G. PUSH DAY A" />
          </div>

          {/* Import session som udgangspunkt for planen */}
          <div style={{ marginBottom:10 }}>
            <button style={{...S.btnGhost, width:"100%", padding:"9px", fontSize:10, letterSpacing:"0.08em"}}
              onClick={() => setShowImportSessionToPlan(p => !p)}>
              {showImportSessionToPlan ? "▲ CLOSE" : "+ DUPLICATE EARLIER WORKOUT AS STARTING POINT"}
            </button>
            {showImportSessionToPlan && (
              <div style={{...S.card, marginTop:6}}>
                <label style={S.label}>CHOOSE SESSION</label>
                <select style={{...S.select, marginBottom:8}} value={importSessionForPlan}
                  onChange={e => setImportSessionForPlan(e.target.value)}>
                  <option value="">— CHOOSE DAY —</option>
                  {daysGrouped.map(d => (
                    <option key={d.date} value={d.date}>
                      {toDisplay(d.date)} · {d.records.length} sets · {d.exercises.slice(0,3).join(", ")}
                    </option>
                  ))}
                </select>
                <button style={{...S.btn, width:"100%", fontSize:10, opacity: importSessionForPlan ? 1 : 0.4}}
                  disabled={!importSessionForPlan}
                  onClick={() => {
                    const day = daysGrouped.find(d => d.date === importSessionForPlan);
                    if (!day) return;
                    setPlanSets(day.records.map(r => ({
                      id: `p_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
                      exercise: r.exercise || "", equipment: r.equipment || "",
                      handle: r.handle || "", kg: r.kg ? String(r.kg) : "",
                      reps: r.reps ? String(r.reps) : "",
                      repsGoal: r.repsGoal || "", setType: r.setType || "NORMAL SET",
                      notes: r.notes || "",
                    })));
                    if (!planName) setPlanName(toDisplay(importSessionForPlan));
                    setShowImportSessionToPlan(false);
                    setImportSessionForPlan("");
                  }}>
                  LOAD SESSION →
                </button>
              </div>
            )}
          </div>

          <div style={{ fontSize:10, color:"var(--text-dim)", marginBottom:6, letterSpacing:"0.08em" }}>
            PROGRAM · {planSets.length} {planSets.length === 1 ? "set" : "sets"}
          </div>

          {planSets.map((s, idx) => {
            const sEquipForExercise = getEquipForExercise(s.exercise);
            return (
              <div key={s.id} style={S.card}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                  <div style={{ fontSize:10, color:"var(--text-dim)", letterSpacing:"0.1em" }}>SET {idx + 1}</div>
                  <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                    {/* Rækkefølge-pile */}
                    <button
                      style={{ background:"none", border:"none", color: idx === 0 ? "var(--border)" : "var(--text-label)", fontSize:13, cursor: idx === 0 ? "default" : "pointer", padding:"0 3px", lineHeight:1 }}
                      onClick={() => movePlanSet(s.id, -1)} disabled={idx === 0} title="Move up">↑</button>
                    <button
                      style={{ background:"none", border:"none", color: idx === planSets.length-1 ? "var(--border)" : "var(--text-label)", fontSize:13, cursor: idx === planSets.length-1 ? "default" : "pointer", padding:"0 3px", lineHeight:1 }}
                      onClick={() => movePlanSet(s.id, 1)} disabled={idx === planSets.length-1} title="Move down">↓</button>
                    {planSets.length > 1 && (
                      <button style={{ background:"none", border:"none", color:"var(--text-label)", fontSize:15, cursor:"pointer", padding:"0 3px", lineHeight:1 }}
                        onClick={() => removePlanSet(s.id)} aria-label="Remove set">×</button>
                    )}
                  </div>
                </div>
                <div style={{ marginBottom:10 }}>
                  <label style={S.label}>EXERCISE</label>
                  <select style={S.select} value={s.exercise}
                    onChange={ev => {
                      const newEx = ev.target.value;
                      const meta = exerciseMuscleMap[newEx];
                      updatePlanSet(s.id, {
                        exercise: newEx,
                        equipment: "",
                        handle: "",
                        repsGoal: (meta && meta.defaultRepRange) || s.repsGoal || "8-10",
                      });
                    }}>
                    <option value="">— CHOOSE EXERCISE —</option>
                    {allExercises.map(ex => <option key={ex}>{ex}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom:10 }}>
                  <label style={S.label}>EQUIPMENT</label>
                  <select style={S.select} value={s.equipment}
                    onChange={ev => updatePlanSet(s.id, {
                      equipment: ev.target.value,
                      handle: ev.target.value === "CABLE TOWER" ? s.handle : "",
                    })}>
                    <option value="">— CHOOSE EQUIPMENT —</option>
                    {sEquipForExercise.map(eq => <option key={eq}>{eq}</option>)}
                  </select>
                </div>
                {s.equipment === "CABLE TOWER" && (
                  <div style={{ marginBottom:10 }}>
                    <label style={S.label}>HANDLE</label>
                    <select style={S.select} value={s.handle || ""}
                      onChange={ev => updatePlanSet(s.id, { handle: ev.target.value })}>
                      <option value="">— CHOOSE HANDLE —</option>
                      {getHandlesForEquipment("CABLE TOWER").map(h => <option key={h}>{h}</option>)}
                    </select>
                  </div>
                )}
                <div style={{...S.grid2, marginBottom:10}}>
                  <div>
                    <label style={S.label}>TARGET Kg</label>
                    <input type="number" style={S.input} value={s.kg}
                      onChange={ev => updatePlanSet(s.id, { kg: ev.target.value })}
                      placeholder="optional" />
                  </div>
                  <div>
                    <label style={S.label}>TARGET REPS</label>
                    <input type="number" style={S.input} value={s.reps}
                      onChange={ev => updatePlanSet(s.id, { reps: ev.target.value })}
                      placeholder="optional" />
                  </div>
                </div>
                <div style={{ marginBottom:10 }}>
                  <label style={S.label}>REP RANGE</label>
                  <div style={S.grid2}>
                    <input type="number" style={S.input}
                      value={parseRepRange(s.repsGoal).min} placeholder="MINIMUM"
                      onChange={ev => updatePlanSet(s.id, { repsGoal: buildRepRange(ev.target.value, parseRepRange(s.repsGoal).max) })} />
                    <input type="number" style={S.input}
                      value={parseRepRange(s.repsGoal).max} placeholder="MAXIMUM"
                      onChange={ev => updatePlanSet(s.id, { repsGoal: buildRepRange(parseRepRange(s.repsGoal).min, ev.target.value) })} />
                  </div>
                </div>
                <div style={{ marginBottom:10 }}>
                  <label style={S.label}>SET TYPE</label>
                  <select style={S.select} value={s.setType}
                    onChange={ev => updatePlanSet(s.id, { setType: ev.target.value })}>
                    {SET_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={S.label}>NOTES</label>
                  <input type="text" style={S.input} placeholder="SET NOTES (OPTIONAL)" value={s.notes}
                    onChange={ev => updatePlanSet(s.id, { notes: ev.target.value })} />
                </div>
              </div>
            );
          })}

          <button style={{...S.btnGhost, width:"100%", marginBottom:14, padding:"12px", fontSize:11, color:"var(--accent)", borderColor:"var(--accent-border)"}}
            onClick={addPlanSet}>
            + ADD SET
          </button>

          {/* Tydelig edit-indikator + gem/annuller */}
          {editingPlanName && (
            <div style={{ background:"var(--accent-bg)", border:"1px solid var(--accent-border)", borderRadius:8, padding:"10px 12px", marginBottom:10 }}>
              <div style={{ fontSize:10, color:"var(--accent-dim)", letterSpacing:"0.1em" }}>
                EDITING PROGRAM: <span style={{ color:"var(--accent)", fontWeight:600 }}>{editingPlanName}</span>
              </div>
              {planName.trim() !== editingPlanName && planName.trim() && (
                <div style={{ fontSize:9, color:"var(--text-muted)", marginTop:3 }}>
                  PROGRAM WILL BE RENAMED TO "{planName.trim()}"
                </div>
              )}
            </div>
          )}

          <div style={{ display:"flex", gap:8, marginBottom:10 }}>
            <button
              style={{...S.btn, flex:1, opacity: savingPlan || !planName.trim() ? 0.6 : 1}}
              onClick={handleSavePlan}
              disabled={savingPlan || !planName.trim()}
            >
              {savingPlan ? "SAVING..." : editingPlanName ? "SAVE CHANGES" : "SAVE PROGRAM"}
            </button>
            {editingPlanName && (
              <button
                style={S.btnGhost}
                onClick={() => {
                  setEditingPlanName(null);
                  setPlanName("");
                  setPlanSets([{ id: newPlanSetId(), exercise: "", equipment: "", handle: "", kg: "", reps: "", repsGoal: "8-10", setType: "NORMAL SET", notes: "" }]);
                  setView("existing-plans");
                }}
              >
                CANCEL
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── HISTORIK (grupperet pr. dag) ── */}
      {view === "history" && (
        <div style={S.page}>
          <div style={{...S.grid2, marginBottom:8}}>
            <select style={S.select} value={histEx} onChange={e => setHistEx(e.target.value)}>
              <option value="">All exercises</option>
              {histExerciseOptions.map(ex => <option key={ex}>{ex}</option>)}
            </select>
            <select style={S.select} value={histEq} onChange={e => setHistEq(e.target.value)}>
              <option value="">All equipment</option>
              {histEquipmentOptions.map(eq => <option key={eq}>{eq}</option>)}
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
                <div style={{ color:"var(--text-faint)", fontSize:12, textAlign:"center", marginTop:40 }}>
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
                      <div style={{ fontSize:13, color:"var(--text-primary)", fontWeight:600 }}>{toDisplay(day.date)}</div>
                      <div style={{ fontSize:10, color:"var(--text-label)", marginTop:2 }}>
                        {(() => {
                          const centersForDay = [...new Set(day.records.map(r => r.center).filter(Boolean))];
                          const centerLabel = centersForDay.length === 1 ? centersForDay[0]
                            : centersForDay.length > 1 ? `${centersForDay.length} centre` : "";
                          return (
                            <>
                              {day.records.length} sets · {exercisesForDay.slice(0, 3).join(", ")}{exercisesForDay.length > 3 ? "…" : ""}
                              {centerLabel && <span style={{ color:"var(--accent-dim)", marginLeft:4 }}> · {centerLabel}</span>}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    <span style={{ color:"var(--text-faint)", fontSize:12, flexShrink:0, marginLeft:8 }}>{isOpen ? "▲" : "▼"}</span>
                  </div>

                  {/* Sæt-liste for dagen */}
                  {isOpen && (
                    <div style={{ marginTop:10, borderTop:"1px solid var(--border-subtle)", paddingTop:8 }}>
                      {day.records.map((r, i) => {
                        const isPR = r.oneRepMax && getBest1RM(r.exercise, r.equipment, r.handle, r.center) === r.oneRepMax;
                        const editKey = `${day.date}_${i}`;
                        const isEditing = historyEditKey === editKey;
                        return (
                          <div key={i} style={{ padding:"6px 0", borderBottom:"1px solid var(--border-faint)" }}>
                            {!isEditing ? (
                              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                                <div style={{ minWidth:0, flex:1 }}>
                                  <div style={{ fontSize:12, color:"var(--text-primary)" }}>
                                    {r.exercise}
                                    {isPR && <span style={{...S.tagGreen, marginLeft:6}}>PR</span>}
                                  </div>
                                  <div style={{ fontSize:10, color:"var(--text-faint)", marginTop:1 }}>
                                    {r.equipment}{r.handle ? ` · ${r.handle}` : ""}
                                    {r.center && <span style={{ color:"var(--accent-dim)" }}> · {r.center}</span>}
                                  </div>
                                </div>
                                <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
                                  <div style={{ textAlign:"right" }}>
                                    <div style={{ fontSize:13, color:"var(--accent)", fontWeight:600 }}>
                                      {r.kg != null ? r.kg : "—"} kg × {r.reps != null ? r.reps : "—"}
                                    </div>
                                    {r.oneRepMax && <div style={{ fontSize:9, color:"var(--text-faint)" }}>1RM ~{r.oneRepMax}</div>}
                                  </div>
                                  <button style={{ background:"none", border:"none", cursor:"pointer", fontSize:11, color:"var(--text-faint)", padding:"2px 4px" }}
                                    onClick={() => {
                                      setHistoryEditKey(editKey);
                                      setHistoryEditData({ ...r });
                                    }}>✎</button>
                                </div>
                              </div>
                            ) : (
                              /* EDIT MODE */
                              <div style={{ background:"var(--surface-2, var(--accent-bg))", borderRadius:8, padding:10 }}>
                                <div style={S.grid2}>
                                  <div>
                                    <label style={S.label}>WEIGHT</label>
                                    <input type="number" style={S.input} value={historyEditData.kg || ""}
                                      onChange={ev => setHistoryEditData(p => ({...p, kg: ev.target.value}))} />
                                  </div>
                                  <div>
                                    <label style={S.label}>REPS</label>
                                    <input type="number" style={S.input} value={historyEditData.reps || ""}
                                      onChange={ev => setHistoryEditData(p => ({...p, reps: ev.target.value}))} />
                                  </div>
                                </div>
                                <div style={{ marginTop:8 }}>
                                  <label style={S.label}>NOTES</label>
                                  <input type="text" style={S.input} value={historyEditData.notes || ""}
                                    onChange={ev => setHistoryEditData(p => ({...p, notes: ev.target.value}))} />
                                </div>
                                <div style={{ display:"flex", gap:6, marginTop:8 }}>
                                  <button style={{...S.btn, flex:1, fontSize:10, padding:"7px"}}
                                    onClick={() => handleHistorySave(r, historyEditData, editKey)}>
                                    SAVE
                                  </button>
                                  <button style={{...S.btnGhost, fontSize:10, padding:"7px 10px"}}
                                    onClick={() => { setHistoryEditKey(null); setHistoryEditData(null); }}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {/* Knapper */}
                      <div style={{ display:"flex", gap:6, marginTop:10 }}>
                        <button
                          style={{...S.btnGhost, flex:1, padding:"8px", fontSize:10, color:"var(--accent)", borderColor:"var(--accent-border)"}}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            importFromDay(day.date);
                            setView("log");
                            setExpandedDay(null);
                          }}
                        >
                          + DUPLICATE TO WORKOUT LOG
                        </button>
                        <button
                          style={{...S.btnGhost, flex:1, padding:"8px", fontSize:10}}
                          onClick={() => {
                            setPlanName(`${toDisplay(day.date)} (imported)`);
                            setPlanSets(day.records.map(r => ({
                              id: `p_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
                              exercise: r.exercise || "", equipment: r.equipment || "",
                              handle: r.handle || "", kg: r.kg ? String(r.kg) : "",
                              reps: r.reps ? String(r.reps) : "",
                              repsGoal: r.repsGoal || "", setType: r.setType || "NORMAL SET",
                              notes: r.notes || "",
                            })));
                            setView("create-plan");
                          }}
                        >
                          → SAVE AS PLAN
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}

      {/* ── INSIGHTS ── */}
      {view === "insights" && (
        <div style={S.page}>
          <InsightsView
            allRecords={allRecords}
            exerciseDetailCache={exerciseDetailCache}
            loadExerciseDetail={loadExerciseDetail}
            getRecordsForExercise={getRecordsForExercise}
            loadingDetail={loadingDetail}
            statsEx={statsEx}
            setStatsEx={setStatsEx}
            best1RMMap={best1RMMap}
          />
        </div>
      )}

      {/* Toast */}
      {toast && <div style={toast.ok ? S.toast : S.toastErr}>{toast.msg}</div>}
    </div>
  );
}

// ─── INSIGHTS VIEW ────────────────────────────────────────────────────────────
function InsightsView({ allRecords, exerciseDetailCache, loadExerciseDetail, getRecordsForExercise, loadingDetail, statsEx, setStatsEx, best1RMMap }) {
  const [insightsTab, setInsightsTab] = useState("stats"); // "stats" | "history"
  const [histEx, setHistEx] = useState("");
  const [histEq, setHistEq] = useState("");

  const exercisesWithData = [...new Set(allRecords.filter(r => r.oneRepMax).map(r => r.exercise).filter(Boolean))].sort();
  const allExercisesInHistory = [...new Set(allRecords.map(r => r.exercise).filter(Boolean))].sort();
  const allEquipmentInHistory = [...new Set(allRecords.map(r => r.equipment).filter(Boolean))].sort();

  useEffect(() => {
    if (statsEx) loadExerciseDetail(statsEx);
  }, [statsEx]);

  useEffect(() => {
    if (!statsEx && exercisesWithData.length > 0) {
      setStatsEx(exercisesWithData[0]);
    }
  }, [exercisesWithData.length]);

  // Filtrer historik
  const historyRecords = allRecords.filter(r =>
    (!histEx || r.exercise === histEx) &&
    (!histEq || r.equipment === histEq)
  );

  // Grupper historik pr. dag
  const histByDay = {};
  for (const r of historyRecords) {
    if (!r.date) continue;
    if (!histByDay[r.date]) histByDay[r.date] = [];
    histByDay[r.date].push(r);
  }
  const histDays = Object.entries(histByDay)
    .sort((a, b) => b[0].localeCompare(a[0]));

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display:"flex", gap:0, marginBottom:16, borderBottom:"1px solid var(--border-subtle)" }}>
        {[["stats","STATS"],["history","HISTORY"]].map(([k, l]) => (
          <button key={k}
            style={{
              flex:1, padding:"8px 0", fontSize:10, letterSpacing:"0.12em",
              fontFamily:"'DM Mono', monospace", border:"none", background:"none",
              cursor:"pointer", fontWeight:600,
              color: insightsTab === k ? "var(--accent)" : "var(--text-faint)",
              borderBottom: insightsTab === k ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom:-1,
            }}
            onClick={() => setInsightsTab(k)}>{l}</button>
        ))}
      </div>

      {/* STATS tab */}
      {insightsTab === "stats" && (
        <div>
          <div style={{ marginBottom:12 }}>
            <label style={S.label}>EXERCISE</label>
            <select style={S.select} value={statsEx} onChange={e => setStatsEx(e.target.value)}>
              {exercisesWithData.map(ex => <option key={ex}>{ex}</option>)}
            </select>
            {loadingDetail && (
              <div style={{ fontSize:9, color:"var(--text-muted)", marginTop:6, letterSpacing:"0.08em" }}>
                ↻ LOADING FULL HISTORY…
              </div>
            )}
          </div>
          {statsEx && (
            <StatsView
              exercise={statsEx}
              allRecords={getRecordsForExercise(statsEx)}
              best1RMMap={best1RMMap}
            />
          )}
        </div>
      )}

      {/* HISTORY tab */}
      {insightsTab === "history" && (
        <div>
          <div style={{...S.grid2, marginBottom:10}}>
            <select style={S.select} value={histEx} onChange={e => setHistEx(e.target.value)}>
              <option value="">All exercises</option>
              {allExercisesInHistory.map(ex => <option key={ex}>{ex}</option>)}
            </select>
            <select style={S.select} value={histEq} onChange={e => setHistEq(e.target.value)}>
              <option value="">All equipment</option>
              {allEquipmentInHistory.map(eq => <option key={eq}>{eq}</option>)}
            </select>
          </div>
          <div style={{ fontSize:9, color:"var(--text-muted)", marginBottom:10, letterSpacing:"0.06em" }}>
            {historyRecords.length} sets across {histDays.length} sessions
          </div>
          {histDays.map(([date, recs]) => (
            <div key={date} style={{...S.card, marginBottom:8, padding:"10px 12px"}}>
              <div style={{ fontSize:10, color:"var(--text-label)", letterSpacing:"0.1em", marginBottom:8, fontFamily:"'DM Mono', monospace" }}>
                {toDisplay(date)} · {recs.length} sets
              </div>
              {recs.map((r, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"4px 0", borderBottom:"1px solid var(--border-faint)" }}>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontSize:11, color:"var(--text-primary)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {r.exercise}
                    </div>
                    <div style={{ fontSize:9, color:"var(--text-faint)" }}>
                      {r.equipment}{r.handle ? ` · ${r.handle}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0, marginLeft:8 }}>
                    <div style={{ fontSize:12, color:"var(--accent)", fontWeight:600 }}>
                      {r.kg != null ? r.kg : "—"} kg × {r.reps != null ? r.reps : "—"}
                    </div>
                    {r.oneRepMax && <div style={{ fontSize:9, color:"var(--text-faint)" }}>1RM ~{r.oneRepMax}</div>}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {histDays.length === 0 && (
            <div style={{ color:"var(--text-faint)", fontSize:12, textAlign:"center", marginTop:40 }}>
              No sets matching filters
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── STATS VIEW ───────────────────────────────────────────────────────────────
// Viser progression pr. (equipment + handle) — cable tower splittes pr. handle
function StatsView({ exercise, allRecords, best1RMMap }) {
  const [showAllKey, setShowAllKey] = useState({});
  const records = allRecords.filter(r => r.exercise === exercise && r.oneRepMax);

  // Gruppe-nøgle: equipment + handle hvis handle er sat, ellers bare equipment
  const groupKeys = [...new Set(records.map(r => {
    const h = r.handle ? ` · ${r.handle}` : "";
    return `${r.equipment}${h}`;
  }).filter(Boolean))].sort();

  if (!records.length) return (
    <div style={{ color:"var(--text-faint)", fontSize:12, textAlign:"center", marginTop:40 }}>
      NO DATA FOR {exercise}
    </div>
  );

  return (
    <div>
      {groupKeys.map(groupKey => {
        // Split gruppe-nøgle tilbage til equipment + handle
        const dotIdx = groupKey.indexOf(" · ");
        const eq = dotIdx >= 0 ? groupKey.slice(0, dotIdx) : groupKey;
        const handle = dotIdx >= 0 ? groupKey.slice(dotIdx + 3) : "";

        const groupRecs = records.filter(r => {
          const matchEq = r.equipment === eq;
          const matchHandle = handle ? r.handle === handle : !r.handle;
          return matchEq && matchHandle && r.oneRepMax;
        });

        // Aggregér til bedste 1RM pr. dag
        const bestPerDay = {};
        for (const r of groupRecs) {
          const d = r.date;
          if (!d) continue;
          if (!bestPerDay[d] || r.oneRepMax > bestPerDay[d].oneRepMax) bestPerDay[d] = r;
        }
        const recs = Object.values(bestPerDay)
          .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        const recsForChart = recs.slice(-30);
        if (!recs.length) return null;

        // Bedste 1RM for denne gruppe fra server-map
        const mapKey = `${exercise}||${eq}||${handle}||`;
        let best = best1RMMap[mapKey] || null;
        // Fallback: beregn fra records
        if (!best) {
          for (const r of groupRecs) {
            if (r.oneRepMax && (!best || r.oneRepMax > best)) best = r.oneRepMax;
          }
        }

        const showAll = showAllKey[groupKey];
        const displayRecs = showAll ? [...recs].reverse() : [...recs].reverse().slice(0, 5);

        return (
          <div key={groupKey} style={{ marginBottom:24, paddingBottom:16, borderBottom:"1px solid var(--border-subtle)" }}>
            {/* Header: equipment + evt. handle */}
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
              <div style={{ fontSize:11, color:"var(--accent)", letterSpacing:"0.1em", fontWeight:600 }}>{eq}</div>
              {handle && (
                <div style={{ fontSize:10, color:"var(--text-muted)", background:"var(--border-faint)", borderRadius:4, padding:"2px 7px", letterSpacing:"0.06em" }}>
                  {handle}
                </div>
              )}
            </div>

            {/* Bedste 1RM + opvarmning */}
            {best && (
              <div style={{ background:"var(--accent-bg)", border:"1px solid var(--accent-border)", borderRadius:8, padding:"10px 12px", marginBottom:10 }}>
                <div style={{ fontSize:9, color:"var(--accent-dim)", letterSpacing:"0.12em", marginBottom:6 }}>BEST 1RM: {best} kg</div>
                {[[40,"WARM-UP SET"],[60,"LIGHT SET"],[80,"WORKING SET"]].map(([pct, label]) => (
                  <div key={pct} style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                    <span style={{ fontSize:10, color:"var(--text-label)" }}>{pct}% — {label}</span>
                    <span style={{ fontSize:11, color:"var(--accent)", fontWeight:600 }}>{Math.round(best * pct / 100 * 2) / 2} kg</span>
                  </div>
                ))}
              </div>
            )}

            {/* Progressionskurve */}
            <ProgressChart records={recsForChart} />

            {/* Historik med fold-ud */}
            <div style={{ marginTop:8 }}>
              {displayRecs.map((r, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid var(--border-faint)" }}>
                  <span style={{ fontSize:10, color:"var(--text-label)" }}>{toDisplay(r.date)}</span>
                  <span style={{ fontSize:11, color:"var(--text-secondary)" }}>
                    {r.kg != null ? r.kg : "—"} kg × {r.reps != null ? r.reps : "—"} → <span style={{ color:"var(--accent)" }}>{r.oneRepMax} 1RM</span>
                  </span>
                </div>
              ))}
              {recs.length > 5 && (
                <button
                  style={{ background:"none", border:"none", cursor:"pointer", width:"100%", padding:"8px 0", fontSize:10, color:"var(--text-dim)", fontFamily:"'DM Mono', monospace", letterSpacing:"0.08em" }}
                  onClick={() => setShowAllKey(prev => ({ ...prev, [groupKey]: !prev[groupKey] }))}>
                  {showAll ? "▲ SHOW LESS" : `▼ SHOW ALL ${recs.length} WORKOUTS`}
                </button>
              )}
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
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === pts.length - 1 ? 3 : 2}
          fill={i === pts.length - 1 ? "var(--accent)" : "var(--text-label)"} />
      ))}
      <text x={pts[0].x} y={H - 2} textAnchor="middle" fill="var(--text-dim)" fontSize={7} fontFamily="DM Mono, monospace">{toDisplay(pts[0].date)?.slice(-5)}</text>
      <text x={pts[pts.length-1].x} y={H - 2} textAnchor="middle" fill="var(--text-dim)" fontSize={7} fontFamily="DM Mono, monospace">{toDisplay(pts[pts.length-1].date)?.slice(-5)}</text>
    </svg>
  );
}

// ─── REP RANGE EDITOR ─────────────────────────────────────────────────────────
// Lokal state + eksplicit gem-knap — sender ingen API-kald ved hvert tastetryk
function RepRangeEditor({ initialValue, onSave }) {
  const parsed = parseRepRange(initialValue);
  const [min, setMin] = useState(parsed.min);
  const [max, setMax] = useState(parsed.max);
  const [saving, setSaving] = useState(false);

  const currentValue = buildRepRange(min, max);
  const changed = currentValue !== (initialValue || "");

  return (
    <div>
      <div style={{ display:"flex", gap:6, alignItems:"center" }}>
        <input
          type="number"
          style={{ flex:1, background:"var(--bg)", border:"1px solid " + (changed ? "var(--accent-border)" : "var(--border-input)"), borderRadius:6, padding:"7px 10px", color:"var(--text-primary)", fontFamily:"'DM Mono', monospace", fontSize:13, boxSizing:"border-box", outline:"none" }}
          value={min} placeholder="MINIMUM" min={1}
          onChange={e => setMin(e.target.value)}
        />
        <span style={{ fontSize:12, color:"var(--text-muted)", flexShrink:0 }}>–</span>
        <input
          type="number"
          style={{ flex:1, background:"var(--bg)", border:"1px solid " + (changed ? "var(--accent-border)" : "var(--border-input)"), borderRadius:6, padding:"7px 10px", color:"var(--text-primary)", fontFamily:"'DM Mono', monospace", fontSize:13, boxSizing:"border-box", outline:"none" }}
          value={max} placeholder="MAXIMUM" min={1}
          onChange={e => setMax(e.target.value)}
        />
        {changed && (
          <button
            style={{ background:"var(--accent)", color:"var(--bg)", border:"none", borderRadius:6, padding:"7px 14px", fontSize:10, fontWeight:700, cursor:"pointer", fontFamily:"'DM Mono', monospace", letterSpacing:"0.08em", opacity: saving ? 0.6 : 1, flexShrink:0 }}
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await onSave(currentValue);
              setSaving(false);
            }}>
            {saving ? "…" : "SAVE"}
          </button>
        )}
      </div>
      {currentValue && !changed && (
        <div style={{ fontSize:9, color:"var(--text-muted)", marginTop:4, letterSpacing:"0.05em" }}>
          {currentValue} REPS — SAVED ✓
        </div>
      )}
      {!currentValue && (
        <div style={{ fontSize:9, color:"var(--text-faint)", marginTop:4, letterSpacing:"0.05em" }}>
          Used as default when logging this exercise.
        </div>
      )}
    </div>
  );
}

// ─── VIDEO ROW ────────────────────────────────────────────────────────────────
function VideoRow({ exercise, equipment, handle, existingUrl, onSave }) {
  const [url, setUrl] = useState(existingUrl || "");
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const changed = url !== (existingUrl || "");

  // Label: "CABLE TOWER · ROPE", "CABLE TOWER", eller "General"
  const label = equipment
    ? (handle ? `${equipment} · ${handle}` : equipment)
    : "GENERIC (NO EQUIPMENT)";

  const embedUrl = getYouTubeEmbedUrl(url || existingUrl || "");
  const savedUrl = existingUrl || "";

  return (
    <div style={{ marginBottom:10, padding:"8px 10px", background:"var(--card)", border:"1px solid var(--border)", borderRadius:8 }}>
      {/* Label */}
      <div style={{ fontSize:9, color:"var(--text-muted)", letterSpacing:"0.1em", marginBottom:6, fontFamily:"'DM Mono', monospace" }}>
        {label}
      </div>
      {/* URL input + knapper */}
      <div style={{ display:"flex", gap:6, alignItems:"center" }}>
        <input
          style={{ flex:1, background:"var(--bg)", border:"1px solid " + (changed ? "var(--accent-border)" : "var(--border-input)"),
            borderRadius:6, padding:"7px 10px", color:"var(--text-primary)",
            fontFamily:"'DM Mono', monospace", fontSize:11, boxSizing:"border-box", outline:"none" }}
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="INSERT VIDEO-URL HERE"
        />
        {changed && (
          <button
            style={{ background:"var(--accent)", color:"var(--bg)", border:"none", borderRadius:6,
              padding:"7px 14px", fontSize:10, fontWeight:700, cursor:"pointer",
              fontFamily:"'DM Mono', monospace", letterSpacing:"0.08em", opacity: saving ? 0.6 : 1, flexShrink:0 }}
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await onSave(url.trim());
              setSaving(false);
            }}>
            {saving ? "…" : "SAVE"}
          </button>
        )}
        {savedUrl && !changed && (
          <>
            <button
              style={{ background:"none", border:"1px solid var(--accent-border)", borderRadius:6,
                padding:"6px 10px", fontSize:10, color:"var(--accent)", cursor:"pointer",
                fontFamily:"'DM Mono', monospace", flexShrink:0 }}
              onClick={() => setShowPreview(p => !p)}>
              {showPreview ? "▼" : "▶"}
            </button>
            <button
              style={{ background:"none", border:"1px solid var(--border-input)", borderRadius:6,
                padding:"6px 10px", fontSize:10, color:"var(--text-faint)", cursor:"pointer",
                fontFamily:"'DM Mono', monospace", flexShrink:0 }}
              onClick={() => setUrl("")}>
              ✕
            </button>
          </>
        )}
      </div>
      {/* Embedded preview */}
      {showPreview && embedUrl && (
        <div style={{ marginTop:8, borderRadius:6, overflow:"hidden", background:"#000", aspectRatio:"16/9" }}>
          <iframe
            src={embedUrl}
            style={{ width:"100%", height:"100%", border:"none", display:"block" }}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title="Exercise video"
          />
        </div>
      )}
    </div>
  );
}
