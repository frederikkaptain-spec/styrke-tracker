/**
 * Styrke Tracker — Apps Script til at læse og skrive til Sheets.
 *
 * Deployment-instruktioner: se SHEETS_WRITE_SETUP.md
 *
 * Ark der forventes i spreadsheet'et:
 *   1. Træningslog (data-arket — det første ark) — kolonner:
 *      Dato | Øvelse | Redskab | Kg | Reps | Reps Mål | Sæt Type | 1RM | Noter
 *   2. Øvelser — kolonner: Navn | Primær Muskel | Sekundær Muskler
 *   3. Redskaber — kolonner: Navn
 *
 * Øvelser/Redskaber-arkene oprettes automatisk første gang appen skriver
 * en ny øvelse eller et nyt redskab. Du kan også oprette dem manuelt.
 */

const SHEET_LOG = 0; // Træningslog er det første ark (index 0)
const SHEET_EXERCISES = "Øvelser";
const SHEET_EQUIPMENT = "Redskaber";

// ─── LÆSNING: Returner alle data som JSON ─────────────────────────────────────
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const result = {
      sets: readSets_(ss),
      exercises: readExercises_(ss),
      equipment: readEquipment_(ss),
    };
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function readSets_(ss) {
  const sheet = ss.getSheets()[SHEET_LOG];
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  return data.slice(1)
    .filter(function(r) { return r[0] && String(r[0]).trim(); })
    .map(function(r) {
      return {
        date: formatDate_(r[0]),
        exercise: String(r[1] || "").trim(),
        equipment: String(r[2] || "").trim(),
        kg: parseNum_(r[3]),
        reps: parseInt(r[4]) || null,
        repsGoal: String(r[5] || "").trim(),
        setType: String(r[6] || "").trim() || "Working",
        oneRepMax: parseNum_(r[7]),
        notes: String(r[8] || "").trim(),
      };
    })
    .filter(function(r) { return r.exercise; });
}

function readExercises_(ss) {
  const sheet = ss.getSheetByName(SHEET_EXERCISES);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  return data.slice(1)
    .filter(function(r) { return r[0] && String(r[0]).trim(); })
    .map(function(r) {
      return {
        name: String(r[0]).trim(),
        primaryMuscle: String(r[1] || "").trim(),
        secondaryMuscles: String(r[2] || "").trim(),
      };
    });
}

function readEquipment_(ss) {
  const sheet = ss.getSheetByName(SHEET_EQUIPMENT);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  return data.slice(1)
    .filter(function(r) { return r[0] && String(r[0]).trim(); })
    .map(function(r) { return { name: String(r[0]).trim() }; });
}

function formatDate_(v) {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }
  return String(v || "").trim();
}

function parseNum_(v) {
  if (v === "" || v == null) return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ─── SKRIVNING: Modtag POST med JSON ──────────────────────────────────────────
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const type = data.type || "set"; // default = sæt (bagudkompatibel)
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (type === "set") {
      writeSet_(ss, data);
    } else if (type === "exercise") {
      writeExercise_(ss, data);
    } else if (type === "equipment") {
      writeEquipment_(ss, data);
    } else {
      throw new Error("Ukendt type: " + type);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function writeSet_(ss, data) {
  const sheet = ss.getSheets()[SHEET_LOG];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "Dato", "Øvelse", "Redskab", "Kg", "Reps",
      "Reps Mål", "Sæt Type", "1RM", "Noter"
    ]);
  }
  sheet.appendRow([
    data.dato || "",
    data.oevelse || "",
    data.redskab || "",
    data.kg || "",
    data.reps || "",
    data.repsmaal || "",
    data.saettype || "",
    data.orm || "",
    data.noter || ""
  ]);
}

function writeExercise_(ss, data) {
  let sheet = ss.getSheetByName(SHEET_EXERCISES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_EXERCISES);
    sheet.appendRow(["Navn", "Primær Muskel", "Sekundær Muskler"]);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Navn", "Primær Muskel", "Sekundær Muskler"]);
  }

  const name = String(data.name || "").trim();
  if (!name) throw new Error("Øvelsesnavn er påkrævet");
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const existing = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const exists = existing.some(function(r) {
      return String(r[0] || "").trim().toLowerCase() === name.toLowerCase();
    });
    if (exists) return;
  }

  sheet.appendRow([
    name,
    String(data.primaryMuscle || "").trim(),
    String(data.secondaryMuscles || "").trim(),
  ]);
}

function writeEquipment_(ss, data) {
  let sheet = ss.getSheetByName(SHEET_EQUIPMENT);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_EQUIPMENT);
    sheet.appendRow(["Navn"]);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Navn"]);
  }

  const name = String(data.name || "").trim();
  if (!name) throw new Error("Redskabsnavn er påkrævet");
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const existing = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const exists = existing.some(function(r) {
      return String(r[0] || "").trim().toLowerCase() === name.toLowerCase();
    });
    if (exists) return;
  }

  sheet.appendRow([name]);
}
