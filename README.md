# Mise — Recipe Importer

Clean recipe importing. No ads, no life stories. Just ingredients and steps.

---

## Deploy to Vercel (10 minutes)

### Step 1 — Get the code on GitHub

1. Go to **github.com** and create a free account if you don't have one
2. Click the **+** icon → **New repository**
3. Name it `mise`, set it to **Public**, click **Create repository**
4. Upload these files (drag & drop onto the page):
   - `vercel.json`
   - `public/index.html`
   - `api/claude.js`
   - `api/fetch.js`

> Tip: you need to create the `public/` and `api/` folders in GitHub — click "creating a new file", type `public/index.html` and it'll create the folder automatically.

---

### Step 2 — Create your Vercel account

1. Go to **vercel.com**
2. Click **Sign Up** → choose **Continue with GitHub**
3. Authorize Vercel to access your GitHub

---

### Step 3 — Deploy

1. In Vercel, click **Add New Project**
2. Find your `mise` repository and click **Import**
3. Under **Framework Preset**, select **Other**
4. Under **Root Directory**, leave it as `/`
5. Click **Deploy** — it'll fail at first, that's fine

---

### Step 4 — Add your API key

1. In your Vercel project, go to **Settings → Environment Variables**
2. Add a new variable:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** your Anthropic API key (starts with `sk-ant-...`)
   - **Environment:** check all three (Production, Preview, Development)
3. Click **Save**

---

### Step 5 — Redeploy

1. Go to the **Deployments** tab
2. Click the three dots on your latest deployment → **Redeploy**
3. Wait ~30 seconds

Your app is now live at `https://mise-[random].vercel.app` 🎉

You can add a custom domain in **Settings → Domains** if you want `mise.app` or similar.

---

## Project Structure

```
mise/
├── vercel.json          # Routing config
├── public/
│   └── index.html       # The entire frontend
└── api/
    ├── claude.js        # Proxies requests to Anthropic API (keeps key secret)
    └── fetch.js         # Fetches recipe pages server-side (avoids CORS issues)
```

---

## How it works

1. User pastes a recipe URL
2. `/api/fetch` fetches the page server-side
3. The HTML is parsed for JSON-LD recipe schema (most food sites have this)
4. `/api/claude` sends the extracted content to Claude with instructions to return clean JSON
5. The frontend renders the recipe card — editable, scalable, clean

---

## Cost

- **Vercel:** Free (Hobby plan covers this easily)
- **Anthropic API:** ~$0.001–0.003 per recipe import (fractions of a cent)
