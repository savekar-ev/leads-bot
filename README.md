# Leads bot

Scans data.gov.in company and MSME data for **all of India** for target companies
(default profile `broad`: the whole energy sector, i.e. EV charging, EVs, battery /
BMS / storage, solar / renewables, energy management, power generation and
equipment, wind, hydro, bio-energy, hydrogen; a company only has to match one of
these), appends every new lead to a Google Sheet,
and keeps CSV copies in `output/`. Progress is saved in `state/`, so after a
restart (pm2, reboot, crash) it continues where it stopped.

## How long it takes, and why it's slow on purpose

| Dataset | Records | Requests (1,000 per request) |
|---|---|---|
| MCA Company Master Data (most CPOs) | ~37 lakh | ~3,700 |
| MSME Udyam registrations | ~4.6 crore | ~46,000 |

To protect the API key from being banned, the script:
- sends **one request at a time, about 4 s apart** (with random jitter),
- **slows itself down** (up to one request every 2 min) when data.gov.in says it's
  busy or rate limited, and speeds back up gradually,
- stops at **10,000 requests per day** (IST) and rests until after midnight.

At those settings the MCA dataset takes about **half a day** and the full MSME
dataset about **5 days**. Leads appear in the Sheet as soon as they're found, and
big EV states (Maharashtra, Karnataka, Delhi, Tamil Nadu, ...) are scanned first.
Change `DELAY_SECONDS` / `MAX_REQUESTS_PER_DAY` in `.env` if needed; going faster
raises the risk of being blocked.

Before scanning a dataset, the script asks it how many records each state has
(36 tiny requests, saved so they aren't repeated). If the state names don't cover
the whole dataset, it scans that dataset in one pass instead, so nothing is missed.

## Profiles and the raw store

`PROFILE` in `.env` picks what counts as a lead. `broad` (default) keeps any
energy company; *Why matched* starts with the group, e.g. `[Solar / renewable]`
or `[Battery / BMS / storage]`, so the list can be filtered later. Companies whose
official industry code is batteries (NIC 2720) or electric power (NIC 3510) are
kept even if their name doesn't say so. `cpo` keeps only charge point operators.

Every page downloaded is also saved, unfiltered and gzipped, in `state/raw/`.
Changing `PROFILE` (or `--reset`) re-scans from these files without calling
data.gov.in again. To get everything stored as CSV:
`node fetch-companies.js --export-raw` (writes `output/raw_<dataset>.csv`; MSME is
far too big for Excel). Saving stops by itself if the disk has under 2 GB free;
`RAW_STORE=off` turns it off.

## Files

| File | Purpose | On GitHub? |
|---|---|---|
| `fetch-companies.js` | The script | Yes |
| `package.json`, `ecosystem.config.js` | Run settings (pm2) | Yes |
| `.env.example` | Settings template | Yes |
| `.env` | Your real settings + API key | **No** |
| `apps-script.gs` | Paste into the Google Sheet (Extensions → Apps Script) | Yes |
| `state/`, `output/` | Progress and results | No |

## 1. Google Sheet setup (optional)

You can skip this whole section: every lead is saved on the server and shown on
the live status page (section 5), with CSV download buttons. Set it up only if
you also want leads copied into a Google Sheet.

The bot sends leads to a small **Apps Script** attached to the sheet, which adds
the rows. This works even when your Google organisation blocks service-account
keys.

1. Create the sheet: https://sheets.new → name it `CPO Leads`, rename the
   bottom tab to `Leads`. Share it with your manager as usual.
2. In the sheet: **Extensions → Apps Script**. Delete what's there, paste the
   whole of `apps-script.gs` from this repo.
3. In the pasted code, change `SECRET` to a long random string (e.g. 40 random
   letters and digits). Click **Save** (disk icon).
4. **Deploy → New deployment** → gear icon → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   → **Deploy** → **Authorize access** → pick your account → if you see
   "Google hasn't verified this app": **Advanced → Go to … (unsafe) → Allow**
   (it's your own script).
5. Copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`).
   Opening it in a browser should show `{"ok":true,"message":"Leads webhook is running"}`.
6. In the server's `.env`:
   ```
   GOOGLE_WEBHOOK_URL=<the Web app URL>
   GOOGLE_WEBHOOK_SECRET=<the same SECRET as in step 3>
   ```

"Anyone" only means anyone with the URL can *call* it; without the secret it
adds nothing. Keep the URL and secret private. If you change the script later,
use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

The header row is written automatically. Columns *Outreach status*, *Owner* and
*Notes* are for the team; the bot only appends rows, it never edits them.

(Alternative, only if your organisation allows service-account keys: set
`GOOGLE_SHEET_ID` + `GOOGLE_SERVICE_ACCOUNT_FILE` instead, share the sheet with
the service account email as Editor.)

## 2. Code on GitHub

The code lives in the private repo https://github.com/savekar-ev/leads-bot.
To change it from your laptop: `git clone` it, edit, `git commit`, `git push`;
then `git pull` on the server (see "Day to day").

## 3. EC2 setup (Mumbai, once)

SSH in, then:

```bash
# Node.js 20 via nvm (works on Ubuntu and Amazon Linux)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
sudo apt-get install -y git 2>/dev/null || sudo yum install -y git

# Get the code (private repo: use a GitHub personal access token as the password,
# or add the server's SSH key as a read-only Deploy Key on the repo)
git clone https://github.com/savekar-ev/leads-bot.git
cd leads-bot
npm install

# Settings and Google key
cp .env.example .env
nano .env              # DATA_GOV_KEY, GOOGLE_WEBHOOK_URL, GOOGLE_WEBHOOK_SECRET
```

## 4. Run it with pm2 (keeps running after you close the window and after reboots)

```bash
sudo npm install -g pm2          # once (drop sudo if Node came from nvm)
cd ~/leads-bot
pm2 start ecosystem.config.js    # starts the bot
pm2 logs leads-bot               # watch it (Ctrl+C only stops watching, not the bot)
pm2 save                         # remember it
pm2 startup                      # prints ONE command starting with "sudo env PATH=..."; copy and run it
```

After `pm2 startup` + `pm2 save`, the bot starts again by itself after a reboot
and continues where it stopped. pm2 also restarts it after a crash (waiting longer
each time), but not after it finishes or after a `CONFIG ERROR`.

## 5. Live status page

The bot serves a password-protected page with overall progress, an ETA, progress
per dataset and state, today's request count, a searchable table of all leads,
CSV downloads and the recent log. It refreshes itself every 15 seconds and keeps
running after all datasets are done.

1. In `.env` set `STATUS_PORT=8080` and a strong `STATUS_PASSWORD`
   (e.g. from `openssl rand -hex 12`). User name is `STATUS_USER` (default `admin`).
2. Restart the bot: `pm2 restart leads-bot`.
3. Open port 8080: **EC2 → Instances → your instance → Security tab → security
   group → Edit inbound rules → Add rule**: Custom TCP, port `8080`, source
   **My IP** (or your office IP). Avoid `0.0.0.0/0` (the whole internet).
4. Open `http://<instance-public-IP>:8080` and log in.

**Where the data lives (no data loss):** every new lead is written to
`state/cpo_leads.json` (written atomically, so a crash can't leave it half
written) *before* anything else happens, and `output/cpo_leads.csv` is rebuilt
from it. A copy is kept per day in `state/backups/` (last 30 days). The page and
the CSV buttons only read this data; they never change it. Leads survive
restarts, `git pull` and reboots; only deleting the `state/` folder removes them.

The page is plain HTTP, so the password travels unencrypted. Keeping the
security-group rule limited to your own IPs is what keeps it private. For HTTPS
later, put it behind Nginx + Let's Encrypt or an AWS load balancer.

## 6. Day to day

| Task | How |
|---|---|
| Is it running? | `pm2 status` (or open the status page) |
| Watch the log | `pm2 logs leads-bot` (Ctrl+C to leave) |
| Update the code | `cd ~/leads-bot && git pull && pm2 restart leads-bot` (it resumes) |
| Change settings | `nano .env`, then `pm2 restart leads-bot` |
| Stop / start | `pm2 stop leads-bot` / `pm2 start leads-bot` |
| Today's request count | `cat state/requests.json` |
| Run a finished job again | `pm2 stop leads-bot && node fetch-companies.js --reset`, then Ctrl+C and `pm2 start leads-bot` |
| Get CSVs | Status page buttons, or `output/cpo_leads.csv` |

Notes:
- Network errors and rate limits don't stop it: it waits (up to 30 min) and retries.
- A config mistake (missing key, wrong profile) stops it with `CONFIG ERROR` in
  `pm2 logs`; fix `.env`, then `pm2 restart leads-bot`.
- Log files are in `logs/`. To keep them small: `pm2 install pm2-logrotate`.
- If it can't reach data.gov.in from EC2 but works from your laptop, check the
  security group allows outbound HTTPS (port 443).
