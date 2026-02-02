# Project Status: Initiation of Coverage Report Generator

## Live URL
**https://retailbbg.onrender.com**

## What We Built
A web app that generates hedge fund-style initiation of coverage memos for any stock ticker.

- **Stack**: Node.js + Express + OpenAI GPT-4o
- **Hosting**: Render (auto-deploys on push to GitHub)
- **Repo**: https://github.com/Cahnja/retailbbg

## Current Architecture
**Research + Generate process** (~60-90 seconds):
1. **Research Phase** (~50s) - All run in parallel:
   - SEC-API.io: Pull 10-K sections (Business, Risk Factors, MD&A) - ~15s
   - EarningsCall.biz: Pull last 2 quarters of earnings Q&A transcripts - ~5s
   - OpenAI web search: Investor narratives, bull/bear debates - ~30s
   - OpenAI web search: Reddit sentiment analysis - ~30s
2. **Generate** (~40s) - Create memo using Chat Completions API with template

## Data Sources
- **SEC-API.io** - 10-K filings (Business Description, Risk Factors, MD&A)
  - 90-day cache for 10-K data
- **EarningsCall.biz** - Earnings call transcripts
  - Extracts Q&A section only (reduces tokens)
  - Last 2 quarters fetched
  - 30-day cache
  - Tries NASDAQ, NYSE, AMEX exchanges automatically
- **OpenAI Responses API** - Web search for investor narratives
- **Reddit** (via web search) - Retail investor sentiment

## Memo Sections
1. **Investment Thesis** - Aggressive, short sentences, straight to the point
2. **History & Business Overview** - 3-4 paragraphs on company evolution
3. **Thesis Details** - 40-50% of memo, 4-5 numbered sub-sections with evidence
4. **Competitive Landscape** - Each competitor in separate paragraph
5. **Differentiation** - What makes products unique
6. **Key Debates** - Bull/Bear cases from earnings Q&A
7. **Key Risks** - From 10-K Risk Factors
8. **Management Quality (A-F)** - CEO rating with grade in header
9. **Retail Sentiment (1-10)** - Reddit sentiment with score in header
10. **Appendix: Key Earnings Call Q&A** - 3-5 direct quotes from transcripts

## Features
- **30-day caching** - Reports saved to `cache/` directory
- **Progress indicator** - Shows steps and estimated time remaining
- **Styled output** - Large titles, section headers, debate boxes
- **Bold key sentences** - Important insights highlighted
- **Management grading** - A-F scale (A's are rare, most CEOs are B or C)
- **Retail sentiment scoring** - 1-10 scale with full range usage

## Files
```
retailbbg/
├── server.js              # Express server with SEC + earnings + generation
├── public/index.html      # Web interface with progress UI
├── cache/                  # Cached reports (JSON files)
│   ├── sec/               # 10-K data cache (90 days)
│   │   └── [TICKER]_10K.json
│   ├── earnings/          # Earnings transcript cache (30 days)
│   │   └── [TICKER]_earnings.json
│   └── [TICKER].json      # Auto-generated report files
├── .env                   # API keys (not committed)
└── .gitignore             # Excludes node_modules, .env, cache/
```

## Environment Variables (Render)
```
OPENAI_API_KEY=...
SEC_API_KEY=...
EARNINGSCALL_API_KEY=...
```

## To Resume Development
1. `npm start` — Run locally at http://localhost:3000
2. Edit template in `server.js` (look for MEMO_TEMPLATE)
3. Test with: `curl -X POST http://localhost:3000/api/generate-report -H "Content-Type: application/json" -d '{"ticker":"AAPL"}'`
4. Push to deploy: `git add -A && git commit -m "message" && git push`

## What's Done
- [x] Basic web app with styled UI
- [x] OpenAI GPT-4o integration with web search
- [x] Template-based memo generation
- [x] Key Debates section with Bull/Bear format
- [x] 30-day report caching system
- [x] Progress indicator with step tracking and time estimate
- [x] Large titles and section headers
- [x] Bold key sentences in each section
- [x] Deployed to Render with auto-deploy
- [x] SEC-API.io integration for 10-K data (90-day cache)
- [x] EarningsCall.biz integration for earnings transcripts (30-day cache)
- [x] Q&A extraction from earnings transcripts
- [x] Reddit sentiment integration with 1-10 scoring
- [x] Management Quality grading (A-F scale)
- [x] Appendix section with earnings call Q&A quotes
- [x] Calibrated scoring (A's rare, full 1-10 range for sentiment)

## API Notes
- **SEC-API.io**: Query API + Extractor API for 10-K sections
- **EarningsCall.biz**: Starter plan ($39/month)
  - `/events` endpoint to find available transcripts
  - `/transcript` endpoint to fetch full text
  - Auto-detects exchange (NASDAQ/NYSE/AMEX)

## UI Features
- Title: 36px, dark blue with underline
- Section headers: 26px
- Debate boxes: Gray background with dark left border, compact spacing
- Bull case: Green text
- Bear case: Red text
- Cache indicator: Shows if report is cached with option to regenerate
- Progress bar: Animated with step indicators and countdown timer

## Key Learnings
- Model doesn't naturally find the "real story" — needs explicit guidance
- Template-based approach ensures consistent section structure
- Web search step is critical for finding investor-focused narratives
- 10-K data provides factual grounding
- Earnings Q&A reveals management priorities and analyst concerns
- Extracting only Q&A section reduces tokens by ~70%
- Scoring needs explicit calibration (A's should be rare, use full 1-10 range)
- Reddit search provides valuable retail sentiment perspective
