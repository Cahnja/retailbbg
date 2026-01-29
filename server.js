require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/generate-report', async (req, res) => {
  const { ticker } = req.body;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker is required' });
  }

  try {
    const prompt = `You are a senior hedge fund analyst writing an initiation memo for your PM. Write a dense, institutional-quality coverage initiation on ${ticker.toUpperCase()}.

STRUCTURE (use these sections, adapt headings to fit the company):

1. **What [Company] Does in [Core Theme]**
Start with the company's primary business driver. If AI-related, lead with AI. Explain the actual mechanism of how they make money — not marketing language, but how the business works at an operational level. Name specific products, platforms, or services. Describe the customer relationship: who buys, why they buy, and what locks them in.

2. **Why [Market Shift] Favors This Business**
Explain the structural trend driving demand. Why is this happening now? What economics or technology shifts make this company's offering more valuable over time? Be specific about the unit economics or technical advantages.

3. **Demand Visibility and Scale**
How much forward visibility does management have? What is the nature of customer commitments — multi-year contracts, capacity reservations, recurring revenue? Quantify where possible. Describe whether this is cyclical or infrastructure-like spending.

4. **[Secondary Business Segment]: Why It Matters**
If there's a second major revenue driver or strategic asset, explain why it compounds the thesis. How does it interact with the primary business? Does it provide diversification, pricing power, or structural leverage?

5. **Competitive Positioning**
Name the 2-3 closest competitors by name. For each, explain specifically why they are structurally weaker:
- What do they lack in capabilities, customer relationships, or scale?
- Why can't they easily replicate the company's position?
- Where is concentration risk for competitors vs. this company?
Be concrete — reference actual products, customers, or market positions.

6. **Key Debates on the Stock**
List 4-5 numbered debates that real PMs argue about this name. For each:
- State the question clearly
- Give the bull case and bear case in 1-2 sentences each
- If there's a resolution or your view, state it briefly

STYLE RULES:
- Every sentence must contain a concrete fact, number, or inference. Delete anything generic.
- No introductions, no conclusions, no "in summary" — start directly with substance.
- Name real customers, products, competitors, and programs where known.
- Technical depth is good. Assume the reader is sophisticated.
- Tone: analytical, skeptical, direct. No hype, no marketing language.
- Do NOT include valuation, price targets, or financial projections.
- Density over length. A tight 1500 words beats a loose 3000.`;

    const message = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const report = message.choices[0].message.content;
    res.json({ report });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
