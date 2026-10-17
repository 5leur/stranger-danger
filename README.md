# 🎃 Stranger Danger: Halloween Party Door System

Registration with payment approval, installment reminders, a permanent QR ticket per guest, and a phone scanner for the doorman that can also collect proof of payment at the door.

```
Google Form ──► Google Sheet ──► Apps Script ──► 📧 1. "Registration received – payment For Approval"
                    ▲                 │          📧 2. QR ticket, once an organizer approves the payment
                    │                 │          📧 3. Balance reminder to installment guests, the day before
                    │                 │          📧 4. Walk-in QR confirmation (during the party)
          organizers set              │
          Payment Status /     JSON API (PIN-protected)
          Amount Paid                 ▼
                               docs/index.html  ◄── doorman's phone (scan, collect proof, check in)
```

## How it works

1. **A guest submits the Google Form.** They get a Guest ID such as `SD-7K3MX-Q9P2A` and a *Registration received* email that says their payment is **For Approval**. This email has no QR code yet.
2. **An organizer checks the payment** and sets **Payment Status** to **Approved** in the sheet. The guest then automatically gets the *Payment confirmed* email with their **QR ticket**.
   - **Full payment:** the ticket says *Paid in full*.
   - **Installment:** the ticket shows the amount received and the balance. When more is approved later (raise **Amount Paid**), the guest gets an updated ticket. It's the same QR code, because each guest's code never changes.
3. **The day before the party,** every installment guest who still owes money gets a **balance reminder**. This runs automatically, and you can switch it off or send the reminders yourself from the menu.
4. **At the door** the doorman scans the QR code, and a popup shows the result:
   - **PAID** (green): *Admit & Check-In*.
   - **NOT PAID** (red): no payment yet, or *collect the rest: Php 600* for installment guests. *Collect Proof of Payment* opens the camera. The doorman photographs the receipt, cash or transfer screen, then taps *Save Photo*. The photo is added to the guest's own form submission (their *Proof of Payment* cell, saved in the same Drive folder as the form's uploads), the guest is marked paid in full, and the popup turns green so the doorman can check them in.
   - **ALREADY IN** (amber): the code was already used, with the time of first check-in.
   - **UNKNOWN CODE**: not on the guest list.
5. **Walk-ins:** *Walk-In Registration* opens the Google Form, and the guest fills it in on the spot (full payment with proof, checked by the doorman in person). During the party the script is in **walk-in mode**: new submissions are approved automatically, skip the "For Approval" email, are checked in, and the guest gets a *Walk-in confirmed* email with their QR code. Walk-in mode follows `WALK_IN_START`–`WALK_IN_END` (Oct 31, 6 PM to Nov 1, 6 AM by default). You can also force it on or off from **🎃 Party → Walk-in mode**.

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | Everything on the Google side: form and edit triggers, emails, reminders, sheet menu, and the doorman API |
| `docs/index.html` | The doorman's scanner page, a single static file |
| `docs/assets/bg.jpg` | Background texture from the UI designs |
| `docs/email/header.jpg` | The "WANTED / DEAD OR ALIVE" header cut from the poster, used at the top of every email |

### Columns the script adds to the sheet

| Column | Who fills it | Meaning |
|---|---|---|
| `Guest ID` | script | The code inside the QR. Never changes |
| `Payment Status` | **organizers** (dropdown) | `For Approval` (default) → `Approved`, or `Rejected` |
| `Amount Paid` | **organizers** | Approved amount so far. Left blank on approval, it fills in 1200 for full payment or 600 for an installment (`INSTALLMENT_FIRST_PAYMENT`) |
| `Confirmed Amount` | script | The amount the last QR ticket email covered. The script uses it to avoid emailing twice |
| `Registration Emailed At`, `QR Emailed At`, `Reminder Sent At` | script | When each email went out |
| `Checked In At` | script | Set when the doorman checks the guest in |
| `Door Payment Proof` | script | Only added if the form has no proof-of-payment upload. Otherwise door photos go into the form's own *Proof of Payment* column |
| `Door Notes` | script | e.g. "Collected Php 600 at door Oct 31, 9:41 PM" |

---

## Setup (about 20 minutes)

### 1. Google Form
The form needs:
- **Name:** *Full name*, or *First name* + *Last name*.
- **Email:** a question, or turn on *Settings → Responses → Collect email addresses*.
- **Payment type:** a question whose title contains "Payment Type" or "Payment Option", with choices such as *Full Payment* and *Installment*. Any answer containing "install", "partial" or "down payment" counts as an installment.
- **Proof of payment (recommended):** a *File upload* question titled e.g. "Proof of Payment". Its Drive link shows up in the doorman's popup.

Other questions (social media handle, referral, reference code…) are shown to the doorman too. Consent answers (data privacy, terms and conditions) are hidden (`HIDDEN_FIELDS`).

In the **Responses** tab, click **Link to Sheets**.

### 2. Apps Script
1. In the responses spreadsheet, open **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Check the `CONFIG` block at the top. It's pre-filled from the poster. In particular:
   - `TICKET_PRICE`, `INSTALLMENT_FIRST_PAYMENT`, `CURRENCY`
   - `EVENT_DATE_ISO` (`2026-10-31`) and `REMINDER_DAYS_BEFORE` (1): together these decide when reminders go out
   - `PAYMENT_INSTRUCTIONS`: shown in the balance reminder and on partial-payment tickets (e.g. your GCash/bank details)
   - `EMAIL_HEADER_IMAGE_URL`: this link only works while the repo is **public**. For a private repo, host `docs/email/header.jpg` somewhere public and put that link here. Without it, the emails use a plain-text header.
4. Save, then reload the spreadsheet. A **🎃 Party** menu appears.
5. Click **🎃 Party → Run setup** and approve the permissions Google asks for. Setup:
   - adds the columns above,
   - installs three triggers: on form submit (registration email), on edit (QR ticket on approval), and daily (installment reminders),
   - asks for the **doorman PIN** (6+ characters).

   The permissions include **Gmail** (sending), **Drive** (saving door photos into one folder) and **Forms** (finding the form link for walk-ins).

People who registered **before** setup: use **🎃 Party → Send registration emails to rows not yet emailed**. If you've already verified some payments, set them to *Approved* and use **Send QR tickets to approved guests not yet emailed**.

### 3. Deploy the doorman API
In the Apps Script editor, click **Deploy → New deployment → ⚙️ → Web app** and set:
- **Execute as:** *Me*
- **Who has access:** *Anyone*

Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

> "Anyone" only means the URL can be reached without a Google login. Every request still needs the doorman PIN, and repeated wrong PINs lock the API for 10 minutes.

When you update `Code.gs` later, use **Deploy → Manage deployments → ✏️ → Version: New version** so the URL stays the same.

### 4. Host the scanner page
The camera only works on an **https** page:
- **GitHub Pages:** *Repo → Settings → Pages → Deploy from branch → `main` / `/docs`*. This needs a public repo, or a paid GitHub plan for a private one.
- **Netlify Drop:** drag the `docs` folder onto <https://app.netlify.com/drop>.

### 5. Set up the doormen's phones
Open the scanner page, tap ⚙️, and enter the Web app URL and PIN. The page checks them before saving and says *Information not correct* if either is wrong. Or send each doorman a one-tap link:
```
https://<your-scanner-page>/#api=<WEB_APP_URL>&pin=<PIN>
```

---

## Day-to-day use

| Task | How |
|---|---|
| Approve a payment | Set **Payment Status** to *Approved*. Enter **Amount Paid** first if it isn't the default. The QR ticket is emailed within seconds, and a note pops up in the sheet |
| Second installment arrives | Raise **Amount Paid** (e.g. 600 → 1200). The guest gets an updated "Paid in full" ticket |
| Reject a payment | Set **Payment Status** to *Rejected*. No email is sent, so contact the guest yourself |
| Walk-in mode | Automatic during `WALK_IN_START`–`WALK_IN_END`. **🎃 Party → Walk-in mode** switches between automatic / on / off, and shows which one is active. Keep the form closed to the public during the party, or a guest registering from home would also be auto-approved |
| Installment reminders | They go out automatically on `EVENT_DATE_ISO − REMINDER_DAYS_BEFORE`, around 9 AM. **🎃 Party → Turn automatic installment reminders on/off** switches that; **Send installment reminders now** sends them immediately. Nobody gets two reminders |
| Guest lost their email | Select the row → **🎃 Party → Resend QR ticket to selected row(s)** |
| Guest can't show the QR | Doorman types the Guest ID into *Can't scan?*. Dashes and case don't matter |
| Guest pays at the door | Scan → **NOT PAID** → *Collect Proof of Payment* → photo → *Save Photo* → **PAID** → *Admit & Check-In* |
| Numbers so far | **🎃 Party → Show door stats** |

The fonts in the designs are Open Sans plus *Rustic Printed – Stamp* for the titles. The page loads Open Sans from Google Fonts. Rustic Printed isn't a free web font, so the titles use Oswald with a distressed texture. If you have a web licence for Rustic Printed, put the file at `docs/fonts/RusticPrinted-Stamp.woff2` and the page uses it automatically.

## Good to know
- **Email quota:** a regular Gmail account can send about **100 emails/day** (1,500 with Google Workspace). Each guest now gets 2–3 emails. If you hit the limit, the menu actions pick up where they stopped the next day.
- **QR images** are made by quickchart.io, with api.qrserver.com as a fallback. Only the Guest ID is sent to them.
- **Door photos** are saved next to the form's own proof-of-payment uploads in Drive and linked in the guest's *Proof of Payment* cell. The proof links in the popup open for people with access to that Drive.
- Payment and check-in status are always read live from the sheet, so a payment approved the night before shows **PAID** at the door.
