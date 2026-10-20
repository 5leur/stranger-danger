/**
 * Stranger Danger — Halloween party registration, payments + door check-in.
 *
 * Lives in the Apps Script project bound to the Google Sheet that collects
 * the Google Form responses. It:
 *   1. Gives every registrant a permanent Guest ID and emails them a
 *      "registration received — payment For Approval" notice.
 *   2. When an organizer sets Payment Status to "Approved", emails the guest
 *      their QR ticket as confirmation (again whenever more of an
 *      installment is approved).
 *   3. The day before the party, reminds installment guests about their
 *      balance (automatic, can be switched off, or sent by hand).
 *   4. During the party (walk-in mode), approves new registrations straight
 *      away: the doorman has checked the payment in person, so the guest gets
 *      a walk-in QR confirmation instead of the "For Approval" email.
 *   5. Exposes a PIN-protected JSON API for the bouncer's scanner page
 *      (docs/index.html): look up, collect proof of payment, check in.
 *
 * See README.md for setup steps.
 */

// ===================== Edit these for your event =====================
const CONFIG = {
  EVENT_NAME: 'Stranger Danger',
  EVENT_EDITION: 'Year 2',
  EVENT_TAGLINE: 'Halloween Party',
  EVENT_HIGHLIGHTS: 'Food | Booze | Prizes | Costumes',
  MUSIC_BY: 'GAAART',          // leave blank to hide
  EVENT_DATE: 'October 31, 2026',
  EVENT_TIME: '8:00 PM',
  EVENT_DATE_ISO: '2026-10-31', // used to time the installment reminders
  EVENT_VENUE: 'Providence Town Homes',

  TICKET_PRICE: 1200,
  TICKET_PRICE_LABEL: 'Door fee',
  CURRENCY: 'Php',
  INSTALLMENT_FIRST_PAYMENT: 600, // assumed when an installment is approved with Amount Paid blank
  PAYMENT_INSTRUCTIONS:
    'Please settle your payment with the organizers before the party. ' +
    'Guests who have not paid will be asked to pay at the door.',

  REMINDER_DAYS_BEFORE: 1,     // installment reminder goes out this many days before the party
  REMINDER_HOUR: 9,            // ...at about this hour (spreadsheet time zone)

  ORGANIZER_NAME: 'The Stranger Danger Crew',
  REPLY_TO: '',                // optional reply-to address for the emails
  // Distressed "WANTED / DEAD OR ALIVE" header cut from the poster
  // (docs/email/header.jpg). If it can't be fetched, a text header is used.
  EMAIL_HEADER_IMAGE_URL: 'https://raw.githubusercontent.com/5leur/stranger-danger/main/docs/email/header.jpg',

  // Walk-in button on the scanner opens this form. Blank = the form linked to the sheet.
  REGISTRATION_FORM_URL: '',
  // Walk-in mode: form submissions in this window (spreadsheet time zone) are approved
  // automatically as walk-ins. Can also be forced on/off from the 🎃 Party menu.
  WALK_IN_START: '2026-10-31T18:00',
  WALK_IN_END: '2026-11-01T06:00',
  WALK_IN_AUTO_CHECK_IN: true, // walk-ins are already at the door, so check them in straight away
  // Door photos are saved next to the form's own proof-of-payment uploads. This folder
  // is only used if the form has no file-upload question yet.
  DOOR_PROOF_FOLDER_NAME: 'Stranger Danger – door payment proofs',

  ID_PREFIX: 'SD',             // Guest IDs look like SD-7K3MX-Q9P2A
  SHEET_NAME: '',              // blank = the sheet linked to the form
  EMAIL_HEADER: '',            // blank = auto-detect a column containing "email"
  NAME_HEADER: '',             // blank = auto-detect name / first + last name
  PAYMENT_TYPE_HEADER: '',     // blank = auto-detect e.g. "Payment Type" / "Payment Option"
  PROOF_HEADER: '',            // blank = auto-detect the form's proof-of-payment upload
  INSTALLMENT_PATTERN: /install|partial|down\s*payment/i, // answers that mean "installment"
  DISPLAY_FIELDS: [],          // form questions to show the bouncer; [] = all except the ones below
  HIDDEN_FIELDS: /privacy|terms|condition|consent|agree/i, // consent checkboxes etc. never shown at the door
};
// =====================================================================

// Columns this script adds to the right of the form's columns.
const COL = {
  ID: 'Guest ID',
  STATUS: 'Payment Status',
  AMOUNT: 'Amount Paid',
  CONFIRMED: 'Confirmed Amount',       // amount covered by the last QR ticket email
  REG_EMAILED: 'Registration Emailed At',
  QR_EMAILED: 'QR Emailed At',
  REMINDED: 'Reminder Sent At',
  CHECKED_IN: 'Checked In At',
  DOOR_PROOF: 'Door Payment Proof',   // only added when the form has no proof-of-payment column
  NOTES: 'Door Notes',
};
const INTERNAL_COLS = Object.keys(COL).map(function (k) { return COL[k]; });
const STATUS = { PENDING: 'For Approval', APPROVED: 'Approved', REJECTED: 'Rejected' };
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const MAX_PIN_FAILS = 30;  // per 10 minutes, across all callers
const MAX_PHOTO_B64 = 12 * 1024 * 1024;

// ============================ Sheet menu =============================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎃 Party')
    .addItem('Run setup', 'setup')
    .addSeparator()
    .addItem('Send registration emails to rows not yet emailed', 'sendPendingRegistrations')
    .addItem('Send QR tickets to approved guests not yet emailed', 'sendPendingTickets')
    .addItem('Resend QR ticket to selected row(s)', 'resendSelected')
    .addItem('Mark selected row(s) as paid in full', 'markSelectedPaidInFull')
    .addSeparator()
    .addItem('Send installment reminders now', 'sendRemindersNow')
    .addItem('Turn automatic installment reminders on/off', 'toggleAutoReminders')
    .addSeparator()
    .addItem('Walk-in mode: automatic / on / off', 'cycleWalkInMode')
    .addSeparator()
    .addItem('Show door stats', 'showStats')
    .addItem('Change bouncer PIN', 'changePin')
    .addToUi();
}

/** Adds the extra columns, installs the triggers and sets the PIN. */
function setup() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  const sheet = getSheet_();
  ensureColumns_(sheet);

  const handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (handlers.indexOf('onFormSubmitTrigger') === -1) {
    ScriptApp.newTrigger('onFormSubmitTrigger').forSpreadsheet(ss).onFormSubmit().create();
  }
  if (handlers.indexOf('onSheetEdit') === -1) {
    ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  }
  if (handlers.indexOf('dailyReminderCheck') === -1) {
    ScriptApp.newTrigger('dailyReminderCheck').timeBased().everyDays(1).atHour(CONFIG.REMINDER_HOUR).create();
  }
  if (!getPin_()) changePin();

  ui.alert(
    'Setup complete',
    'Responses sheet: "' + sheet.getName() + '"\n\n' +
    '• New registrations get a Guest ID and a "payment For Approval" email.\n' +
    '• To approve a payment, set "' + COL.STATUS + '" to "' + STATUS.APPROVED + '" (and fill in "' +
    COL.AMOUNT + '"). The guest is emailed their QR ticket.\n' +
    '• Installment guests with a balance are reminded ' + daysLabel_(CONFIG.REMINDER_DAYS_BEFORE) +
    ' before the party (' + (autoRemindersOn_() ? 'automatic reminders are ON' : 'automatic reminders are OFF') + ').\n' +
    '• Walk-in mode: ' + walkInModeLabel_() + '\n' +
    '• For people who registered before setup, use the 🎃 Party menu to send their emails.\n' +
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

function sendPendingRegistrations() {
  forEachRow_('registration email(s)', function (sheet, row, h) { return processNewRow_(sheet, row, h); });
}

function sendPendingTickets() {
  forEachRow_('QR ticket(s)', function (sheet, row, h) { return syncTicket_(sheet, row, h, false); });
}

function forEachRow_(what, fn) {
  const ui = SpreadsheetApp.getUi();
  const sheet = getSheet_();
  ensureColumns_(sheet);
  const h = headerMap_(sheet);
  let sent = 0, skipped = 0;
  const errors = [];
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    if (MailApp.getRemainingDailyQuota() < 1) {
      errors.push('Daily email quota reached — run this again tomorrow.');
      break;
    }
    try {
      fn(sheet, row, h) === 'sent' ? sent++ : skipped++;
    } catch (err) {
      errors.push('Row ' + row + ': ' + err.message);
    }
  }
  ui.alert('Sent ' + sent + ' ' + what + ', skipped ' + skipped + '.' +
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
  const ok = ui.alert('Resend the QR ticket to ' + (last - first + 1) + ' guest(s)?\n' +
    'Only rows with Payment Status "' + STATUS.APPROVED + '" get one.', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  ensureColumns_(sheet);
  const h = headerMap_(sheet);
  const errors = [];
  let sent = 0;
  for (let row = first; row <= last; row++) {
    try {
      if (syncTicket_(sheet, row, h, true) === 'sent') sent++;
    } catch (err) {
      errors.push('Row ' + row + ': ' + err.message);
    }
  }
  ui.alert('Sent ' + sent + ' QR ticket(s).' + (errors.length ? '\n\nProblems:\n' + errors.join('\n') : ''));
}

/**
 * For installment guests who settle the balance before the party: approves the row,
 * sets Amount Paid to the full price and emails the "Paid in full" QR ticket.
 */
function markSelectedPaidInFull() {
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
  const ok = ui.alert('Mark ' + (last - first + 1) + ' guest(s) as paid in full (' + money_(CONFIG.TICKET_PRICE) + ')?\n' +
    'Each one is approved and emailed the "Paid in full" confirmation with their QR code.', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  ensureColumns_(sheet);
  const h = headerMap_(sheet);
  const errors = [];
  let sent = 0;
  withLock_(function () {
    for (let row = first; row <= last; row++) {
      try {
        if (markPaidInFull_(sheet, row, h) === 'sent') sent++;
      } catch (err) {
        errors.push('Row ' + row + ': ' + err.message);
      }
    }
  });
  ui.alert('Sent ' + sent + ' "Paid in full" confirmation(s).' +
    (errors.length ? '\n\nProblems:\n' + errors.join('\n') : ''));
}

function markPaidInFull_(sheet, row, h) {
  const found = readRow_(sheet, row, h);
  if (!found.guest.id) return 'skipped';
  const price = found.guest.price;
  if (parseAmount_(found.rec[COL.AMOUNT]) < price) sheet.getRange(row, h[COL.AMOUNT]).setValue(price);
  if (found.guest.status !== STATUS.APPROVED) sheet.getRange(row, h[COL.STATUS]).setValue(STATUS.APPROVED);
  return syncTicket_(sheet, row, h, false);
}

function sendRemindersNow() {
  const ui = SpreadsheetApp.getUi();
  const due = reminderCandidates_();
  if (!due.length) {
    ui.alert('No installment guests with a balance are waiting for a reminder.');
    return;
  }
  const ok = ui.alert('Email a balance reminder to ' + due.length + ' installment guest(s)?\n' +
    'Guests who already got one are skipped.', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  const res = sendInstallmentReminders_();
  ui.alert('Sent ' + res.sent + ' reminder(s).' + (res.errors.length ? '\n\nProblems:\n' + res.errors.join('\n') : ''));
}

function toggleAutoReminders() {
  const on = !autoRemindersOn_();
  PropertiesService.getScriptProperties().setProperty('AUTO_REMINDERS', on ? 'on' : 'off');
  SpreadsheetApp.getUi().alert(on
    ? 'Automatic installment reminders are ON. They go out on ' + reminderDateIso_() +
      ' (' + daysLabel_(CONFIG.REMINDER_DAYS_BEFORE) + ' before the party), around ' + CONFIG.REMINDER_HOUR + ':00.'
    : 'Automatic installment reminders are OFF. You can still use "Send installment reminders now".');
}

function cycleWalkInMode() {
  const order = ['auto', 'on', 'off'];
  const props = PropertiesService.getScriptProperties();
  const cur = props.getProperty('WALK_IN_MODE') || 'auto';
  props.setProperty('WALK_IN_MODE', order[(order.indexOf(cur) + 1) % order.length]);
  SpreadsheetApp.getUi().alert('Walk-in mode: ' + walkInModeLabel_() + '\n\n' +
    'While walk-in mode is active, new form submissions are approved automatically (the doorman checks ' +
    'the payment in person), get a walk-in QR confirmation instead of the "For Approval" email' +
    (CONFIG.WALK_IN_AUTO_CHECK_IN ? ', and are checked in.' : '.') +
    '\n\nChoose this menu item again to switch between automatic / on / off.');
}

function showStats() {
  const s = stats_();
  SpreadsheetApp.getUi().alert(
    'Door stats',
    'Registered: ' + s.registered +
    '\nPayment for approval: ' + s.pending +
    '\nPaid in full: ' + s.paid +
    '\nPartially paid (installment): ' + s.partial +
    '\nChecked in: ' + s.checkedIn,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ============================== Triggers =============================

function onFormSubmitTrigger(e) {
  withLock_(function () {
    const sheet = e && e.range ? e.range.getSheet() : getSheet_();
    const row = e && e.range ? e.range.getRow() : sheet.getLastRow();
    ensureColumns_(sheet);
    const h = headerMap_(sheet);
    if (walkInActive_()) processWalkIn_(sheet, row, h);
    else processNewRow_(sheet, row, h);
  });
}

/** Installable on-edit trigger: approving a payment (or more of one) emails the QR ticket. */
function onSheetEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getSheetId() !== getSheet_().getSheetId()) return;
  const h = headerMap_(sheet);
  const c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
  const typeCol = h[detectPaymentTypeHeader_(h)];
  const inRange = function (c) { return c && c >= c1 && c <= c2; };
  const typeEdited = inRange(typeCol);
  if (!inRange(h[COL.STATUS]) && !inRange(h[COL.AMOUNT]) && !typeEdited) return;

  const problems = [];
  withLock_(function () {
    for (let row = Math.max(2, e.range.getRow()); row <= e.range.getLastRow(); row++) {
      try {
        // Switching an approved installment guest's Payment Type to a full payment
        // means they've settled the balance: treat it as paid in full.
        if (typeEdited) {
          const found = readRow_(sheet, row, h);
          if (found.guest.status === STATUS.APPROVED && !found.guest.installment &&
              parseAmount_(found.rec[COL.AMOUNT]) < found.guest.price &&
              /full/i.test(String(found.rec[detectPaymentTypeHeader_(h)] || ''))) {
            sheet.getRange(row, h[COL.AMOUNT]).setValue(found.guest.price);
          }
        }
        if (syncTicket_(sheet, row, h, false) === 'sent') {
          toast_('QR ticket emailed for row ' + row + '.');
        }
      } catch (err) {
        problems.push('Row ' + row + ': ' + err.message);
      }
    }
  });
  if (problems.length) toast_(problems.join('\n'), 'Could not send QR ticket');
}

/** Daily time trigger: sends installment reminders once the reminder date arrives. */
function dailyReminderCheck() {
  if (!autoRemindersOn_()) return;
  const today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  if (today < reminderDateIso_() || today > CONFIG.EVENT_DATE_ISO) return;
  withLock_(function () { sendInstallmentReminders_(); });
}

// =========================== Row processing ==========================

/** New registration: Guest ID, "For Approval" status, registration email. */
function processNewRow_(sheet, row, h) {
  const found = readRow_(sheet, row, h);
  const g = found.guest;
  if (!g.email && !g.name) return 'skipped'; // blank row

  if (!g.id) {
    g.id = newGuestId_(sheet, h);
    sheet.getRange(row, h[COL.ID]).setValue(g.id);
  }
  formatRow_(sheet, row, h, found.rec);
  if (!found.rec[COL.STATUS]) {
    sheet.getRange(row, h[COL.STATUS]).setValue(STATUS.PENDING);
    g.status = STATUS.PENDING;
  }
  if (found.rec[COL.REG_EMAILED]) return 'skipped';
  if (!g.email) throw new Error('no email address in this row');

  sendEmail_('registration', g);
  sheet.getRange(row, h[COL.REG_EMAILED]).setValue(new Date());
  return 'sent';
}

/**
 * Walk-in registered at the door during the party: the doorman has already
 * checked the full payment, so approve it, skip the "For Approval" email and
 * send the QR confirmation straight away.
 */
function processWalkIn_(sheet, row, h) {
  const found = readRow_(sheet, row, h);
  const g = found.guest;
  if (!g.email && !g.name) return 'skipped';
  if (!g.id) {
    g.id = newGuestId_(sheet, h);
    sheet.getRange(row, h[COL.ID]).setValue(g.id);
  }
  formatRow_(sheet, row, h, found.rec);
  const now = new Date();
  const amount = Math.max(parseAmount_(found.rec[COL.AMOUNT]), g.price);
  sheet.getRange(row, h[COL.STATUS]).setValue(STATUS.APPROVED);
  sheet.getRange(row, h[COL.AMOUNT]).setValue(amount);
  sheet.getRange(row, h[COL.CONFIRMED]).setValue(amount);
  if (CONFIG.WALK_IN_AUTO_CHECK_IN) sheet.getRange(row, h[COL.CHECKED_IN]).setValue(now);
  appendNote_(sheet, row, h, 'Walk-in ' + fmtDate_(now));
  if (!g.email) throw new Error('no email address in this row');

  const ticket = readRow_(sheet, row, h).guest;
  sendEmail_('walkin', ticket);
  sheet.getRange(row, h[COL.QR_EMAILED]).setValue(now);
  return 'sent';
}

/**
 * Emails the QR ticket when a payment is approved and the approved amount is
 * more than what the last ticket email covered (or always, with `force`).
 */
function syncTicket_(sheet, row, h, force) {
  const found = readRow_(sheet, row, h);
  const g = found.guest;
  if (!g.id || g.status !== STATUS.APPROVED) return 'skipped';

  if (found.rec[COL.AMOUNT] === '' || found.rec[COL.AMOUNT] == null) {
    const assumed = g.installment ? Math.min(CONFIG.INSTALLMENT_FIRST_PAYMENT, g.price) : g.price;
    sheet.getRange(row, h[COL.AMOUNT]).setValue(assumed);
    return syncTicket_(sheet, row, h, force);
  }
  const confirmed = parseAmount_(found.rec[COL.CONFIRMED]);
  if (!force && g.amountPaid <= confirmed) return 'skipped';
  if (g.amountPaid <= 0) return 'skipped';
  if (!g.email) throw new Error('no email address in this row');

  sendEmail_('ticket', g);
  sheet.getRange(row, h[COL.CONFIRMED]).setValue(Math.max(confirmed, g.amountPaid));
  sheet.getRange(row, h[COL.QR_EMAILED]).setValue(new Date());
  return 'sent';
}

function reminderCandidates_() {
  const sheet = getSheet_();
  ensureColumns_(sheet);
  const h = headerMap_(sheet);
  const out = [];
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    const found = readRow_(sheet, row, h);
    const g = found.guest;
    if (g.id && g.email && g.installment && g.balance > 0 && g.status !== STATUS.REJECTED &&
        !found.rec[COL.REMINDED]) {
      out.push({ row: row, guest: g });
    }
  }
  return out;
}

function sendInstallmentReminders_() {
  const sheet = getSheet_();
  const h = headerMap_(sheet);
  const res = { sent: 0, errors: [] };
  reminderCandidates_().forEach(function (c) {
    if (MailApp.getRemainingDailyQuota() < 1) {
      res.errors.push('Daily email quota reached at row ' + c.row + '.');
      return;
    }
    try {
      sendEmail_('reminder', c.guest);
      sheet.getRange(c.row, h[COL.REMINDED]).setValue(new Date());
      res.sent++;
    } catch (err) {
      res.errors.push('Row ' + c.row + ': ' + err.message);
    }
  });
  return res;
}

function formatRow_(sheet, row, h, rec) {
  const status = sheet.getRange(row, h[COL.STATUS]);
  if (!status.getDataValidation()) {
    status.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList([STATUS.PENDING, STATUS.APPROVED, STATUS.REJECTED], true)
      .setAllowInvalid(false).build());
  }
  sheet.getRange(row, h[COL.AMOUNT]).setNumberFormat('#,##0.##');
}

// ============================== Email ================================

// Poster palette (see the event poster): oxblood background, bone-white type.
const EMAIL_STYLE = {
  BG: '#5a1616',
  BG_DARK: '#3d0e0d',
  CREAM: '#fff4e2',
  BONE: '#d9cfc0',
  WALL: '#c9c6c1',     // mugshot-lineup wall behind the QR
  INK: '#1b1414',
  FONT: "'DIN Condensed','Oswald','Bebas Neue','Arial Narrow','Helvetica Neue',Arial,sans-serif",
  STENCIL: "Impact,'Haettenschweiler','Arial Narrow Bold','DIN Condensed',sans-serif",
  MONO: "'Courier New',Courier,monospace",
  BODY: 'Arial,Helvetica,sans-serif',
};

/** kind: 'registration' | 'ticket' | 'walkin' | 'reminder' */
function sendEmail_(kind, guest) {
  const inlineImages = {};
  const attachments = [];
  if (kind === 'ticket' || kind === 'walkin') {
    const qr = qrPng_(guest.id);
    inlineImages.qrcode = qr;
    attachments.push(qr.copyBlob().setName(guest.id + '.png'));
  }
  const header = headerImage_();
  if (header) inlineImages.header = header;

  const event = CONFIG.EVENT_NAME + ' ' + CONFIG.EVENT_EDITION;
  const subject = {
    registration: 'Registration received: ' + event + ' (payment for approval)',
    ticket: (guest.balance > 0 ? 'Installment approved' : 'Payment confirmed') + ': your QR ticket to ' + event,
    walkin: 'Walk-in confirmed: your QR ticket to ' + event,
    reminder: 'Reminder: ' + money_(guest.balance) + ' balance for ' + event,
  }[kind];

  const opts = {
    to: guest.email,
    subject: subject,
    htmlBody: buildEmailHtml_(kind, guest, !!header),
    body: buildEmailText_(kind, guest),
    name: CONFIG.ORGANIZER_NAME,
    inlineImages: inlineImages,
    attachments: attachments,
  };
  if (CONFIG.REPLY_TO) opts.replyTo = CONFIG.REPLY_TO;
  MailApp.sendEmail(opts);
}

/** The poster's header art, cached for 6 hours so bulk sends fetch it once. */
function headerImage_() {
  if (!CONFIG.EMAIL_HEADER_IMAGE_URL) return null;
  const cache = CacheService.getScriptCache();
  const key = 'hdr:' + CONFIG.EMAIL_HEADER_IMAGE_URL;
  try {
    const hit = cache.get(key);
    if (hit) return Utilities.newBlob(Utilities.base64Decode(hit), 'image/jpeg', 'header.jpg');
    const res = UrlFetchApp.fetch(CONFIG.EMAIL_HEADER_IMAGE_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const blob = res.getBlob().setName('header.jpg');
    const b64 = Utilities.base64Encode(blob.getBytes());
    if (b64.length < 100000) cache.put(key, b64, 21600);
    return blob;
  } catch (err) {
    return null;
  }
}

/** What each email says. Kept apart from the layout so the wording is easy to edit. */
function emailCopy_(kind, g) {
  // Names come in as "Last, First Middle" or "First Last".
  const name = String(g.name || '').trim();
  const given = name.indexOf(',') !== -1 ? name.slice(name.indexOf(',') + 1) : name;
  const first = given.trim().split(/\s+/)[0] || 'friend';
  const balance = money_(g.balance);
  if (kind === 'registration') {
    return {
      heading: 'Registration received',
      intro: 'Thanks, ' + first + '. You\'re registered. Our crew is checking your payment now. ' +
        'Once it\'s approved, you\'ll get a second email with your QR ticket for the door.',
      status: { label: 'Payment: For approval', note: 'We\'ll email you as soon as your payment is verified.', filled: false },
      fine: 'Keep your Guest ID handy: ' + g.id + '. If anything about your registration is wrong, just reply to this email.',
    };
  }
  if (kind === 'reminder') {
    const days = daysUntilEvent_();
    return {
      heading: days > 1 ? days + ' days to go' : days === 1 ? 'One day to go' : 'It\'s party time',
      intro: 'Hi ' + first + ', you chose to pay in installments and still have a balance of ' + balance +
        '. You\'ll need to settle it before entering the party: send it ahead of time, or pay at the door ' +
        'by cash or digital banking.',
      status: { label: 'Balance due: ' + balance, note: CONFIG.PAYMENT_INSTRUCTIONS, filled: false },
      fine: 'Already sent it? You can ignore this. We\'ll email your updated ticket once the payment is approved. ' +
        'Your Guest ID is ' + g.id + '.',
    };
  }
  if (kind === 'walkin') {
    return {
      heading: 'Walk-in confirmed',
      intro: 'Welcome to the party, ' + first + '. You registered at the door and our doorman checked your ' +
        'payment in person. This is your QR ticket. Keep it handy in case you step out and come back in.',
      status: { label: '✓ Paid in full · walk-in', note: 'You\'re cleared for entry. See you on the other side.', filled: true },
      fine: 'Your QR code belongs to you alone, so don\'t share it. The QR is also attached as an image.',
    };
  }
  // ticket
  if (g.balance > 0) {
    return {
      heading: 'Installment approved',
      intro: 'Hi ' + first + ', your installment payment of ' + money_(g.amountPaid) + ' has been approved. ' +
        'This is your QR ticket, but you will only be let in once your ticket is paid in full.',
      status: { label: 'Partially paid · balance ' + balance,
        note: money_(g.amountPaid) + ' of ' + money_(g.price) + ' received. Pay the remaining ' + balance +
          ' in person at the door (cash or digital banking). The doorman will record it, then let you in.',
        filled: false },
      fine: 'Your QR code belongs to you alone, so don\'t share it. Screenshot it or keep this email handy, ' +
        'and turn your brightness up at the door. The QR is also attached as an image.',
    };
  }
  return {
    heading: 'Payment confirmed',
    intro: 'You\'re on the list, ' + first + '. This is your QR ticket. Show it to the bouncer at the door.',
    status: { label: '✓ Paid in full', note: 'You\'re cleared for entry. See you on the other side.', filled: true },
    fine: 'Your QR code belongs to you alone, so don\'t share it. Screenshot it or keep this email handy, ' +
      'and turn your brightness up at the door. The QR is also attached as an image.',
  };
}

function buildEmailHtml_(kind, guest, hasHeaderImage) {
  const S = EMAIL_STYLE;
  const copy = emailCopy_(kind, guest);
  const up = function (s) { return esc_(String(s == null ? '' : s).toUpperCase()); };
  const txt = function (size, extra) {
    return 'font-family:' + S.FONT + ';font-weight:700;font-size:' + size + 'px;line-height:1.05;' +
      'color:' + S.CREAM + ';text-transform:uppercase;' + (extra || '');
  };

  const header = hasHeaderImage
    ? '<img src="cid:header" width="520" alt="' + up(CONFIG.EVENT_NAME) + ' ' + up(CONFIG.EVENT_EDITION) +
      ' – WANTED: DEAD OR ALIVE" style="display:block;width:100%;max-width:520px;height:auto;border:0;">'
    : '<table role="presentation" cellpadding="0" cellspacing="0" width="100%">' +
      '<tr><td style="padding:28px 32px 0;' + txt(18) + '">' + up(CONFIG.EVENT_NAME) + '</td>' +
      '<td align="right" style="padding:28px 32px 0;' + txt(18) + '">' + up(CONFIG.EVENT_EDITION) + '</td></tr>' +
      '<tr><td colspan="2" align="center" style="padding:14px 24px 0;font-family:' + S.STENCIL + ';font-size:96px;' +
      'line-height:1;letter-spacing:4px;color:' + S.BONE + ';">WANTED</td></tr>' +
      '<tr><td colspan="2" align="center" style="padding:6px 24px 4px;' + txt(26, 'letter-spacing:16px;') + '">' +
      'DEAD OR ALIVE</td></tr></table>';

  // Mugshot frame: the QR on a ticket, a "pending" card on the registration email.
  const centerpiece = (kind === 'ticket' || kind === 'walkin')
    ? '<div style="display:inline-block;background:#ffffff;padding:12px;">' +
      '<img src="cid:qrcode" width="220" height="220" alt="Your entry QR code" style="display:block;border:0;">' +
      '</div>'
    : '<table role="presentation" cellpadding="0" cellspacing="0" width="244" bgcolor="#ffffff" style="background:#ffffff;">' +
      '<tr><td align="center" height="200" style="padding:22px 16px;border:2px dashed ' + S.BG + ';">' +
      '<div style="' + txt(30, 'color:' + S.BG + ';letter-spacing:1px;') + '">QR ticket<br>pending</div>' +
      '<div style="margin-top:10px;font-family:' + S.BODY + ';font-size:13px;line-height:1.4;color:' + S.INK + ';">' +
      'Arrives by email once your payment is approved.</div></td></tr></table>';

  const frame = kind === 'reminder' ? '' :
    '<tr><td style="padding:22px 28px 0;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="' + S.WALL + '" ' +
    'style="background:' + S.WALL + ';border:3px solid ' + S.CREAM + ';">' +
    '<tr><td align="center" style="padding:26px 16px 0;">' + centerpiece + '</td></tr>' +
    // the placard the suspect holds
    '<tr><td align="center" style="padding:16px 10px 22px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" bgcolor="' + S.INK + '" style="background:' + S.INK + ';">' +
    '<tr><td class="sd-name" align="center" style="padding:10px 16px 4px;' + txt(24, 'letter-spacing:1px;word-break:break-word;') + '">' +
    up(guest.name || 'Unknown suspect') + '</td></tr>' +
    '<tr><td align="center" style="padding:0 20px 10px;font-family:' + S.MONO + ';font-size:15px;font-weight:700;' +
    'letter-spacing:2px;color:' + S.BONE + ';">' + esc_(guest.id) + '</td></tr>' +
    '</table></td></tr></table>' +
    '</td></tr>';

  const musicLine = CONFIG.MUSIC_BY
    ? '<br>MUSIC BY <span style="text-decoration:underline;">' + up(CONFIG.MUSIC_BY) + '</span>'
    : '';

  const price = CONFIG.TICKET_PRICE
    ? '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="' + txt(56, 'line-height:0.9;letter-spacing:-1px;') + 'padding-right:6px;">' + up(CONFIG.TICKET_PRICE) + '</td>' +
      '<td style="' + txt(20, 'line-height:0.95;') + 'vertical-align:middle;">' +
      up(CONFIG.TICKET_PRICE_LABEL).replace(' ', '<br>') + '</td></tr></table>'
    : '';

  const st = copy.status;
  const stFg = st.filled ? S.BG : S.CREAM;

  return '' +
    '<style>@media only screen and (max-width:480px){' +
    '.sd-stack{display:block!important;width:100%!important;text-align:left!important;padding:0 0 14px!important;}' +
    '.sd-name{font-size:20px!important;}}</style>' +
    '<div style="margin:0;padding:24px 8px;background:' + S.BG_DARK + ';">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="' + S.BG + '" ' +
    'style="max-width:520px;margin:0 auto;background:' + S.BG + ';">' +

    // WANTED / DEAD OR ALIVE
    '<tr><td style="padding:0;">' + header + '</td></tr>' +

    frame +

    // heading + intro
    '<tr><td style="padding:26px 28px 0;">' +
    '<div style="' + txt(30, 'letter-spacing:1px;') + '">' + up(copy.heading) + '</div>' +
    '<div style="margin-top:8px;font-family:' + S.BODY + ';font-size:15px;line-height:1.5;color:' + S.CREAM + ';">' +
    esc_(copy.intro) + '</div></td></tr>' +

    // payment status
    '<tr><td style="padding:20px 28px 0;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:2px solid ' + S.CREAM + ';">' +
    '<tr><td bgcolor="' + (st.filled ? S.CREAM : S.BG) + '" style="padding:12px 16px;background:' +
    (st.filled ? S.CREAM : 'transparent') + ';">' +
    '<div style="' + txt(20, 'color:' + stFg + ';letter-spacing:1px;') + '">' + up(st.label) + '</div>' +
    '<div style="margin-top:4px;font-family:' + S.BODY + ';font-size:13px;line-height:1.45;color:' + stFg + ';">' +
    esc_(st.note) + '</div>' +
    '</td></tr></table></td></tr>' +

    // HALLOWEEN PARTY | FOOD | BOOZE ...
    '<tr><td style="padding:26px 28px 0;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>' +
    '<td class="sd-stack" valign="top" width="30%" style="' + txt(20) + 'padding-right:8px;">' +
    up(CONFIG.EVENT_TAGLINE).replace(' ', '<br>') + '</td>' +
    '<td class="sd-stack" valign="top" align="right" style="' + txt(15, 'line-height:1.3;') + '">' +
    up(CONFIG.EVENT_HIGHLIGHTS) + musicLine + '</td>' +
    '</tr></table></td></tr>' +

    // divider
    '<tr><td style="padding:22px 28px 0;"><div style="height:2px;line-height:2px;font-size:0;background:' +
    S.CREAM + ';">&nbsp;</div></td></tr>' +

    // 1200 DOOR FEE | venue / date / time
    '<tr><td style="padding:22px 28px 0;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>' +
    '<td class="sd-stack" valign="middle" width="46%" style="padding-right:10px;">' + price + '</td>' +
    '<td class="sd-stack" valign="middle" align="right" style="' + txt(15, 'line-height:1.3;') + '">' +
    up(CONFIG.EVENT_VENUE) + '<br>' + up(CONFIG.EVENT_DATE) + '<br>' + up(CONFIG.EVENT_TIME) + '</td>' +
    '</tr></table></td></tr>' +

    // fine print
    '<tr><td style="padding:22px 28px 30px;font-family:' + S.BODY + ';font-size:13px;line-height:1.55;' +
    'color:' + S.BONE + ';">' + esc_(copy.fine) +
    '<div style="margin-top:14px;' + txt(15, 'color:' + S.BONE + ';letter-spacing:1px;') + '">' +
    up(CONFIG.ORGANIZER_NAME) + '</div>' +
    '</td></tr>' +

    '</table></div>';
}

function buildEmailText_(kind, g) {
  const copy = emailCopy_(kind, g);
  return [
    'WANTED: DEAD OR ALIVE',
    CONFIG.EVENT_NAME + ' ' + CONFIG.EVENT_EDITION + ' / ' + CONFIG.EVENT_TAGLINE,
    '',
    copy.heading.toUpperCase(),
    copy.intro,
    '',
    copy.status.label.toUpperCase() + ': ' + copy.status.note,
    '',
    'Guest ID: ' + g.id + (kind === 'ticket' || kind === 'walkin' ? ' (QR code attached, show it at the door)' : ''),
    '',
    CONFIG.EVENT_VENUE,
    CONFIG.EVENT_DATE + ', ' + CONFIG.EVENT_TIME,
    CONFIG.TICKET_PRICE ? CONFIG.TICKET_PRICE_LABEL + ': ' + money_(CONFIG.TICKET_PRICE) : '',
    CONFIG.EVENT_HIGHLIGHTS + (CONFIG.MUSIC_BY ? ' | Music by ' + CONFIG.MUSIC_BY : ''),
    '',
    copy.fine,
    '',
    CONFIG.ORGANIZER_NAME,
  ].join('\n');
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
  return respond_(function () { return handleApi_((e && e.parameter) || {}); });
}

/** POST carries the proof-of-payment photo (JSON body, sent as text/plain). */
function doPost(e) {
  return respond_(function () {
    let body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { /* empty */ }
    return handleApi_(body);
  });
}

function respond_(fn) {
  let out;
  try {
    out = fn();
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
      return { ok: true, event: CONFIG.EVENT_NAME, stats: stats_(), formUrl: registrationFormUrl_() };

    case 'stats':
      return { ok: true, stats: stats_() };

    case 'lookup': {
      const found = findGuest_(p.id);
      if (!found) return { ok: false, error: 'not_found' };
      return { ok: true, guest: found.guest };
    }

    case 'collect':
      return withLock_(function () {
        const found = findGuest_(p.id);
        if (!found) return { ok: false, error: 'not_found' };
        const g = found.guest;
        if (g.paid) return { ok: true, already: true, guest: g };
        const photo = String(p.photo || '').replace(/^data:image\/\w+;base64,/, '');
        if (!photo) return { ok: false, error: 'no_photo' };
        if (photo.length > MAX_PHOTO_B64) return { ok: false, error: 'photo_too_large' };

        const now = new Date();
        const sheet = found.sheet, row = found.row, h = found.h;
        const proofH = detectProofHeader_(found.rec);
        const file = doorProofFolder_(sheet, h, proofH).createFile(Utilities.newBlob(
          Utilities.base64Decode(photo), 'image/jpeg',
          g.id + ' ' + (g.name || 'guest') + ' ' + Utilities.formatDate(now, tz_(), 'yyyy-MM-dd HHmm') + '.jpg'));

        const collected = g.price - g.amountPaid;
        // Attach the photo to the guest's own form submission (its proof-of-payment cell),
        // falling back to the script's own column if the form has no upload question.
        const proofCol = (proofH && h[proofH]) || h[COL.DOOR_PROOF];
        if (!proofCol) throw new Error('no proof-of-payment column; run 🎃 Party → Run setup');
        const prevProof = String(sheet.getRange(row, proofCol).getValue() || '');
        sheet.getRange(row, proofCol).setValue(prevProof ? prevProof + ', ' + file.getUrl() : file.getUrl());
        sheet.getRange(row, h[COL.AMOUNT]).setValue(g.price);
        sheet.getRange(row, h[COL.STATUS]).setValue(STATUS.APPROVED);
        // Paid at the door: no confirmation email needed.
        sheet.getRange(row, h[COL.CONFIRMED]).setValue(g.price);
        appendNote_(sheet, row, h, 'Collected ' + money_(collected) + ' at door ' + fmtDate_(now));
        SpreadsheetApp.flush();
        return { ok: true, collected: collected, guest: findGuest_(p.id).guest };
      });

    case 'admit':
      return withLock_(function () {
        const found = findGuest_(p.id);
        if (!found) return { ok: false, error: 'not_found' };
        const g = found.guest;
        if (g.checkedIn) return { ok: true, already: true, guest: g };
        if (!g.paid) return { ok: false, error: 'not_paid', guest: g };
        found.sheet.getRange(found.row, found.h[COL.CHECKED_IN]).setValue(new Date());
        SpreadsheetApp.flush();
        return { ok: true, admitted: true, guest: findGuest_(p.id).guest };
      });

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

/**
 * Where door photos go: the Drive folder the form already saves its proof-of-payment
 * uploads in, so every guest's proofs sit together. Falls back to a folder of our own.
 */
function doorProofFolder_(sheet, h, proofH) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DOOR_PROOF_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* deleted — find or make another */ }
  }
  let folder = null;
  if (proofH && h[proofH] && sheet.getLastRow() > 1) {
    const cells = sheet.getRange(2, h[proofH], sheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < cells.length && !folder; i++) {
      const fileId = extractUrls_(cells[i][0]).map(driveFileId_).filter(Boolean)[0];
      if (!fileId) continue;
      try {
        const parents = DriveApp.getFileById(fileId).getParents();
        if (parents.hasNext()) folder = parents.next();
      } catch (err) { /* no access to that file — try the next row */ }
    }
  }
  folder = folder || DriveApp.createFolder(CONFIG.DOOR_PROOF_FOLDER_NAME);
  props.setProperty('DOOR_PROOF_FOLDER_ID', folder.getId());
  return folder;
}

function driveFileId_(url) {
  const m = String(url).match(/[?&]id=([\w-]{10,})/) || String(url).match(/\/d\/([\w-]{10,})/);
  return m ? m[1] : null;
}

function registrationFormUrl_() {
  if (CONFIG.REGISTRATION_FORM_URL) return CONFIG.REGISTRATION_FORM_URL;
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('FORM_URL');
  if (cached) return cached;
  try {
    const url = FormApp.openByUrl(getSheet_().getFormUrl()).getPublishedUrl();
    props.setProperty('FORM_URL', url);
    return url;
  } catch (err) {
    return '';
  }
}

// ============================= Helpers ===============================

function getPin_() {
  return PropertiesService.getScriptProperties().getProperty('BOUNCER_PIN');
}

/** Walk-in mode: 'auto' follows WALK_IN_START/END; 'on'/'off' are set from the menu. */
function walkInActive_() {
  const mode = PropertiesService.getScriptProperties().getProperty('WALK_IN_MODE') || 'auto';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  const now = Utilities.formatDate(new Date(), tz_(), "yyyy-MM-dd'T'HH:mm");
  return now >= CONFIG.WALK_IN_START && now < CONFIG.WALK_IN_END;
}

function walkInModeLabel_() {
  const mode = PropertiesService.getScriptProperties().getProperty('WALK_IN_MODE') || 'auto';
  if (mode === 'on') return 'ON (forced from the menu)';
  if (mode === 'off') return 'OFF (forced from the menu)';
  return 'AUTOMATIC, ' + CONFIG.WALK_IN_START.replace('T', ' ') + ' to ' + CONFIG.WALK_IN_END.replace('T', ' ') +
    ' (currently ' + (walkInActive_() ? 'active' : 'inactive') + ')';
}

function daysLabel_(n) {
  return n === 1 ? '1 day' : n + ' days';
}

function autoRemindersOn_() {
  return PropertiesService.getScriptProperties().getProperty('AUTO_REMINDERS') !== 'off';
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function toast_(msg, title) {
  try { getSpreadsheet_().toast(msg, title || '🎃 Party', 8); } catch (err) { /* no UI */ }
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

function tz_() {
  return getSpreadsheet_().getSpreadsheetTimeZone();
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
  const hasFormProof = !!detectProofHeader_(h);
  INTERNAL_COLS.forEach(function (name) {
    if (h[name]) return;
    if (name === COL.DOOR_PROOF && hasFormProof) return; // door photos go into the form's own column
    if (next > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), 1);
    sheet.getRange(1, next).setValue(name).setFontWeight('bold').setBackground('#ffe0c2');
    next++;
  });
}

function readRow_(sheet, row, h) {
  const values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rec = rowToRecord_(h, values);
  return { sheet: sheet, row: row, h: h, rec: rec, guest: recordToGuest_(rec) };
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
  const any = keys.find(function (k) { return /name/i.test(k) && !/referr?al|refer/i.test(k); });
  return any ? [any] : [];
}

function detectPaymentTypeHeader_(rec) {
  if (CONFIG.PAYMENT_TYPE_HEADER) return CONFIG.PAYMENT_TYPE_HEADER;
  return formHeaders_(rec).find(function (k) {
    return /payment\s*(type|option|plan|method|scheme|mode|term)|install/i.test(k);
  }) || null;
}

function detectProofHeader_(rec) {
  if (CONFIG.PROOF_HEADER) return CONFIG.PROOF_HEADER;
  return formHeaders_(rec).find(function (k) { return /proof|receipt|screenshot/i.test(k); }) || null;
}

function recordToGuest_(rec) {
  const emailH = detectEmailHeader_(rec);
  const nameHs = detectNameHeaders_(rec);
  const typeH = detectPaymentTypeHeader_(rec);
  const proofH = detectProofHeader_(rec);
  const name = nameHs.map(function (k) { return String(rec[k] || '').trim(); })
    .filter(Boolean).join(' ');

  const skip = ['Timestamp', emailH, proofH].concat(nameHs);
  const fields = CONFIG.DISPLAY_FIELDS.length
    ? CONFIG.DISPLAY_FIELDS
    : formHeaders_(rec).filter(function (k) { return skip.indexOf(k) === -1 && !CONFIG.HIDDEN_FIELDS.test(k); });
  const details = fields
    .filter(function (k) { return k in rec && rec[k] !== ''; })
    .map(function (k) { return { label: k, value: rec[k] instanceof Date ? fmtDate_(rec[k]) : String(rec[k]) }; });

  const status = String(rec[COL.STATUS] || '').trim() || STATUS.PENDING;
  const price = Number(CONFIG.TICKET_PRICE) || 0;
  const amountPaid = status === STATUS.APPROVED ? parseAmount_(rec[COL.AMOUNT]) : 0;
  const proofs = extractUrls_(proofH ? rec[proofH] : '').concat(extractUrls_(rec[COL.DOOR_PROOF]));
  const checkedAt = rec[COL.CHECKED_IN];

  return {
    id: String(rec[COL.ID] || '').trim(),
    name: name,
    email: emailH ? String(rec[emailH] || '').trim() : '',
    status: status,
    installment: !!(typeH && CONFIG.INSTALLMENT_PATTERN.test(String(rec[typeH] || ''))),
    price: price,
    amountPaid: amountPaid,
    balance: Math.max(0, price - amountPaid),
    paid: status === STATUS.APPROVED && amountPaid >= price,
    currency: CONFIG.CURRENCY,
    proofs: proofs,
    checkedIn: !!checkedAt,
    checkedInAt: checkedAt instanceof Date ? fmtCheckIn_(checkedAt) : String(checkedAt || ''),
    notes: String(rec[COL.NOTES] || ''),
    details: details,
  };
}

function parseAmount_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}

function extractUrls_(v) {
  return String(v || '').match(/https?:\/\/[^\s,]+/g) || [];
}

function money_(n) {
  const num = Number(n) || 0;
  const s = Math.round(num) === num ? String(num) : num.toFixed(2);
  return CONFIG.CURRENCY + ' ' + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** yyyy-MM-dd of the day the installment reminders go out. */
function reminderDateIso_() {
  const p = CONFIG.EVENT_DATE_ISO.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] - CONFIG.REMINDER_DAYS_BEFORE));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function daysUntilEvent_() {
  const p = CONFIG.EVENT_DATE_ISO.split('-').map(Number);
  const t = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd').split('-').map(Number);
  return Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(t[0], t[1] - 1, t[2])) / 86400000);
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
  return readRow_(sheet, cell.getRow(), h);
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
  const s = { registered: 0, pending: 0, paid: 0, partial: 0, checkedIn: 0 };
  if (last < 2 || !h[COL.ID]) return s;
  const values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  values.forEach(function (r) {
    const g = recordToGuest_(rowToRecord_(h, r));
    if (!g.id) return;
    s.registered++;
    if (g.status === STATUS.PENDING) s.pending++;
    if (g.paid) s.paid++;
    else if (g.amountPaid > 0) s.partial++;
    if (g.checkedIn) s.checkedIn++;
  });
  return s;
}

function fmtDate_(d) {
  return Utilities.formatDate(d, tz_(), 'MMM d, h:mm a');
}

function fmtCheckIn_(d) {
  return Utilities.formatDate(d, tz_(), "MMM d 'at' h:mm a");
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
