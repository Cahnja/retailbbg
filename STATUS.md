# Project Status: Initiation of Coverage Report Generator

## Live URL
**https://retailbbg.onrender.com**

## What We Built
A web app that generates hedge fund-style initiation of coverage memos for any stock ticker.

- **Stack**: Node.js + Express + OpenAI GPT-4o
- **Hosting**: Render (free tier, auto-deploys on push)
- **Repo**: https://github.com/Cahnja/retailbbg

## Current Prompt Version
**v1_two_step** (see `prompts/v1_two_step.md`)

Two-step approach:
1. Step 1: Identify the core thesis (what really matters for the stock)
2. Step 2: Write the memo using that thesis

Current score on AVGO: **5-6/10** (up from 2/10)

## Files
```
retailbbg/
├── server.js              # Express server with prompt logic
├── public/index.html      # Web interface
├── prompts/
│   └── v1_two_step.md     # Current prompt (documented)
├── examples/
│   ├── AVGO_reference.md  # Target quality (8.5/10)
│   ├── AVGO_vCurrent.md   # Old output (2/10)
│   └── GRADING.md         # Scoring methodology
├── .env                   # API key (not committed)
└── .env.example           # Template
```

## Grading Methodology
See `examples/GRADING.md`
- Wrong thesis = capped at 3
- Filler language = severe penalty
- Insight density is #1 priority

## To Resume Development
1. `npm start` — Run locally at http://localhost:3000
2. Edit prompt in `server.js` or reference `prompts/v1_two_step.md`
3. Test with: `curl -X POST http://localhost:3000/api/generate-report -H "Content-Type: application/json" -d '{"ticker":"AVGO"}'`
4. Push to deploy: `git add -A && git commit -m "message" && git push`

## What's Done
- [x] Basic web app
- [x] OpenAI GPT-4o integration
- [x] Two-step prompt (thesis → memo)
- [x] Deployed to Render
- [x] Grading methodology documented
- [x] Reference memo saved

## Next Steps
- [ ] Push prompt further to eliminate filler (target 7+/10)
- [ ] Test on other tickers (NFLX, MSFT, etc.) to check generalization
- [ ] Consider trying Claude API for comparison

## Key Learnings
- Model doesn't naturally find the "real story" — needs explicit guidance
- Few-shot examples in prompt help but aren't enough
- Two-step approach (research → write) works better than one-shot
- User had to inject thesis ("Broadcom created Google TPU") when creating reference memo manually
