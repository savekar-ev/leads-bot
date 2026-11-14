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
| `service-account.json` | Google key | **No** |
| `state/`, `output/` | Progress and results | No |

## 1. Google Sheet setup (once, ~10 min)

1. **Create a project**: https://console.cloud.google.com/projectcreate
   Name it `leads-bot` → **Create**, and make sure it's selected at the top.
2. **Turn on the Sheets API**:
   https://console.cloud.google.com/apis/library/sheets.googleapis.com → **Enable**.
3. **Create a service account** (a robot Google user the script logs in as):
   https://console.cloud.google.com/iam-admin/serviceaccounts/create
   Name `leads-bot` → **Create and continue** → skip roles → **Done**.
4. **Download its key**: in the service-account list, click `leads-bot` →
   **Keys** tab → **Add key → Create new key → JSON → Create**.
   A `.json` file downloads. Rename it `service-account.json` and keep it private
   (never on GitHub, WhatsApp or email).
   If Google says key creation is disabled by an organisation policy, a Google
   Workspace admin has to allow it (policy `iam.disableServiceAccountKeyCreation`).
5. **Create the Sheet**: https://sheets.new → name it e.g. `CPO Leads`,
   rename the first tab to `Leads`.
6. **Share it with the robot**: **Share** → paste the service account email
   (looks like `leads-bot@<project-id>.iam.gserviceaccount.com`; it's also the
   `client_email` inside the JSON) → **Editor** → untick *Notify* → **Share**.
   Then share the Sheet with your manager as usual.
7. **Copy the Sheet ID** from its address bar:
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit` → put it in `.env`
   as `GOOGLE_SHEET_ID`.

The script writes the header row itself. Columns *Outreach status*, *Owner* and
*Notes* are for the team; the script never edits existing rows, it only appends.

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
nano .env              # paste DATA_GOV_KEY and GOOGLE_SHEET_ID
```

Copy the Google key from your laptop to the server (run this **on your laptop**):

```bash
scp -i your-key.pem service-account.json ubuntu@<EC2-IP>:~/leads-bot/
```

(use `ec2-user@` instead of `ubuntu@` on Amazon Linux)

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

## 5. Day to day

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
