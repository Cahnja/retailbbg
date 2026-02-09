# Project Status: RetailBBG - Stock Research Report Generator

## Live URL
**https://retailbbg.com** (DigitalOcean VPS: 138.197.118.128)

## What We Built
A web app that generates Goldman Sachs-style stock research with multiple tabs:
- **Market Update** (HOME) - Index prices + AI-generated market driver bullets with clickable details
- **Top Movers** - Top gainers/losers with explanations and clickable detail popups
- **Portfolio** - Personal watchlist with login/signup functionality
- **Idea Generation** - Themed stock ideas with investment thesis
- **Initiation** - Hedge fund-style coverage initiation memos

## Current Architecture

**Stack**: Node.js + Express + OpenAI GPT-4o/GPT-4o-mini + Yahoo Finance + Finnhub + JWT Auth
**Hosting**: DigitalOcean VPS with PM2 process manager
**Repo**: https://github.com/Cahnja/retailbbg

### Data Sources
| Source | Purpose | Cache Duration |
|--------|---------|----------------|
| Yahoo Finance (`yahoo-finance2`) | Stock/index prices, market data | Real-time |
| **Finnhub API** | Stock news headlines for Top Movers | Real-time |
| OpenAI GPT-4o | Market Update, detailed analysis, reports | Varies |
| OpenAI GPT-4o-mini | Top Movers catalysts, company descriptions | Varies |
| OpenAI Web Search (Responses API) | Market drivers, stock click-through details | 4 hours |
| SEC-API.io | 10-K filings (Business, Risk, MD&A) | 90 days |
| EarningsCall.biz | Earnings call transcripts | 30 days |
| Alpha Vantage | Financial data for reports | 30 days |

### Cache Hierarchy
- **Initiation reports**: 30 days
- **Earnings reviews**: 30 days
- **Market Update**: 4 hours
- **Top Movers**: Always serve cached (refresh on schedule only)
- **Market Driver Details**: 4 hours
- **Stock Explanation Details**: 4 hours
- **Thematic themes**: 30 days
- **Company descriptions**: Permanent (one-time generation)
- **User watchlists**: Persistent (JSON files)
- **Token usage logs**: 7 days (auto-cleanup)

## Features by Tab

### 1. Market Update (HOME - retailbbg.com/)
- Index prices (S&P 500, Nasdaq, Dow Jones) in card layout
- 10 AI-generated market driver bullets
- **Clickable bullets** open v2 side panel with detailed analysis
- Color-coded price moves (green positive, red negative)
- "See Earnings Review" links for earnings-related bullets
- Bold important sentences in detail popups

### 2. Top Movers
- Top 5 gainers and losers from S&P 500
- Two-sentence bullet points (catalyst + company description)
- **Clickable explanations** open v2 side panel with detailed analysis
- Short company names only (no tickers in text)
- Concise, punchy sentences starting with catalyst
- Always serves cached data instantly (no loading)

### 3. Portfolio
- Add stocks to personal watchlist (validates ticker before adding)
- Prices with % change (auto-refresh every 15 minutes)
- **Clickable stocks** open side panel with web search + 4-paragraph analysis
- **User authentication**:
  - Email/password signup and login
  - Google Sign-In integration
  - JWT tokens (30-day expiry)
- Local storage fallback (works without login)
- Server sync when logged in
- Toast notifications (no browser alerts)

### 4. Idea Generation (formerly Thematic Investments)
- Themed stock ideas (AI, Clean Energy, Quantum, etc.)
- Shows investment thesis as description
- Google-style card layout

### 5. Initiation Reports
- Generate hedge fund-style memos for any ticker
- 10 sections: Thesis, History, Thesis Details, Competition, Differentiation, Key Debates, Risks, Management Quality, Retail Sentiment, Appendix
- Progress indicator with step tracking
- 30-day caching

### 6. Earnings Review (Full Page)
- **Clean URL**: retailbbg.com/[ticker]-earnings (e.g., /pltr-earnings)
- Goldman Sachs-style analysis with sections:
  - Headline (punchy, aggressive)
  - Key Takeaways
  - Key Debates (Bull/Bear cases)
  - Why It's Moving
  - Our View
  - Management Q&A (5-10 actual Q&A pairs from transcript)
- Timer during generation (like initiation reports)
- 30-day caching

## Clean URLs
- **retailbbg.com/** → Market Update (home)
- **retailbbg.com/top-movers** → Top Movers
- **retailbbg.com/portfolio** → Portfolio/Watchlist
- **retailbbg.com/ideageneration** → Idea Generation
- **retailbbg.com/tsla** → TSLA Initiation Report
- **retailbbg.com/pltr-earnings** → PLTR Earnings Review
- **retailbbg.com/thematic** → Idea Generation (alias)
- **retailbbg.com/thematic/ai** → AI theme stocks
- **retailbbg.com/thematic/quantum** → Quantum theme stocks
- **retailbbg.com/thematic/clean-energy** → Clean Energy theme stocks
- **retailbbg.com/token-monitor.html** → Token usage monitoring dashboard

## Banner Navigation
**Tab order (40px height, pill-style tabs):**
1. Market Update (home)
2. Top Movers
3. Portfolio
4. Idea Generation
5. Initiation

## Auto-Refresh Schedule
Using **node-cron** for reliable scheduling (Mon-Fri, Eastern Time):

**Market Update + Top Movers:**
- 9:31 AM, 11:31 AM, 1:31 PM, 3:31 PM, 4:00 PM

**Market Update only:**
- 7:30 AM (pre-market)
- 6:00 PM (after-hours)

**Manual Refresh:**
- `/api/market-update?refresh=true`
- `/api/market-movers?refresh=true`

**No cache warming on server restart** (saves OpenAI tokens)

## Files
```
retailbbg/
├── server.js              # Express server (main backend)
├── public/
│   ├── index.html         # Initiation Reports page
│   ├── market.html        # Market Update page (home)
│   ├── portfolio.html     # Top Movers page
│   ├── watchlist.html     # Portfolio/Watchlist page
│   ├── thematic.html      # Idea Generation page
│   ├── earnings.html      # Earnings Review page
│   └── token-monitor.html # Token usage monitoring dashboard
├── mockups/               # HTML mockups for UI designs
│   ├── mockup-movers-v1.html through v5.html
│   ├── mockup-market-v1.html through v3.html
│   └── mockup-popup-v1.html through v3.html
├── cache/
│   ├── [TICKER].json      # Initiation report cache
│   ├── sec/               # 10-K data cache
│   ├── earnings/          # Earnings transcript cache
│   ├── earnings-reviews/  # Earnings review cache
│   ├── alphavantage/      # Financial data cache
│   ├── market-movers/     # Top movers cache
│   ├── market/            # Market update cache
│   ├── market-drivers/    # Market driver details cache
│   ├── stock-explanations/# Stock explanation details cache
│   ├── stock-analysis/    # Per-stock analysis cache (30 min TTL)
│   ├── company-descriptions.json  # Permanent company descriptions
│   ├── token-usage.json   # Token usage logs (7-day retention)
│   ├── users/             # User accounts (JSON)
│   ├── watchlists/        # User watchlists (JSON)
│   └── websearch/         # Web search cache
├── .env                   # API keys (not committed)
└── package.json
```

## Environment Variables
```
OPENAI_API_KEY=...
SEC_API_KEY=...
EARNINGSCALL_API_KEY=...
ALPHA_VANTAGE_API_KEY=...
FINNHUB_API_KEY=...   # For stock news headlines
JWT_SECRET=...
GOOGLE_CLIENT_ID=...  # For Google Sign-In
```

## Key API Endpoints
| Endpoint | Description |
|----------|-------------|
| `GET /api/market-update` | Index prices + 10 market driver bullets |
| `GET /api/market-update?refresh=true` | Force refresh market update |
| `GET /api/market-driver-details` | Detailed analysis for a market driver |
| `GET /api/market-movers` | Top gainers/losers (always cached) |
| `GET /api/market-movers?refresh=true` | Force refresh top movers |
| `GET /api/stock-explanation-details` | Detailed analysis for a stock move |
| `GET /api/earnings-review/:ticker` | Earnings review with Q&A |
| `POST /api/generate-report` | Generate initiation report |
| `GET /api/thematic/:theme` | Thematic investment ideas (5 stocks) |
| `GET /api/watchlist/prices` | Get prices for watchlist stocks |
| `POST /api/auth/signup` | Create account |
| `POST /api/auth/login` | Login (returns JWT) |
| `POST /api/auth/google` | Google Sign-In |
| `GET /api/auth/me` | Get current user |
| `GET /api/watchlists` | Get all user's watchlists |
| `POST /api/watchlists` | Create new watchlist |
| `PUT /api/watchlists/:id` | Rename watchlist |
| `DELETE /api/watchlists/:id` | Delete watchlist |
| `POST /api/watchlists/:id/add` | Add stock to specific watchlist |
| `DELETE /api/watchlists/:id/remove/:ticker` | Remove stock from watchlist |
| `GET /api/token-usage` | Token usage stats for monitoring dashboard |
| `GET /api/generate-company-descriptions` | Pre-generate S&P 500 company descriptions |

## Deployment
```bash
# Local development
npm start

# Deploy to VPS
scp server.js root@138.197.118.128:/root/retailbbg/
scp -r public/* root@138.197.118.128:/root/retailbbg/public/
ssh root@138.197.118.128 "cd /root/retailbbg && npm install && pm2 restart retailbbg"

# View logs
ssh root@138.197.118.128 "pm2 logs retailbbg --lines 50"
```

## Recent Changes (Feb 5, 2026)

### Major: Token Cost Optimization (99% reduction for Top Movers)
- [x] **Finnhub Integration**: Replaced OpenAI web search with Finnhub news API for Top Movers
  - Before: ~17,000 tokens/stock (web search reads full articles)
  - After: ~200 tokens/stock (Finnhub headlines + GPT-4o-mini)
  - Savings: ~$5/refresh → ~$0.01/refresh
- [x] **Permanent Company Descriptions**: One-sentence descriptions cached forever
  - Generated once for all 528 S&P 500 stocks
  - Uses GPT-4o-mini (cheap)
  - Never regenerated unless manually cleared
- [x] **Model Optimization**: Top Movers now uses GPT-4o-mini instead of GPT-4o

### Token Monitoring Dashboard
- [x] **Token Usage Logging**: All OpenAI API calls now logged with token counts
- [x] **Monitoring Dashboard**: `/token-monitor.html` shows:
  - Today's total tokens and estimated cost
  - Hourly breakdown chart
  - Usage by endpoint
  - 7-day history
- [x] **API Endpoint**: `GET /api/token-usage` returns usage data

### Clean URLs for Navigation
- [x] `/top-movers` → Top Movers page
- [x] `/portfolio` → Portfolio/Watchlist page
- [x] `/ideageneration` → Idea Generation page
- [x] Added routes to skip list to prevent `/:ticker` wildcard interception

### Bug Fixes
- [x] **ENPH Cache Issue**: Added `forceRefresh` flag to ensure scheduled refreshes get fresh data
- [x] **Idea Generation Bugs**: Fixed error handling, empty state, array index safety
- [x] **Nav Links**: Fixed Idea Generation link pointing to wrong page

### Cache Resilience
- [x] **Cache Protection**: Never clear cache unless new data successfully fetched
- [x] **Retry Mechanism**: If scheduled refresh fails, retry every hour until successful

### Prompt Improvements
- [x] **Market Driver Details**: Fact-based style, specific numbers, no generic advice
- [x] **Top Movers Explanations**: No quotation marks, no line breaks in output

### Click-Through Web Search (Major Enhancement)
- [x] **Top Movers Click-Through**: Web search + 4-paragraph detailed analysis
- [x] **Market Driver Click-Through**: Web search + 4-paragraph detailed analysis
- [x] **Portfolio Click-Through**: Same functionality as Top Movers (shared cache)
- [x] **Unified Style**: Both use fact-based prompts with bold key sentences, no headers
- [x] **Shared Cache**: Stock explanations cached by `{TICKER}_{DATE}.json` (4-hour TTL)

### Time-Aware AI Prompts
- [x] **Pre-market detection**: Before 9:30am ET, AI knows data is from "yesterday"
- [x] **Weekend detection**: On weekends, AI knows data is from "Friday"
- [x] **Monday pre-market**: Correctly references "Friday" instead of "yesterday"
- [x] Prevents AI confusion about stock moves from previous trading day

### UI Improvements
- [x] **Top Movers Headers**: Changed from green/red backgrounds to navy with colored dot accents (Option D)
- [x] **Toast Notifications**: Replaced browser alerts with styled toast messages on Portfolio page
- [x] **Portfolio Auto-Refresh**: Changed from 30 seconds to 15 minutes (reduce Yahoo Finance load)

### Portfolio Bug Fixes
- [x] **Duplicate Entry Bug**: Fixed double-push when adding stocks while logged in
- [x] **Ticker Validation**: Now validates ticker exists via Yahoo Finance before adding
- [x] **Button Feedback**: Shows "Validating..." while checking ticker

## Previous Changes (Feb 4, 2026)

### New Features
- [x] **Multiple Watchlists**: Users can create, rename, and delete multiple watchlists (max 10 per user, 50 stocks each)
- [x] **Google OAuth**: Full Google Sign-In integration with `google-auth-library`
- [x] **Thematic URL Routing**: Clean URLs like `/thematic/ai`, `/thematic/quantum` with back button support
- [x] **Manual Refresh Endpoints**: `?refresh=true` parameter for Market Update and Top Movers

### Scheduling Fix
- [x] **Replaced interval-based scheduling with node-cron** for reliable refresh times
- [x] Cron jobs trigger at exact times (9:31, 11:31, 1:31, 3:31, 4:00 PM ET)

### UI/UX Improvements
- [x] Market Update is now the HOME page (retailbbg.com/)
- [x] Removed timestamps from Market Update page
- [x] Market driver popups now 2 paragraphs (concise)
- [x] Top Movers popups now 2 paragraphs (concise)
- [x] Top Movers: Whole explanation box clickable (not individual bullets)
- [x] Top Movers: Added page title header matching Market Update style
- [x] Top Movers: Removed "Refresh Data" button, subtle "last updated" text
- [x] Thematic: Reduced to 5 stocks per theme (was 10)
- [x] Consistent styling across all pages (sans-serif fonts, navy blue titles)

### API Endpoints Added
- [x] `GET /api/watchlists` - Get all watchlists
- [x] `POST /api/watchlists` - Create watchlist
- [x] `PUT /api/watchlists/:id` - Rename watchlist
- [x] `DELETE /api/watchlists/:id` - Delete watchlist
- [x] `PUT /api/watchlists/:id/default` - Set default watchlist
- [x] `POST /api/watchlists/:id/add` - Add ticker to specific watchlist
- [x] `DELETE /api/watchlists/:id/remove/:ticker` - Remove ticker from specific watchlist

### Previous Changes
- [x] New tab order: Market Update, Top Movers, Portfolio, Idea Generation, Initiation
- [x] Renamed "Thematic Investments" to "Idea Generation"
- [x] User authentication (email/password + Google Sign-In)
- [x] Clean URLs for initiation reports (retailbbg.com/tsla)
- [x] Clean URLs for earnings reviews (retailbbg.com/pltr-earnings)
- [x] Clickable Market Update bullets with v2 side panel popup
- [x] Clickable Top Movers explanations with v2 side panel popup
- [x] Earnings Review with Key Debates + Management Q&A sections
- [x] Bold important sentences in detail popups

## UI Components

### V2 Side Panel Popup
Used for Market Update and Top Movers detail views:
- Slides in from right (480px width)
- Blue gradient header
- Sections: Key Takeaways, Analysis, Market Impact, What to Watch
- Loading skeleton animation
- Responsive (full width on mobile)

### Earnings Review Page
- Large title with ticker
- T+1 earnings move badge (color-coded)
- Sections with Goldman Sachs styling
- Bull/Bear debate boxes (green/red)
- Management Q&A with formatted quotes

## Cache Policy
- **Top Movers**: Always serve cached data, never regenerate on user request
- **Market Update**: Serve cached, refresh on schedule
- **Initiation reports**: Never clear without permission
- **Earnings reviews**: 30-day cache
- **Detail popups**: 4-hour cache

## Known Issues / Notes
- Google Sign-In requires GOOGLE_CLIENT_ID in .env
- Yahoo Finance may show zeros briefly at startup
- Earnings reviews require actual transcript content (>100 chars)
- Alpha Vantage has rate limits; some reports may need regeneration
- Server restart count is high due to development deployments
