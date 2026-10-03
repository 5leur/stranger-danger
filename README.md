# 🎃 Stranger Danger: Halloween Party Door System

A guest list with payment status, a permanent QR code for each guest sent by email, and a phone scanner page for the bouncer.

```
Google Form ──► Google Sheet ──► Apps Script ──► 📧 QR email to guest
                    ▲                 │
                    │           JSON API (PIN-protected)
              organizers tick         │
              "Paid" checkbox         ▼
                               docs/index.html  ◄── bouncer's phone
```

- **Database:** the Google Sheet that holds the form responses. The script adds these columns: `Guest ID`, `Paid`, `QR Emailed At`, `Checked In At` and `Door Notes`.
- **QR code:** encodes a random, permanent Guest ID such as `SD-7K3MX-Q9P2A`. It's created once per registration and never changes. Resending the email sends the same code.
- **Email:** a formatted Halloween-themed HTML email. The QR code is shown inline and also attached as a PNG.
- **Scanner:** a mobile web page that shows a full-screen **PAID** (green), **NOT PAID** (red), **ALREADY IN** (amber) or **UNKNOWN CODE** (grey) result, with the guest's details. The bouncer then taps *Admit*. For guests who haven't paid, the bouncer can tap *Payment collected → admit*.

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | Everything that runs on the Google side: form trigger, ID and QR generation, email, sheet menu and the bouncer API |
| `docs/index.html` | The bouncer's scanner page, a single static file |

---

## Setup (about 15 minutes)

### 1. Google Form
Create the form with at least a **name** question and an **email** question. Either *Full name* or *First name* + *Last name* works. You can also turn on *Settings → Responses → Collect email addresses*. Add any other questions you like (costume, phone, etc.). The bouncer sees those answers too.

In the **Responses** tab, click **Link to Sheets** and create a new spreadsheet.

### 2. Apps Script
1. In the responses spreadsheet, open **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Edit the `CONFIG` block at the top: event name, date, venue, price, payment instructions and sign-off.
4. Save, then reload the spreadsheet. A **🎃 Party** menu appears.
5. Click **🎃 Party → Run setup** and approve the permissions Google asks for. Setup does three things:
   - adds the extra columns,
   - installs the trigger that runs on each form submission,
   - asks you for a **bouncer PIN** (6+ characters; use something longer than a birthday).

From now on, every new form submission gets a Guest ID, and the guest receives the QR email within a few seconds.

People who registered **before** setup: click **🎃 Party → Email QR codes to everyone not yet emailed**.

### 3. Deploy the bouncer API
In the Apps Script editor, click **Deploy → New deployment → ⚙️ → Web app** and set:
- **Execute as:** *Me*
- **Who has access:** *Anyone*

Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

> "Anyone" only means the URL can be reached without a Google login. Every request still needs the bouncer PIN, and repeated wrong PINs lock the API for 10 minutes. Keep the URL and PIN among organizers and bouncers.

If you edit `Code.gs` later, use **Deploy → Manage deployments → ✏️ → Version: New version** so the URL stays the same.

### 4. Host the scanner page
The camera only works on an **https** page. Pick one:

- **GitHub Pages:** go to *Repo → Settings → Pages → Source: Deploy from branch*, choose your branch and the `/docs` folder. The scanner will be at `https://<user>.github.io/<repo>/`. (Pages needs a public repo, or a paid GitHub plan for a private one.)
- **Netlify Drop:** drag the `docs` folder onto <https://app.netlify.com/drop>.

### 5. Set up the bouncers' phones
Open the scanner page, tap ⚙️, and paste the Web app URL and PIN. The page tests the connection before saving. Settings are stored on that phone only.

Faster option: send each bouncer a one-tap setup link:
```
https://<your-scanner-page>/#api=<WEB_APP_URL>&pin=<PIN>
```
The page saves the URL and PIN, then removes them from the address bar.

---

## Day-to-day use

| Task | How |
|---|---|
| Someone paid | Tick their **Paid** checkbox in the sheet |
| Guest lost their email | Select their row → **🎃 Party → Resend QR code to selected row(s)** |
| Guest can't show the QR | Bouncer types the Guest ID (from the email) into *Can't scan?* on the scanner. Dashes and case don't matter |
| Guest pays at the door | Scan → **NOT PAID** → collect payment → **Payment collected → admit**. This ticks *Paid* and writes "Paid at door …" in *Door Notes* |
| How many are in? | The scanner header shows `in · paid · registered`, or use **🎃 Party → Show door stats** |
| Re-admit someone who stepped out | The scan shows **ALREADY IN** with the original check-in time; the bouncer uses judgement |

Customisation is all in `CONFIG`:
- `DISPLAY_FIELDS: ['Costume', 'Phone']` limits which form answers the bouncer sees.
- `EMAIL_HEADER` and `NAME_HEADER` are for when auto-detection picks the wrong column.
- `SHEET_NAME` is for when the spreadsheet has several tabs.

## Good to know
- **Email quota:** Apps Script can send about **100 emails/day** from a regular Gmail account (1,500 with Google Workspace). If you hit the limit, run *Email QR codes to everyone not yet emailed* the next day; it skips anyone already emailed.
- **QR images** are rendered by quickchart.io, with api.qrserver.com as a fallback. Only the Guest ID is sent to them, never names or emails.
- **Duplicate/forwarded QR codes:** each code checks in once. A second scan shows **ALREADY IN** in amber, with the time of the first check-in.
- Payment and check-in status are always read live from the sheet, so a guest who pays the night before shows **PAID** at the door without a new QR code.
