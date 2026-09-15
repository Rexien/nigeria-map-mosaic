# NIAC Live: Event-Day Capacity & Operations Runbook

**Audience**: Event Operations Team, Backstage Admin Operator, Technical Lead / DevOps  
**Event**: NIAC Live 2026 Interactive Audience Engagement  
**Planning Range**: unknown turnout; rehearse 100, 500, 1,000 and 2,500-player tiers before making a capacity claim  

---

## 1. Team Roles & Responsibilities

| Role | Primary Responsibility | Interface |
|---|---|---|
| **MC / Host** | Guides audience, announces questions, calls for answer reveal & Top 10 | Stage microphone & audience view |
| **Backstage Operator** | Selects ready questions, triggers "Open question", monitors queue health | Private `/admin` dashboard |
| **Technical Lead / DevOps** | Monitors gateway health, Caddy reverse proxy, SQLite WAL queues, and logs | SSH terminal / OCI Console / Cloud logs |

---

## 2. Pre-Event Verification Checklist

### T-60 Minutes: Infrastructure & Connectivity
- [ ] **Gateway Health Check**:
  ```bash
  curl -i https://live.niac2026.internal/gateway/health
  # Expected: HTTP 200 {"status":"healthy","queueDepth":0,"capacity":{"status":"green",...}}
  ```
- [ ] **SSL / TLS Certificate**:
  - Verify Caddy reverse proxy certificate is valid and not nearing expiration.
- [ ] **Database Connection Pool**:
  - Check Supabase dashboard: connections < 10, database CPU < 5%.
- [ ] **Disk Space Verification**:
  - Ensure Oracle VM disk slice (`/app/data`) has at least 5GB free storage.

### T-30 Minutes: Projector & Big Screen Setup
- [ ] Open big-screen display on projector: `https://live.niac2026.internal/display`.
- [ ] Enter full-screen mode (F11 / Cmd+Ctrl+F).
- [ ] Verify the welcome QR code displays correctly and matches the audience join URL (`https://live.niac2026.internal/`).
- [ ] Verify Nigeria map word mosaic is active and visible.

### T-15 Minutes: Rehearsal Run & Clean Slate
- [ ] In `/admin`, verify **Rehearsal mode** checkbox is checked for the test run.
- [ ] Have event team join using test phones and submit answers to 1 sample question.
- [ ] Confirm answer acknowledgment and Top 10 reveal appear smoothly on `/display`.
- [ ] **Reset Test Data**:
  - Click **Clear rehearsal players** and enter `CLEAR REHEARSAL DATA`.
  - Uncheck **Rehearsal mode** and click **Save rehearsal setting**.
  - Verify People joined reads `0` and Answers received reads `0`.

### T-5 Minutes: Ready State
- [ ] Screen activity set to `Live Nigeria map` or `Passport trivia` welcome lobby.
- [ ] Backstage Capacity panel status reads **`GREEN · Healthy`**.
- [ ] Operator selects Question 1 in the dropdown, awaiting the MC's cue.

---

## 3. Backstage Operator Guide (`/admin`)

### A. Reading the Capacity & Live Health Panel

| Status Badge | Meaning | Operational Action |
|---|---|---|
| **`GREEN · Healthy`** | Queue, acknowledgment latency and error rate are within the configured limits. | Normal operations. Follow MC cues. |
| **`AMBER · Degraded`** | At least one early-warning threshold has been crossed. | Alert the technical lead and watch whether the queue drains. |
| **`RED · Overloaded`** | A critical queue, latency, error-rate or event-loop threshold has been crossed. | Press **Freeze roster** and wait for recovery before opening another question. |

### B. Standard Question Cycle (4 Steps)
1. **Choose Question**: While MC introduces topic, select the question in the dropdown.
2. **Open Question**: On MC cue (*"Your time starts now!"*), click **Open question** (Send to projector + phones).
3. **Timer Countdown**: The 20-second countdown runs automatically on projector and phones. At 0s, answers lock automatically.
4. **Reveal & Leaderboard**:
   - The correct answer and personal scores reveal automatically.
   - When the MC asks for scores, click **Show Top 10**.

### C. Freezing the Roster
- If room capacity reaches attendance targets (~1,000 to 1,500) or if the health badge turns **RED**:
  - Click **Freeze roster** in the `#capacity-panel`.
  - The indicator will update to: `Roster: Frozen (Spectator active)`.
  - **Effect**: Contestants already in the game keep playing for points. Any newcomers who join late become **Spectators**—they can answer for interactive practice, but will not strain the competitive database or displace room contestants.

---

## 4. Incident Response & Troubleshooting Playbooks

### Playbook A: Projector Screen Disconnects or Freezes
- **Symptom**: Big screen loses network, browser crashes, or cable is bumped.
- **Remedy**:
  1. The client transport retains the last valid screen in cache without blanking.
  2. If the browser tab was closed, reopen `https://live.niac2026.internal/display`.
  3. The display will reconnect via SSE and instantly synchronize to the server's current state.

### Playbook B: Gateway Process Restarts or VM Reboots
- **Symptom**: Temporary gateway connection loss (< 5 seconds).
- **Remedy**:
  1. Systemd automatically restarts the service:
     ```bash
     sudo systemctl status niac-gateway
     ```
  2. The SQLite WAL queue commits answers before acknowledging. Upon a process restart on intact storage, the batch flusher resumes draining queued answers to Supabase. VM and disk failure behaviour must be verified in rehearsal.
  3. Participant phones automatically switch to retry mode (`"Answer choice saved, retrying..."`) and lock in seamlessly once restarted.

### Playbook C: Total Gateway Outage (Failover to Netlify Circuit Breaker)
- **Symptom**: Oracle VM instance is down or unreachable due to upstream hosting outage.
- **Remedy**:
  1. The client transport switches to Netlify polling when the gateway stream errors.
  2. Phones begin polling `/api/state` at 3–5s jittered intervals directly against Netlify.
  3. Answers are submitted directly to `/api/answers` (Netlify Functions) which writes to the identical Supabase answers table with deduplication.
  4. The event can continue in fallback mode, but the operator should watch Netlify and Supabase usage closely.

### Playbook D: Emergency Secret Key Rotation
- **Symptom**: Primary credential secret (`CREDENTIAL_SECRET_ACTIVE`) is compromised.
- **Remedy**:
  1. Move the current active secret to `CREDENTIAL_SECRET_PREVIOUS`.
  2. Generate a new high-entropy string for `CREDENTIAL_SECRET_ACTIVE`.
  3. Update environment variables and reload the gateway:
     ```bash
     sudo systemctl restart niac-gateway
     ```
  4. **No Participant Disconnection**: Existing participants signed with the previous key remain valid until expiration, while all new tokens use the new active key.

---

## 5. Post-Event Wrap-Up
1. Click **Pause everything** or set state to `ended`.
2. Click **Download responses** in the moderation section to export the live Nigeria map responses CSV.
3. Review `/gateway/health` and logs for final attendance and latency metrics.
4. If staging rehearsal data, clear test entries before the live production session.
