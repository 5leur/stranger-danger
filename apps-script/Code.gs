/**
 * Stranger Danger — Halloween party registration + door check-in.
 *
 * Lives in the Apps Script project bound to the Google Sheet that collects
 * the Google Form responses. It:
 *   1. Gives every registrant a permanent Guest ID (the thing inside the QR).
 *   2. Emails them a formatted invite with their QR code.
 *   3. Exposes a small PIN-protected JSON API that the bouncer's scanner page
 *      (docs/index.html) calls to look guests up and check them in.
 *
 * See README.md for setup steps.
 */

// ===================== Edit these for your event =====================
const CONFIG = {
  EVENT_NAME: 'Stranger Danger: A Halloween Party',
  EVENT_DATE: 'Saturday, October 31, 2026 · 9:00 PM',
  EVENT_VENUE: 'Venue to be announced',
  TICKET_PRICE: '',            // e.g. '₱500' — leave blank to hide
  PAYMENT_INSTRUCTIONS:
    'Please settle your payment with the organizers before the party. ' +
    'Guests who have not paid will be asked to pay at the door.',
  DRESS_CODE: 'Costumes strongly encouraged. Come as your scariest self.',
  ORGANIZER_NAME: 'The Stranger Danger Crew',
  REPLY_TO: '',                // optional reply-to address for the email

  ID_PREFIX: 'SD',             // Guest IDs look like SD-7K3MX-Q9P2A
  SHEET_NAME: '',              // blank = the sheet linked to the form
  EMAIL_HEADER: '',            // blank = auto-detect a column containing "email"
  NAME_HEADER: '',             // blank = auto-detect name / first + last name
  DISPLAY_FIELDS: [],          // form questions to show the bouncer; [] = all
};
// =====================================================================

// Columns this script adds to the right of the form's columns.
const COL = {
  ID: 'Guest ID',
  PAID: 'Paid',
  EMAILED: 'QR Emailed At',
  CHECKED_IN: 'Checked In At',
  NOTES: 'Door Notes',
};
const INTERNAL_COLS = Object.keys(COL).map(function (k) { return COL[k]; });
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const MAX_PIN_FAILS = 30;  // per 10 minutes, across all callers

// ============================ Sheet menu =============================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎃 Party')
    .addItem('Run setup', 'setup')
    .addItem('Email QR codes to everyone not yet emailed', 'sendPending')
    .addItem('Resend QR code to selected row(s)', 'resendSelected')
    .addSeparator()
    .addItem('Show door stats', 'showStats')
    .addItem('Change bouncer PIN', 'changePin')
    .addToUi();
}

/** Adds the extra columns, installs the form-submit trigger and sets the PIN. */
function setup() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  const sheet = getSheet_();
  ensureColumns_(sheet);

  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onFormSubmitTrigger';
  });
  if (!hasTrigger) {
    ScriptApp.newTrigger('onFormSubmitTrigger').forSpreadsheet(ss).onFormSubmit().create();
  }
  if (!getPin_()) changePin();

  ui.alert(
    'Setup complete',
    'Responses sheet: "' + sheet.getName() + '"\n\n' +
    '• New form submissions will automatically get a Guest ID and a QR email.\n' +
    '• Tick the "' + COL.PAID + '" checkbox when a guest pays.\n' +
    '• Use 🎃 Party → "Email QR codes…" for people who registered before setup.\n' +
    '• Next: Deploy → New deployment → Web app (see README).',
    ui.ButtonSet.OK
  );
}

function changePin() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Bouncer PIN',
    'Choose a PIN/passphrase the bouncers will type into the scanner (at least 6 characters):',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const pin = res.getResponseText().trim();
  if (pin.length < 6) {
    ui.alert('PIN must be at least 6 characters. Nothing changed.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('BOUNCER_PIN', pin);
  ui.alert('Bouncer PIN saved.');
}

function sendPending() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getSheet_();
  ensureColumns_(sheet);
  const h = headerMap_(sheet);
  const last = sheet.getLastRow();
  let sent = 0, skipped = 0;
  const errors = [];
  for (let row = 2; row <= last; row++) {
    if (MailApp.getRemainingDailyQuota() < 1) {
      errors.push('Daily email quota reached — run this again tomorrow.');
      break;
    }
    try {
      processRow_(sheet, row, h, false) === 'sent' ? sent++ : skipped++;
    } catch (err) {
      errors.push('Row ' + row + ': ' + err.message);
    }
  }
  ui.alert('Sent ' + sent + ' email(s), skipped ' + skipped + '.' +
    (errors.length ? '\n\nProblems:\n' + errors.join('\n') : ''));
}

function resendSelected() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getSheet_();
  const range = sheet.getActiveRange();
  if (!range || SpreadsheetApp.getActiveSheet().getName() !== sheet.getName()) {
    ui.alert('Select one or more guest rows on the "' + sheet.getName() + '" sheet first.');
    return;
  }
  const first = Math.max(2, range.getRow());
  const last = range.getLastRow();
  if (last < first) return;
  const ok = ui.alert('Resend QR email to ' + (last - first + 1) + ' guest(s)?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  ensureColumns_(sheet);
  const h = headerMap_(sheet);
  const errors = [];
  for (let row = first; row <= last; row++) {
    try { processRow_(sheet, row, h, true); } catch (err) { errors.push('Row ' + row + ': ' + err.message); }
  }
  ui.alert(errors.length ? 'Done, with problems:\n' + errors.join('\n') : 'Done.');
}

function showStats() {
  const s = stats_();
  SpreadsheetApp.getUi().alert(
    'Door stats',
    'Registered: ' + s.registered + '\nPaid: ' + s.paid + '\nChecked in: ' + s.checkedIn,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ========================= Form submit trigger =======================

function onFormSubmitTrigger(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = e && e.range ? e.range.getSheet() : getSheet_();
    const row = e && e.range ? e.range.getRow() : sheet.getLastRow();
    ensureColumns_(sheet);
    processRow_(sheet, row, headerMap_(sheet), false);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Makes sure the row has a Guest ID and a Paid checkbox, then emails the QR
 * (unless it was already emailed and `force` is false).
 * Returns 'sent' or 'skipped'.
 */
function processRow_(sheet, row, h, force) {
  const width = sheet.getLastColumn();
  const values = sheet.getRange(row, 1, 1, width).getValues()[0];
  const rec = rowToRecord_(h, values);
  const guest = recordToGuest_(rec);
  if (!guest.email && !guest.name) return 'skipped'; // blank row

  if (!guest.id) {
    guest.id = newGuestId_(sheet, h);
    sheet.getRange(row, h[COL.ID]).setValue(guest.id);
  }
  if (values[h[COL.PAID] - 1] === '') {
    sheet.getRange(row, h[COL.PAID]).insertCheckboxes();
  }
  if (rec[COL.EMAILED] && !force) return 'skipped';
  if (!guest.email) throw new Error('no email address in this row');

  sendQrEmail_(guest);
  sheet.getRange(row, h[COL.EMAILED]).setValue(new Date());
  return 'sent';
}

// ============================== Email ================================

function sendQrEmail_(guest) {
  const qr = qrPng_(guest.id);
  const firstName = (guest.name || '').split(' ')[0] || 'friend';
  const paidLine = guest.paid
    ? '<span style="color:#7CFC9A;font-weight:bold;">PAID ✓</span> — you\'re all set.'
    : '<span style="color:#FFB347;font-weight:bold;">PAYMENT PENDING</span> — ' + esc_(CONFIG.PAYMENT_INSTRUCTIONS);

  const detailRow = function (label, value) {
    if (!value) return '';
    return '<tr><td style="padding:4px 12px 4px 0;color:#b9a7d6;white-space:nowrap;vertical-align:top;">' +
      label + '</td><td style="padding:4px 0;color:#f3eefc;">' + value + '</td></tr>';
  };

  const html =
    '<div style="margin:0;padding:24px 12px;background:#0d0a14;font-family:Georgia,\'Times New Roman\',serif;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;' +
    'background:#1a1325;border:1px solid #3a2a52;border-radius:14px;">' +
    '<tr><td style="padding:28px 28px 8px;text-align:center;">' +
    '<div style="font-size:40px;line-height:1;">🎃🦇👻</div>' +
    '<h1 style="margin:12px 0 4px;color:#ff7a18;font-size:26px;letter-spacing:1px;">' + esc_(CONFIG.EVENT_NAME) + '</h1>' +
    '<p style="margin:0;color:#b9a7d6;font-size:14px;">Your ticket to the other side</p>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 28px;color:#f3eefc;font-size:16px;line-height:1.5;">' +
    '<p style="margin:0 0 12px;">Hey ' + esc_(firstName) + ',</p>' +
    '<p style="margin:0 0 12px;">You\'re on the list. Below is your personal QR code. ' +
    'Show it to the bouncer at the door. <b>It\'s yours alone, so don\'t share it.</b></p>' +
    '</td></tr>' +
    '<tr><td style="padding:4px 28px 8px;text-align:center;">' +
    '<div style="display:inline-block;background:#ffffff;padding:14px;border-radius:12px;">' +
    '<img src="cid:qrcode" width="240" height="240" alt="Your entry QR code" style="display:block;">' +
    '</div>' +
    '<p style="margin:10px 0 0;color:#b9a7d6;font-family:Menlo,Consolas,monospace;font-size:15px;letter-spacing:2px;">' +
    esc_(guest.id) + '</p>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 28px;font-size:15px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0">' +
    detailRow('Guest', esc_(guest.name)) +
    detailRow('When', esc_(CONFIG.EVENT_DATE)) +
    detailRow('Where', esc_(CONFIG.EVENT_VENUE)) +
    detailRow('Ticket', esc_(CONFIG.TICKET_PRICE)) +
    detailRow('Payment', paidLine) +
    detailRow('Dress code', esc_(CONFIG.DRESS_CODE)) +
    '</table></td></tr>' +
    '<tr><td style="padding:8px 28px 28px;color:#8f7fab;font-size:13px;line-height:1.5;">' +
    'Tip: screenshot this QR or keep this email handy. Turn your screen brightness up at the door. ' +
    'The QR code is also attached as an image.<br><br>' +
    'See you in the dark,<br>' + esc_(CONFIG.ORGANIZER_NAME) +
    '</td></tr></table></div>';

  const text =
    CONFIG.EVENT_NAME + '\n\n' +
    'Hey ' + firstName + ', you\'re on the list!\n' +
    'Your Guest ID: ' + guest.id + ' (QR code attached, show it at the door)\n\n' +
    'When: ' + CONFIG.EVENT_DATE + '\nWhere: ' + CONFIG.EVENT_VENUE + '\n' +
    (CONFIG.TICKET_PRICE ? 'Ticket: ' + CONFIG.TICKET_PRICE + '\n' : '') +
    'Payment: ' + (guest.paid ? 'PAID' : 'PENDING. ' + CONFIG.PAYMENT_INSTRUCTIONS) + '\n\n' +
    CONFIG.ORGANIZER_NAME;

  const opts = {
    to: guest.email,
    subject: '🎃 Your QR ticket: ' + CONFIG.EVENT_NAME,
    htmlBody: html,
    body: text,
    name: CONFIG.ORGANIZER_NAME,
    inlineImages: { qrcode: qr },
    attachments: [qr.copyBlob().setName(guest.id + '.png')],
  };
  if (CONFIG.REPLY_TO) opts.replyTo = CONFIG.REPLY_TO;
  MailApp.sendEmail(opts);
}

/** PNG of a QR code that encodes the Guest ID. Tries two free renderers. */
function qrPng_(text) {
  const urls = [
    'https://quickchart.io/qr?size=600&margin=2&ecLevel=M&format=png&text=' + encodeURIComponent(text),
    'https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=8&ecc=M&format=png&data=' + encodeURIComponent(text),
  ];
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = UrlFetchApp.fetch(urls[i], { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) return res.getBlob().setName('qrcode.png');
    } catch (err) { /* try the next one */ }
  }
  throw new Error('could not generate QR image');
}

// ========================= Web app (bouncer API) =====================

function doGet(e) {
  let out;
  try {
    out = handleApi_((e && e.parameter) || {});
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleApi_(p) {
  if (!p.action) return { ok: true, message: 'Stranger Danger API is running. Use the scanner page.' };
  checkPin_(p.pin);

  switch (p.action) {
    case 'ping':
      return { ok: true, event: CONFIG.EVENT_NAME, stats: stats_() };

    case 'stats':
      return { ok: true, stats: stats_() };

    case 'lookup': {
      const found = findGuest_(p.id);
      if (!found) return { ok: false, error: 'not_found' };
      return { ok: true, guest: found.guest };
    }

    case 'admit': {
      const lock = LockService.getScriptLock();
      lock.waitLock(15000);
      try {
        const found = findGuest_(p.id);
        if (!found) return { ok: false, error: 'not_found' };
        const g = found.guest;
        if (g.checkedIn) return { ok: true, already: true, guest: g };

        const now = new Date();
        const sheet = found.sheet, row = found.row, h = found.h;
        if (!g.paid) {
          if (p.collect !== '1') return { ok: false, error: 'not_paid', guest: g };
          sheet.getRange(row, h[COL.PAID]).setValue(true);
          appendNote_(sheet, row, h, 'Paid at door ' + fmtDate_(now));
        }
        sheet.getRange(row, h[COL.CHECKED_IN]).setValue(now);
        SpreadsheetApp.flush();
        return { ok: true, admitted: true, guest: findGuest_(p.id).guest };
      } finally {
        lock.releaseLock();
      }
    }

    default:
      return { ok: false, error: 'unknown_action' };
  }
}

function checkPin_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fails') || 0);
  if (fails >= MAX_PIN_FAILS) throw new Error('too_many_attempts');
  const real = getPin_();
  if (!real) throw new Error('pin_not_set');
  if (String(pin || '') !== real) {
    cache.put('pin_fails', String(fails + 1), 600);
    throw new Error('bad_pin');
  }
}

// ============================= Helpers ===============================

function getPin_() {
  return PropertiesService.getScriptProperties().getProperty('BOUNCER_PIN');
}

function getSpreadsheet_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { /* web app context */ }
  if (ss) return ss;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Run 🎃 Party → Run setup in the spreadsheet first.');
  return SpreadsheetApp.openById(id);
}

function getSheet_() {
  const ss = getSpreadsheet_();
  if (CONFIG.SHEET_NAME) {
    const s = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!s) throw new Error('No sheet named "' + CONFIG.SHEET_NAME + '"');
    return s;
  }
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getFormUrl()) return sheets[i];
  }
  return sheets[0];
}

function headerMap_(sheet) {
  const width = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  const map = {};
  headers.forEach(function (hd, i) {
    const key = String(hd).trim();
    if (key && !(key in map)) map[key] = i + 1;
  });
  return map;
}

function ensureColumns_(sheet) {
  const h = headerMap_(sheet);
  let next = sheet.getLastColumn() + 1;
  INTERNAL_COLS.forEach(function (name) {
    if (h[name]) return;
    if (next > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), 1);
    sheet.getRange(1, next).setValue(name).setFontWeight('bold').setBackground('#ffe0c2');
    next++;
  });
}

function rowToRecord_(h, values) {
  const rec = {};
  Object.keys(h).forEach(function (k) { rec[k] = values[h[k] - 1]; });
  return rec;
}

function formHeaders_(rec) {
  return Object.keys(rec).filter(function (k) { return INTERNAL_COLS.indexOf(k) === -1; });
}

function detectEmailHeader_(rec) {
  if (CONFIG.EMAIL_HEADER) return CONFIG.EMAIL_HEADER;
  const keys = formHeaders_(rec);
  return keys.find(function (k) { return /e-?mail/i.test(k) && /@/.test(String(rec[k])); }) ||
    keys.find(function (k) { return /e-?mail/i.test(k); }) || null;
}

function detectNameHeaders_(rec) {
  if (CONFIG.NAME_HEADER) return [CONFIG.NAME_HEADER];
  const keys = formHeaders_(rec).filter(function (k) { return !/e-?mail/i.test(k); });
  const full = keys.find(function (k) { return /^name$|full\s*name|complete\s*name|your\s*name/i.test(k); });
  if (full) return [full];
  const first = keys.find(function (k) { return /first\s*name|given\s*name/i.test(k); });
  const last = keys.find(function (k) { return /last\s*name|surname|family\s*name/i.test(k); });
  if (first || last) return [first, last].filter(Boolean);
  const any = keys.find(function (k) { return /name/i.test(k); });
  return any ? [any] : [];
}

function recordToGuest_(rec) {
  const emailH = detectEmailHeader_(rec);
  const nameHs = detectNameHeaders_(rec);
  const name = nameHs.map(function (k) { return String(rec[k] || '').trim(); })
    .filter(Boolean).join(' ');

  const skip = ['Timestamp', emailH].concat(nameHs);
  const fields = CONFIG.DISPLAY_FIELDS.length
    ? CONFIG.DISPLAY_FIELDS
    : formHeaders_(rec).filter(function (k) { return skip.indexOf(k) === -1; });
  const details = fields
    .filter(function (k) { return k in rec && rec[k] !== ''; })
    .map(function (k) { return { label: k, value: rec[k] instanceof Date ? fmtDate_(rec[k]) : String(rec[k]) }; });

  const checkedAt = rec[COL.CHECKED_IN];
  return {
    id: String(rec[COL.ID] || '').trim(),
    name: name,
    email: emailH ? String(rec[emailH] || '').trim() : '',
    paid: isTruthy_(rec[COL.PAID]),
    checkedIn: !!checkedAt,
    checkedInAt: checkedAt instanceof Date ? fmtDate_(checkedAt) : String(checkedAt || ''),
    notes: String(rec[COL.NOTES] || ''),
    details: details,
  };
}

function isTruthy_(v) {
  if (v === true) return true;
  return /^(true|yes|y|paid|1|✓|✔)$/i.test(String(v).trim());
}

/** Accepts "SD-7K3MX-Q9P2A", "sd7k3mxq9p2a", "7K3MXQ9P2A" etc. */
function normalizeId_(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pre = CONFIG.ID_PREFIX.toUpperCase();
  if (s.length === pre.length + 10 && s.indexOf(pre) === 0) s = s.slice(pre.length);
  if (s.length !== 10) return null;
  return pre + '-' + s.slice(0, 5) + '-' + s.slice(5);
}

function newGuestId_(sheet, h) {
  const last = sheet.getLastRow();
  const existing = last > 1
    ? sheet.getRange(2, h[COL.ID], last - 1, 1).getValues().map(function (r) { return String(r[0]); })
    : [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Math.random());
    let s = '';
    for (let i = 0; i < 10; i++) s += ID_ALPHABET.charAt((bytes[i] + 256) % 32);
    const id = normalizeId_(s);
    if (existing.indexOf(id) === -1) return id;
  }
  throw new Error('could not generate a unique Guest ID');
}

function findGuest_(rawId) {
  const id = normalizeId_(rawId);
  if (!id) return null;
  const sheet = getSheet_();
  const h = headerMap_(sheet);
  if (!h[COL.ID] || sheet.getLastRow() < 2) return null;
  const cell = sheet.getRange(2, h[COL.ID], sheet.getLastRow() - 1, 1)
    .createTextFinder(id).matchEntireCell(true).findNext();
  if (!cell) return null;
  const row = cell.getRow();
  const values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  return { sheet: sheet, row: row, h: h, guest: recordToGuest_(rowToRecord_(h, values)) };
}

function appendNote_(sheet, row, h, note) {
  const cell = sheet.getRange(row, h[COL.NOTES]);
  const cur = String(cell.getValue() || '');
  cell.setValue(cur ? cur + '; ' + note : note);
}

function stats_() {
  const sheet = getSheet_();
  const h = headerMap_(sheet);
  const last = sheet.getLastRow();
  const s = { registered: 0, paid: 0, checkedIn: 0 };
  if (last < 2 || !h[COL.ID]) return s;
  const values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  values.forEach(function (r) {
    if (!String(r[h[COL.ID] - 1]).trim()) return;
    s.registered++;
    if (isTruthy_(r[h[COL.PAID] - 1])) s.paid++;
    if (r[h[COL.CHECKED_IN] - 1]) s.checkedIn++;
  });
  return s;
}

function fmtDate_(d) {
  return Utilities.formatDate(d, getSpreadsheet_().getSpreadsheetTimeZone(), 'MMM d, h:mm a');
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
