require('dotenv').config();
const fs = require('fs');
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const HTML_TEMPLATE = fs.readFileSync('/Users/jackcahn/retailbbg/mockups/report-a-full.html', 'utf8');
const CSS_ONLY = HTML_TEMPLATE.match(/<style>([\s\S]*?)<\/style>/)[1];

// Approach 1: Few-shot example
const APPROACH_1_PROMPT = `Here is an example of the exact writing style and HTML format I want:

EXAMPLE THESIS (for style reference):
"Dominant semiconductor franchise with unmatched FCF generation. VMware acquisition transforms the business into an infrastructure software powerhouse. AI networking tailwinds accelerating. Trading at discount to intrinsic value despite best-in-class capital allocation."

EXAMPLE PARAGRAPH STYLE:
"Broadcom Inc. is a global technology leader that designs, develops, and supplies semiconductor and infrastructure software solutions. The company operates through two segments: Semiconductor Solutions (representing approximately 55% of revenue post-VMware) and Infrastructure Software (approximately 45% of revenue)."

Write a complete Goldman Sachs-style investment research report for Broadcom (AVGO) using this EXACT writing style - punchy, confident, specific facts and numbers.

Output ONLY raw HTML (no markdown, no code blocks). Use these exact HTML classes:
- report-header, header-left, header-right, company-name, ticker-info, price, rating-badge
- thesis-box, thesis-header, thesis-icon, thesis-label, thesis-text
- h2 for section headers
- h3 with <span class="num">N</span> for numbered thesis points
- insight-box, insight-label, insight-text
- customer-box with <strong> and <p>
- competitor-box with <strong> and <p>
- debate-box, debate-question, bull-case, bear-case
- data-table with th and td class="number"
- valuation-summary
- risk-box with <strong> and <p>

Include: Business Overview, Thesis Details (3 points), Key Customers & Partnerships (3), Competitive Positioning (3), Key Debates (3), Management Quality, Retail Sentiment, Financial Analysis (table), Valuation, Key Risks (4), Conclusion.`;

// Approach 2: Style instructions
const APPROACH_2_PROMPT = `Write a Goldman Sachs-style investment research report for Broadcom (AVGO).

WRITING STYLE REQUIREMENTS:
- Short, punchy sentences (under 15 words each)
- Confident and direct - no hedging
- NO filler phrases: "positions the company", "compelling opportunity", "well-positioned", "poised for growth"
- NO weak phrases: "benefiting from", "enhancing", "represents a", "capitalizes on"
- Use strong active verbs: dominates, drives, accelerates, transforms
- Every sentence must have specific facts or numbers
- Sound like a senior Goldman analyst writing for the trading desk

Output ONLY raw HTML (no markdown, no code blocks). Use these exact HTML classes:
- report-header, header-left, header-right, company-name, ticker-info, price, rating-badge
- thesis-box, thesis-header, thesis-icon, thesis-label, thesis-text
- h2 for section headers
- h3 with <span class="num">N</span> for numbered thesis points
- insight-box, insight-label, insight-text
- customer-box with <strong> and <p>
- competitor-box with <strong> and <p>
- debate-box, debate-question, bull-case, bear-case
- data-table with th and td class="number"
- valuation-summary
- risk-box with <strong> and <p>

Include: Business Overview, Thesis Details (3 points), Key Customers & Partnerships (3), Competitive Positioning (3), Key Debates (3), Management Quality, Retail Sentiment, Financial Analysis (table), Valuation, Key Risks (4), Conclusion.`;

async function generateReport(prompt, name) {
  console.log(`Generating ${name}...`);

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 10000,
    messages: [
      {
        role: 'system',
        content: 'You are a senior Goldman Sachs equity research analyst. Output only raw HTML, no markdown.'
      },
      { role: 'user', content: prompt }
    ]
  });

  let html = response.choices[0].message.content;
  html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();

  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} - AVGO Report</title>
  <style>${CSS_ONLY}</style>
</head>
<body>
  <div class="page">
    ${html}
  </div>
</body>
</html>`;

  return fullHtml;
}

async function main() {
  try {
    const [approach1, approach2] = await Promise.all([
      generateReport(APPROACH_1_PROMPT, 'Approach 1 - Few-shot'),
      generateReport(APPROACH_2_PROMPT, 'Approach 2 - Style Instructions')
    ]);

    fs.writeFileSync('/Users/jackcahn/retailbbg/public/compare/approach1.html', approach1);
    fs.writeFileSync('/Users/jackcahn/retailbbg/public/compare/approach2.html', approach2);

    console.log('Done! View at:');
    console.log('  http://localhost:3000/compare/approach1.html');
    console.log('  http://localhost:3000/compare/approach2.html');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
