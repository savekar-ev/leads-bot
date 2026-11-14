# Leads bot

Scans data.gov.in company and MSME data for **all of India** for target companies
(default: EV charge point operators), appends every new lead to a Google Sheet,
and keeps CSV copies in `output/`. Progress is saved in `state/`, so after a
restart (nodemon, reboot, crash) it continues where it stopped.

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

## Files

| File | Purpose | On GitHub? |
|---|---|---|
| `fetch-companies.js` | The script | Yes |
| `package.json`, `nodemon.json` | Run settings | Yes |
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
sudo apt-get install -y git tmux 2>/dev/null || sudo yum install -y git tmux

# Get the code (private repo: use a GitHub personal access token as the password,
# or add the server's SSH key as a read-only Deploy Key on the repo)
git clone https://github.com/savekar-ev/leads-bot.git
cd leads-bot
npm install            # installs nodemon locally

# Settings and Google key
cp .env.example .env
nano .env              # DATA_GOV_KEY, GOOGLE_WEBHOOK_URL, GOOGLE_WEBHOOK_SECRET
```

## 4. Test, then run

```bash
# Can the server reach data.gov.in? Should print records, not an error.
npm run test-api
```

Start it so it keeps running after you close the SSH window:

```bash
tmux new -s leads      # opens a session that survives disconnects
npm start              # nodemon fetch-companies.js
# detach: press Ctrl+B, then D   -> now you can close the window
```

Later, to look at it again: `ssh ...` then `tmux attach -t leads`.

New leads appear in the Google Sheet as they're found, and the log shows
`NEW LEAD: ...` lines.

## 5. Live status page

The bot serves a password-protected page with overall progress, an ETA, progress
per dataset and state, today's request count, a searchable table of all leads,
CSV downloads and the recent log. It refreshes itself every 15 seconds and keeps
running after all datasets are done.

1. In `.env` set `STATUS_PORT=8080` and a strong `STATUS_PASSWORD`
   (e.g. from `openssl rand -hex 12`). User name is `STATUS_USER` (default `admin`).
2. Restart the bot (`rs` in the tmux window).
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
| See progress | `tmux attach -t leads` (Ctrl+B, D to leave) or `cat state/progress.json` |
| Update the code | `git pull` in `~/leads-bot`: nodemon restarts it and it resumes |
| Change states / datasets / speed | Edit `.env`, then in the tmux window type `rs` + Enter |
| See today's request count | `cat state/requests.json` |
| Run a finished job again | `node fetch-companies.js --reset` (or delete `state/progress.json`) |
| Stop | `tmux attach -t leads`, then Ctrl+C |
| Get CSVs | `output/cpo_leads.csv`, `output/cpo_linkedin_upload.csv` (`scp` them down) |

Notes:
- When all datasets are done, the script exits and nodemon shows
  "clean exit - waiting for changes". That's normal; it isn't stuck.
- Network errors and rate limits don't stop it: it waits (up to 30 min) and retries.
- A config mistake (missing key, wrong profile) stops it with `CONFIG ERROR`;
  fix `.env` and type `rs`.
- If `npm run test-api` hangs or fails on EC2 but works on your laptop,
  data.gov.in may be slow or blocking cloud IPs; check the security group
  allows outbound HTTPS (port 443).
