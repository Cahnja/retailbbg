# Project Status: Initiation of Coverage Report Generator

## What We Built
A web app that generates hedge fund-style initiation of coverage memos for any stock ticker.

- **Stack**: Node.js + Express + OpenAI GPT-4o
- **URL**: http://localhost:3000
- **Input**: Stock ticker (e.g., AVGO)
- **Output**: Dense, PM-grade equity research memo

## Files
- `server.js` — Express server with OpenAI API integration and the prompt
- `public/index.html` — Web interface
- `.env` — Contains OPENAI_API_KEY (do not commit)

## Current Prompt
The prompt is in `server.js` lines 21-56. It generates structured memos with:
- What the company does in its core theme
- Why market shifts favor the business
- Demand visibility and scale
- Secondary business segments
- Competitive positioning (naming specific competitors)
- Key debates on the stock (numbered, with bull/bear framing)

## To Resume
1. Start the server: `npm start`
2. Open http://localhost:3000
3. Test with a ticker

## Next Steps (if continuing)
- Test the updated prompt and compare output quality to the AVGO example
- Consider adding few-shot examples to the prompt for higher consistency
- Could integrate real-time stock data via an API
- Could add PDF export

## Reference
User provided a high-quality AVGO memo as the target output style. The prompt was reverse-engineered from that example.
