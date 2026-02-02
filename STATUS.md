# Project Status: Initiation of Coverage Report Generator

## Live URL
**https://retailbbg.onrender.com**

## What We Built
A web app that generates hedge fund-style initiation of coverage memos for any stock ticker.

- **Stack**: Node.js + Express + OpenAI GPT-4o
- **Hosting**: Render (auto-deploys on push to GitHub)
- **Repo**: https://github.com/Cahnja/retailbbg

## Current Architecture
**2-step generation process** (~60 seconds):
1. **Research** (~20s) - Web search via OpenAI Responses API for investor narratives, customers, competitors, bull/bear debates
2. **Generate** (~40s) - Create memo using Chat Completions API with few-shot example

## Features
- **30-day caching** - Reports saved to `cache/` directory, retrieved if < 30 days old
- **Progress indicator** - Shows steps and estimated time remaining
- **Styled output** - Large titles (h1), section headers (h2), customer boxes, debate boxes with bull/bear coloring
- **Bold key sentences** - Important insights highlighted in each section
- **Reference memo for AVGO** - High-quality cached version available

## Files
```
retailbbg/
├── server.js              # Express server with 2-step prompt logic
├── public/index.html      # Web interface with progress UI
├── cache/                  # Cached reports (JSON files)
│   ├── AVGO.json          # Reference quality memo
│   └── [TICKER].json      # Auto-generated cache files
├── prompts/
│   └── v1_two_step.md     # Prompt documentation
├── examples/
│   ├── AVGO_reference.md  # Target quality (8.5/10)
│   ├── AVGO_v6_iterate.html
│   ├── AVGO_v7_debates.html
│   ├── AMBA_report.html
│   └── GRADING.md         # Scoring methodology
├── .env                   # API key (not committed)
└── .gitignore             # Excludes node_modules, .env, cache/
```

## Grading Methodology
See `examples/GRADING.md`
- Wrong thesis = capped at 3
- Filler language = severe penalty
- Insight density is #1 priority

## To Resume Development
1. `npm start` — Run locally at http://localhost:3000
2. Edit prompt in `server.js` (look for REFERENCE_MEMO and firstDraftMessages)
3. Test with: `curl -X POST http://localhost:3000/api/generate-report -H "Content-Type: application/json" -d '{"ticker":"AAPL"}'`
4. Push to deploy: `git add -A && git commit -m "message" && git push`

## What's Done
- [x] Basic web app with styled UI
- [x] OpenAI GPT-4o integration with web search
- [x] 2-step prompt (research → generate) with few-shot example
- [x] Key Debates section with Bull/Bear format
- [x] 30-day report caching system
- [x] Progress indicator with step tracking and time estimate
- [x] Large titles and section headers
- [x] Bold key sentences in each section
- [x] Deployed to Render with auto-deploy
- [x] Reference AVGO memo saved as cached version

## Previous Architecture (removed for speed)
Previously had 4 steps: Research → Draft → Critique → Final (~2 min)
- Critique step reviewed draft for problems
- Final step regenerated fixing all issues
- Removed to reduce generation time from ~2 min to ~60 sec

## UI Features
- Title: 36px, dark blue with underline
- Section headers: 26px
- Customer boxes: Light blue with blue left border
- Debate boxes: Gray background with dark left border
- Bull case: Green text
- Bear case: Red text
- Cache indicator: Shows if report is cached with option to regenerate
- Progress bar: Animated with step indicators and countdown timer

## Key Learnings
- Model doesn't naturally find the "real story" — needs explicit guidance
- Few-shot examples in prompt significantly improve output quality
- Web search step is critical for finding investor-focused narratives
- Critique/regenerate loop improves quality but doubles generation time
- User decided speed > marginal quality improvement, removed critique step
