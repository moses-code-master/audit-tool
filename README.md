# Content Audit Tool

A Node.js newsroom-style dashboard for auditing published articles.

## Run Locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy

Use any Node.js host such as Render, Railway, Hostinger Node.js Web Apps, or a VPS.

- Build command: `npm ci --omit=dev`
- Start command: `npm start`
- Node version: `20` or newer

## Features

- Scrapes title, author, date, category, meta description, body text, H2s, links, images, and word count
- Composite score out of 100
- Scores factual depth, readability, SEO structure, E-E-A-T, human voice, and content width
- Uses readability formulas and visible scoring subchecks
- Checks named sources, source diversity, link health, and numeric claim support where source pages can be fetched
- Produces editor notes and suggested fixes
