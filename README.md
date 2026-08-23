# Nigeria Mosaic — Live Event Display System

An interactive corporate event web application where attendees submit a single word from their mobile phones, dynamically rendered live on a big screen packed inside the authentic geographic boundary of Nigeria.

---

## 🚀 Quick Start Guide

### 1. Supabase Setup (Database & Realtime)
1. Create a free project at [supabase.com](https://supabase.com).
2. Go to the **SQL Editor** tab in your Supabase dashboard.
3. Open [`schema.sql`](file:///schema.sql), copy its entire contents, paste it into the SQL editor, and click **Run**.
4. Go to **Project Settings** -> **API**:
   - Copy your **Project URL**
   - Copy your **`anon` `public` API Key**
5. Open [`config.js`](file:///config.js) and paste both keys:
   ```javascript
   SUPABASE_URL: "https://your-project-ref.supabase.co",
   SUPABASE_ANON_KEY: "your-anon-public-key",
   ```

---

### 2. Deploy to Netlify
Since the app is 100% static with zero build dependencies, you can deploy it in 30 seconds:

#### Option A: Drag & Drop (Fastest)
1. Log in to [netlify.com](https://app.netlify.com).
2. Drag and drop this entire project folder into Netlify Drop.
3. Your site will instantly be live with an HTTPS URL (e.g. `https://nigeria-mosaic.netlify.app`).

#### Option B: Connect GitHub / Git Repository
1. Push this folder to a GitHub repository.
2. In Netlify, select **Add new site** -> **Import an existing project** -> Choose your repo.
3. Build command: *(leave blank)*
4. Publish directory: `.`
5. Click **Deploy Site**.

---

## 🌐 The 3 Event URLs

| Page | URL | Purpose |
| :--- | :--- | :--- |
| **📱 1. Submit Page** | `https://your-domain.netlify.app/` *(or `/submit.html`)* | Attendees open this on their mobile phones to enter a single word. |
| **🖥️ 2. Display Screen** | `https://your-domain.netlify.app/display.html` | Open full-screen on the event laptop / projector screen for the live word mosaic. |
| **🛡️ 3. Admin Page** | `https://your-domain.netlify.app/admin.html` | Hidden dashboard for the on-site team to monitor and instantly hide unwanted words. |

---

## ⚙️ How to Change the Event Question
To deploy a different question or version:
1. Open [`config.js`](file:///config.js).
2. Modify the `QUESTION_TEXT` and `QUESTION_SUBTITLE` variables:
   ```javascript
   QUESTION_TEXT: "What single word represents Nigeria's future to you?",
   QUESTION_SUBTITLE: "Enter a single powerful word (e.g. Innovation, Hope, Resilience)",
   ```
3. Save and re-deploy/refresh. Both the submit and display pages will automatically reflect the updated question.

---

## 🛡️ On-Site Admin & Moderation Guide
The admin interface is designed for non-technical event coordinators:

1. **Accessing the Dashboard**:
   - Go to `https://your-domain.netlify.app/admin.html` on a phone, tablet, or laptop.
   - If prompted, enter the default event PIN: **`1960`** (configurable in `config.js`).
2. **Live Feed**:
   - Every submission appears in real-time with its timestamp and status.
3. **Hiding an Inappropriate Word**:
   - Simply click the red **`✕ Hide from Display`** button next to any word.
   - The word will **instantly vanish from the big display screen** with zero reload.
4. **Restoring a Word**:
   - Click **`✓ Show on Screen`** if a word was hidden by mistake.
5. **Profanity Blocklist**:
   - Submissions matching common inappropriate words in `config.PROFANITY_BLOCKLIST` are automatically hidden and tagged with a **Flagged** badge in the admin table.

---

## 🏗️ Technical Highlights

- **Bundled Geographic Data**: Uses authentic 1:10m Natural Earth GeoJSON for Nigeria (`data/nigeria.geojson`), projected at runtime and converted into an offscreen raster collision mask. Words are mathematically guaranteed to land strictly inside Nigerian territory.
- **Stem Normalization**: Uses a lightweight suffix stripper (`js/stemmer.js`) so variations like *Resilience*, *Resilient*, and *Resiliency* aggregate into one weighted entry, displaying the most frequent spelling.
- **Adaptive Font Scaling**: Sizes words as $S \propto \text{baseScale} \cdot \sqrt{\text{count}}$, auto-balancing whether there are 5 words or 500 words.
- **Smooth Re-packing**: Performs a full cross-fade re-balance every 25 responses (`config.REPACK_INTERVAL`) and keeps the screen dynamic with subtle ambient shimmers.
