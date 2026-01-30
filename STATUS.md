# Project Status: Initiation of Coverage Report Generator

## Live URL
**https://retailbbg.onrender.com**

Share this with your team. First request after idle may take ~30 seconds (free tier cold start).

## What We Built
A web app that generates hedge fund-style initiation of coverage memos for any stock ticker.

- **Stack**: Node.js + Express + OpenAI GPT-4o
- **Hosting**: Render (free tier)
- **Repo**: https://github.com/Cahnja/retailbbg

## Files
- `server.js` — Express server with OpenAI API integration and the prompt
- `public/index.html` — Web interface
- `.env` — Local environment (OPENAI_API_KEY, not committed)
- `.env.example` — Template for API key

## Current Prompt
Located in `server.js` lines 21-57. Generates structured PM-grade memos with:
- What the company does in its core theme
- Why market shifts favor the business
- Demand visibility and scale
- Secondary business segments
- Competitive positioning (names specific competitors and why they're weaker)
- Key debates on the stock (numbered, with bull/bear framing)

Style: analytical, skeptical, factual. Density over length.

## To Resume Development
1. `npm start` — Run locally at http://localhost:3000
2. Edit `server.js` to refine the prompt
3. Test locally, then push to deploy:
   ```
   git add -A && git commit -m "your message" && git push
   ```
   Render auto-deploys on push.

## What's Done
- [x] Basic web app with ticker input
- [x] OpenAI GPT-4o integration
- [x] PM-grade prompt based on user's AVGO example
- [x] Deployed to Render
- [x] GitHub repo created

## Next Steps (if continuing)
- Test prompt quality across different tickers
- Add few-shot examples to prompt for more consistent output
- Integrate real-time stock data via API (Yahoo Finance, etc.)
- Add PDF export
- Add authentication if needed for team access

## Reference
User provided a high-quality AVGO memo as the target output style. Key qualities:
- Dense, every sentence adds information
- Names specific customers, products, competitors
- Explains switching costs and structural advantages
- Key Debates section with bull/bear framing
- No valuation or price targets
