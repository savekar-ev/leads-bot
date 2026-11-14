/**
 * Google Apps Script for the leads sheet.
 *
 * Paste this into the sheet: Extensions -> Apps Script, replace everything, save.
 * Then Deploy -> New deployment -> type "Web app",
 *   Execute as: Me
 *   Who has access: Anyone
 * and copy the Web app URL into GOOGLE_WEBHOOK_URL in the server's .env.
 *
 * The bot POSTs new leads here; this script appends them to the "Leads" tab.
 * Only requests carrying the right secret are accepted.
 */

// Change this to a long random string, and put the same value in
// GOOGLE_WEBHOOK_SECRET in the server's .env.
const SECRET = 'CHANGE-ME-to-a-long-random-string';
const TAB = 'Leads';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return reply({ ok: false, error: 'bad secret' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
    const header = body.header || [];
    const rows = (body.rows || []).map(function (r) { return r.map(asText); });

    const lock = LockService.getScriptLock();
    lock.waitLock(30000); // one write at a time
    try {
      if (sheet.getLastRow() === 0 && header.length) {
        sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
      if (rows.length) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      }
    } finally {
      lock.releaseLock();
    }
    return reply({ ok: true, added: rows.length });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

// Quick check in a browser: opening the Web app URL shows this.
function doGet() {
  return reply({ ok: true, message: 'Leads webhook is running' });
}

// Text that starts with = + - @ is kept as text, never run as a formula.
function asText(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
