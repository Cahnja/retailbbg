require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const SEC_API_KEY = process.env.SEC_API_KEY;
const EARNINGSCALL_API_KEY = process.env.EARNINGSCALL_API_KEY;

const app = express();

// Cache configuration
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_MAX_AGE_DAYS = 30;

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Cache helper functions
function getCachePath(ticker) {
  return path.join(CACHE_DIR, `${ticker.toUpperCase()}.json`);
}

function getCachedReport(ticker) {
  const cachePath = getCachePath(ticker);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.timestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= CACHE_MAX_AGE_DAYS) {
      return cached;
    }
    return null; // Cache expired
  } catch (error) {
    console.error('Error reading cache:', error);
    return null;
  }
}

function saveToCache(ticker, report) {
  const cachePath = getCachePath(ticker);
  const cacheData = {
    ticker: ticker.toUpperCase(),
    report,
    timestamp: Date.now(),
    generatedAt: new Date().toISOString()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
  } catch (error) {
    console.error('Error writing cache:', error);
  }
}

// SEC API functions
const SEC_CACHE_DIR = path.join(__dirname, 'cache', 'sec');
const SEC_CACHE_MAX_AGE_DAYS = 90; // 10-Ks are annual, cache for 90 days

// Ensure SEC cache directory exists
if (!fs.existsSync(SEC_CACHE_DIR)) {
  fs.mkdirSync(SEC_CACHE_DIR, { recursive: true });
}

function getSecCachePath(ticker) {
  return path.join(SEC_CACHE_DIR, `${ticker.toUpperCase()}_10K.json`);
}

function getCachedSecData(ticker) {
  const cachePath = getSecCachePath(ticker);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= SEC_CACHE_MAX_AGE_DAYS) {
      console.log(`Using cached 10-K for ${ticker} (cached ${ageDays.toFixed(1)} days ago)`);
      return cached.data;
    }
    return null; // Cache expired
  } catch (error) {
    console.error('Error reading SEC cache:', error);
    return null;
  }
}

function saveSecToCache(ticker, data) {
  const cachePath = getSecCachePath(ticker);
  const cacheData = {
    ticker: ticker.toUpperCase(),
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log(`Cached 10-K for ${ticker}`);
  } catch (error) {
    console.error('Error writing SEC cache:', error);
  }
}

async function fetch10KData(ticker) {
  // Check cache first
  const cached = getCachedSecData(ticker);
  if (cached) {
    return cached;
  }

  try {
    // Step 1: Query API to find the latest 10-K filing
    const queryResponse = await fetch('https://api.sec-api.io?token=' + SEC_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: {
          query_string: {
            query: `ticker:${ticker} AND formType:"10-K"`
          }
        },
        from: "0",
        size: "1",
        sort: [{ filedAt: { order: "desc" } }]
      })
    });

    const queryData = await queryResponse.json();

    if (!queryData.filings || queryData.filings.length === 0) {
      console.log(`No 10-K found for ${ticker}`);
      return null;
    }

    const filing = queryData.filings[0];
    const filingUrl = filing.linkToFilingDetails;
    console.log(`Found 10-K for ${ticker}: ${filing.filedAt}`);

    // Step 2: Use Extractor API to get key sections
    const sections = ['1', '1A', '7']; // Business, Risk Factors, MD&A
    const sectionNames = ['Business Description', 'Risk Factors', 'Management Discussion & Analysis'];

    let extractedData = {
      companyName: filing.companyName,
      filedAt: filing.filedAt,
      fiscalYear: filing.periodOfReport,
      sections: {}
    };

    for (let i = 0; i < sections.length; i++) {
      try {
        const extractorUrl = `https://api.sec-api.io/extractor?url=${encodeURIComponent(filingUrl)}&item=${sections[i]}&type=text&token=${SEC_API_KEY}`;
        const sectionResponse = await fetch(extractorUrl);
        const sectionText = await sectionResponse.text();

        // Limit each section to ~4000 chars to avoid token limits
        extractedData.sections[sectionNames[i]] = sectionText.substring(0, 4000);
        console.log(`Extracted ${sectionNames[i]}: ${sectionText.length} chars`);
      } catch (err) {
        console.log(`Failed to extract section ${sections[i]}:`, err.message);
      }
    }

    // Cache the extracted data
    saveSecToCache(ticker, extractedData);

    return extractedData;
  } catch (error) {
    console.error('SEC API error:', error);
    return null;
  }
}

// Extract Q&A section from earnings transcript
function extractQASection(transcript) {
  if (!transcript) return '';

  // Common markers for Q&A section start
  const qaMarkers = [
    'Question-and-Answer Session',
    'Questions and Answers',
    'Q&A Session',
    'Operator: Our first question',
    'Operator: Thank you. Our first question',
    'Operator: We will now begin the question-and-answer',
    'And our first question',
    'We\'ll now open the call for questions'
  ];

  let qaStart = -1;
  let markerUsed = '';

  // Find where Q&A section starts
  for (const marker of qaMarkers) {
    const index = transcript.toLowerCase().indexOf(marker.toLowerCase());
    if (index !== -1 && (qaStart === -1 || index < qaStart)) {
      qaStart = index;
      markerUsed = marker;
    }
  }

  if (qaStart === -1) {
    // No Q&A section found, return last portion of transcript (likely contains Q&A)
    console.log('No Q&A marker found, using last 8000 chars');
    return transcript.slice(-8000);
  }

  console.log(`Found Q&A section starting with: "${markerUsed}"`);
  return transcript.substring(qaStart);
}

// API Ninjas - Earnings Call Transcripts
const EARNINGS_CACHE_DIR = path.join(__dirname, 'cache', 'earnings');
const EARNINGS_CACHE_MAX_AGE_DAYS = 30; // Cache for 30 days

// Ensure earnings cache directory exists
if (!fs.existsSync(EARNINGS_CACHE_DIR)) {
  fs.mkdirSync(EARNINGS_CACHE_DIR, { recursive: true });
}

function getEarningsCachePath(ticker) {
  return path.join(EARNINGS_CACHE_DIR, `${ticker.toUpperCase()}_earnings.json`);
}

function getCachedEarningsData(ticker) {
  const cachePath = getEarningsCachePath(ticker);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= EARNINGS_CACHE_MAX_AGE_DAYS) {
      console.log(`Using cached earnings transcript for ${ticker} (cached ${ageDays.toFixed(1)} days ago)`);
      return cached.data;
    }
    return null; // Cache expired
  } catch (error) {
    console.error('Error reading earnings cache:', error);
    return null;
  }
}

function saveEarningsToCache(ticker, data) {
  const cachePath = getEarningsCachePath(ticker);
  const cacheData = {
    ticker: ticker.toUpperCase(),
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log(`Cached earnings transcript for ${ticker}`);
  } catch (error) {
    console.error('Error writing earnings cache:', error);
  }
}

async function fetchEarningsTranscripts(ticker) {
  // Check cache first
  const cached = getCachedEarningsData(ticker);
  if (cached) {
    return cached;
  }

  const EARNINGSCALL_BASE = 'https://v2.api.earningscall.biz';
  const exchanges = ['NASDAQ', 'NYSE', 'AMEX']; // Try these exchanges in order

  try {
    // Step 1: Find available earnings events for this ticker
    let eventsData = null;
    let workingExchange = null;

    for (const exchange of exchanges) {
      try {
        const eventsUrl = `${EARNINGSCALL_BASE}/events?apikey=${EARNINGSCALL_API_KEY}&exchange=${exchange}&symbol=${ticker}`;
        const eventsResponse = await fetch(eventsUrl);

        if (eventsResponse.ok) {
          const data = await eventsResponse.json();
          if (data && data.events && data.events.length > 0) {
            eventsData = data;
            workingExchange = exchange;
            console.log(`Found ${ticker} on ${exchange} with ${data.events.length} earnings events`);
            break;
          }
        }
      } catch (err) {
        // Try next exchange
      }
    }

    if (!eventsData || !workingExchange) {
      console.log(`No earnings events found for ${ticker}`);
      return null;
    }

    // Step 2: Get the 2 most recent published events
    const publishedEvents = eventsData.events
      .filter(e => e.is_published)
      .sort((a, b) => {
        // Sort by year desc, then quarter desc
        if (b.year !== a.year) return b.year - a.year;
        return b.quarter - a.quarter;
      })
      .slice(0, 2);

    if (publishedEvents.length === 0) {
      console.log(`No published transcripts available for ${ticker}`);
      return null;
    }

    // Step 3: Fetch transcripts for these events
    const transcriptPromises = publishedEvents.map(async (event) => {
      try {
        const transcriptUrl = `${EARNINGSCALL_BASE}/transcript?apikey=${EARNINGSCALL_API_KEY}&exchange=${workingExchange}&symbol=${ticker}&year=${event.year}&quarter=${event.quarter}&level=1`;
        const response = await fetch(transcriptUrl);

        if (!response.ok) {
          console.log(`Transcript fetch failed for ${ticker} Q${event.quarter} ${event.year}: ${response.status}`);
          return null;
        }

        const data = await response.json();
        if (!data || !data.text) {
          return null;
        }

        // Extract Q&A section only
        const qaSection = extractQASection(data.text);

        return {
          year: event.year,
          quarter: event.quarter,
          transcript: qaSection
        };
      } catch (err) {
        console.log(`Error fetching transcript for ${ticker} Q${event.quarter} ${event.year}:`, err.message);
        return null;
      }
    });

    const results = await Promise.all(transcriptPromises);
    const transcripts = results.filter(t => t !== null);

    if (transcripts.length === 0) {
      console.log(`No earnings transcripts could be fetched for ${ticker}`);
      return null;
    }

    const earningsData = {
      ticker: ticker.toUpperCase(),
      companyName: eventsData.company_name,
      transcripts: transcripts
    };

    console.log(`Fetched ${transcripts.length} earnings transcripts for ${ticker} via EarningsCall.biz`);

    // Cache the data
    saveEarningsToCache(ticker, earningsData);

    return earningsData;
  } catch (error) {
    console.error('EarningsCall.biz API error:', error);
    return null;
  }
}

const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Memo template with section instructions
const MEMO_TEMPLATE = `
## Investment Thesis
Synthesize the key reason or reasons to buy the stock in a short overview. Stylistically, this should be very aggressively written (short sentences, not verbose, straight to the point).

## History & Business Overview
- When was the company founded and how has it evolved since then to get us to where we are today?
- What are the key products that the company sells?
- This section should be 3-4 detailed paragraphs covering:
  - Founding story and early history
  - Major pivots, acquisitions, or transformations over time
  - Current business segments and revenue breakdown
  - Key products/services in each segment with specific details

## Thesis Details
This is the MOST IMPORTANT and LONGEST section - it should be 40-50% of the entire memo.
- Go into detail on the key reasons to buy the stock
- Divide into 4-5 numbered sub-sections (e.g., "### 1. First Reason", "### 2. Second Reason")
- Each sub-section should be 2-3 substantial paragraphs with:
  - Specific facts, numbers, and evidence
  - Customer names, market sizes, growth rates
  - Why this matters for the stock

## Competitive Landscape
- List the company's competitors and what makes them better/worse vs. our company
- Separate the competitors into separate paragraphs for each
- Are there threats from new entrants? Who are new entrants in this category?

## Differentiation
What makes the company's products differentiated vs. the competition?

## Key Debates
What are the key debates on the stock? Use the Q&A from the earnings transcripts to see what questions analysts are asking and how management is answering those questions. Format as numbered debates with Bull Case and Bear Case for each.

## Key Risks
What are the biggest risks going forward? Use the Risk Factors section from the 10-K to help lay out some of the key risks.

## Management Quality (A/B/C/D/F)
- Who is the CEO and how long has he/she been at the company?
- How would you rate the CEO (scale of A, B, C, D, F) and why?
- Put the grade in the section header like "## Management Quality (B)"
- GRADING SCALE (be critical - A's should be rare):
  - A = Exceptional, top-decile CEO (e.g., Jensen Huang, Mark Zuckerberg turnaround). Reserved for proven multi-year track records of outstanding execution, capital allocation, and value creation.
  - B = Good, above-average management. Solid execution, meets expectations, no major missteps.
  - C = Average, nothing special. Adequate but uninspiring, or too new to judge.
  - D = Below average. Notable missteps, poor capital allocation, or questionable decisions.
  - F = Poor. Significant value destruction, major strategic errors, or integrity concerns.

## Retail Sentiment (X/10)
- Summarize what retail investors on Reddit are saying about this stock
- Include the sentiment score (1-10) in the section header
- What are the main bull/bear arguments retail investors are making?
- SCORING SCALE (use the full range):
  - 1-2 = Extremely bearish, retail hates this stock
  - 3-4 = Bearish, more negative than positive sentiment
  - 5 = Neutral/mixed, no clear consensus
  - 6-7 = Moderately bullish, generally positive but with reservations
  - 8-9 = Very bullish, strong retail enthusiasm
  - 10 = Extreme euphoria (meme stock level hype)
- IMPORTANT: Only include this section if Reddit data is available. Skip entirely if no Reddit discussions found.

## Appendix: Key Earnings Call Q&A
- Select 3-5 of the most important/revealing questions from the earnings call transcripts
- Include direct quotes from analysts and management
- Format each as (no extra spacing between Q and A):
  **Q: [Analyst question - direct quote or close paraphrase]**
  A: [Management's response - direct quote or close paraphrase]
- Focus on questions that reveal key debates, growth drivers, or risks
- IMPORTANT: Only include this section if earnings transcript data is available. Skip if no transcripts.
`;

app.post('/api/generate-report', async (req, res) => {
  const { ticker, forceRefresh } = req.body;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker is required' });
  }

  // Check cache first (unless forceRefresh is requested)
  if (!forceRefresh) {
    const cached = getCachedReport(ticker);
    if (cached) {
      console.log(`Returning cached report for ${ticker.toUpperCase()} (generated ${cached.generatedAt})`);
      return res.json({
        report: cached.report,
        cached: true,
        generatedAt: cached.generatedAt
      });
    }
  }

  try {
    // STEP 1a: Fetch 10-K data and earnings transcript (run in parallel with web search)
    console.log(`Fetching 10-K and earnings transcript for ${ticker.toUpperCase()}...`);
    const secDataPromise = fetch10KData(ticker.toUpperCase());
    const earningsPromise = fetchEarningsTranscripts(ticker.toUpperCase());

    // STEP 1b: Research with web search (using Responses API for web search)
    const researchPrompt = `You are a hedge fund analyst researching ${ticker.toUpperCase()}.

Search for INVESTOR-FOCUSED content:
1. "${ticker.toUpperCase()} bull case bear case" — what are investors debating?
2. "${ticker.toUpperCase()} investment thesis" or "${ticker.toUpperCase()} stock thesis"
3. "${ticker.toUpperCase()} earnings call key takeaways" — what did management emphasize?
4. "${ticker.toUpperCase()} analyst report"

Find:
- The PRIMARY narrative driving this stock (not generic description)
- Key customers (with evidence)
- Direct competitors (for the main growth driver)
- Bull/bear debates investors actually have

Only include verified facts. Cite sources.`;

    // STEP 1c: Reddit sentiment search (separate search for retail investor views)
    const redditPrompt = `Search Reddit for discussions about ${ticker.toUpperCase()} stock.

Search these specific queries:
1. "site:reddit.com ${ticker.toUpperCase()} stock"
2. "site:reddit.com/r/wallstreetbets ${ticker.toUpperCase()}"
3. "site:reddit.com/r/stocks ${ticker.toUpperCase()}"
4. "site:reddit.com/r/investing ${ticker.toUpperCase()}"

Find and summarize:
- What are retail investors saying about this stock?
- What is the general sentiment (bullish/bearish/mixed)?
- What specific bull and bear arguments are retail investors making?
- Are there any popular posts or discussions about this stock?
- What price targets or expectations do retail investors have?

If you cannot find any Reddit discussions about this stock, say "NO_REDDIT_DATA".`;

    // Run research and Reddit search in parallel
    const [researchResponse, redditResponse] = await Promise.all([
      client.responses.create({
        model: 'gpt-4o',
        tools: [{ type: 'web_search' }],
        input: researchPrompt
      }),
      client.responses.create({
        model: 'gpt-4o',
        tools: [{ type: 'web_search' }],
        input: redditPrompt
      })
    ]);

    const research = researchResponse.output_text;
    const redditSentiment = redditResponse.output_text;

    // Wait for SEC data and earnings transcript
    const [secData, earningsData] = await Promise.all([secDataPromise, earningsPromise]);

    // Format SEC data for the prompt
    let secContext = '';
    if (secData) {
      secContext = `\n\n--- 10-K FILING DATA (${secData.fiscalYear}) ---\n`;
      secContext += `Company: ${secData.companyName}\n`;
      secContext += `Filed: ${secData.filedAt}\n\n`;

      for (const [sectionName, content] of Object.entries(secData.sections)) {
        if (content) {
          secContext += `**${sectionName}:**\n${content}\n\n`;
        }
      }
    }

    // Format earnings transcripts for the prompt
    let earningsContext = '';
    if (earningsData && earningsData.transcripts) {
      earningsContext = `\n\n--- EARNINGS CALL TRANSCRIPTS (Last ${earningsData.transcripts.length} Quarters) ---\n`;
      for (const t of earningsData.transcripts) {
        earningsContext += `\n**Q${t.quarter} ${t.year}:**\n${t.transcript}\n`;
      }
    }

    // STEP 2: Generate memo using Chat Completions API with template
    const firstDraftMessages = [
      {
        role: 'system',
        content: `You are a senior hedge fund analyst writing initiation memos. Your memos are dense, factual, and insight-rich. Every sentence should teach something.

BANNED PHRASES: "global technology leader", "cutting-edge", "well-positioned", "comprehensive portfolio", "digital transformation", or any generic phrase that could describe any company.

Write in narrative form with bold section headers (use ## for main sections, ### for sub-sections). Target 3000-5000 words.`
      },
      {
        role: 'user',
        content: `Write an initiation of coverage memo for ${ticker.toUpperCase()} following this EXACT template structure:

${MEMO_TEMPLATE}

---

Here is the research data to use:

**WEB RESEARCH:**
${research}

${secContext}

${earningsContext}

**REDDIT SENTIMENT DATA:**
${redditSentiment}

---

IMPORTANT INSTRUCTIONS:
1. Follow the template sections EXACTLY in order
2. Use ## for main section headers, ### for numbered sub-sections within Thesis Details (e.g., "### 1. Reason Title")
3. For "Investment Thesis" - write AGGRESSIVELY: short sentences, not verbose, straight to the point
4. For "Competitive Landscape" - give each competitor its own paragraph, and discuss new entrant threats
5. For "Key Debates" - look at the earnings Q&A to see what analysts are asking. Format each debate with ### headers:
   ### 1. [Question]
   **Bull Case:** 2-3 sentences
   **Bear Case:** 2-3 sentences
   (Use ### for each numbered debate question, NOT bold text)
6. For "Key Risks" - use the 10-K Risk Factors section as your primary source
7. For "Management Quality" - put the letter grade in the header. BE CRITICAL: A's are rare (top 10% CEOs only), B is good, C is average. Most CEOs should be B or C.
8. For "Retail Sentiment" - use the Reddit data above. USE THE FULL 1-10 RANGE: 5 is neutral, below 5 is bearish, above 5 is bullish. Don't default to 7+. If Reddit data says "NO_REDDIT_DATA", skip this section entirely.
9. For "Appendix: Key Earnings Call Q&A" - pull 3-5 direct quotes from the earnings transcripts showing important analyst questions and management answers. Skip if no transcript data.
10. **Bold the 1-2 most important sentences in each section** — just bold the sentence, no labels
11. Every sentence must convey concrete information - no filler
12. NO conclusion section
13. IMPORTANT: Target 3000-4000 words total. "History & Business Overview" should be 3-4 paragraphs. "Thesis Details" should be the longest section (40-50% of memo) with 4-5 detailed sub-sections.`
      }
    ];

    const firstDraft = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 8000,
      messages: firstDraftMessages
    });

    const report = firstDraft.choices[0].message.content;

    // Save to cache
    saveToCache(ticker, report);
    console.log(`Generated and cached new report for ${ticker.toUpperCase()}`);

    res.json({ report, cached: false, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// Chat endpoint for follow-up questions
app.post('/api/chat', async (req, res) => {
  const { ticker, question, report, chatHistory } = req.body;

  if (!ticker || !question || !report) {
    return res.status(400).json({ error: 'Ticker, question, and report are required' });
  }

  try {
    const messages = [
      {
        role: 'system',
        content: `You are a helpful equity research analyst assistant. You have access to the initiation of coverage report for ${ticker.toUpperCase()} below. Answer the user's questions based on this report and your knowledge. Be concise but thorough.

REPORT:
${report}

Guidelines:
- Answer based on the report content when possible
- If the question is about something not in the report, use your general knowledge but note that it's not from the report
- Keep answers focused and relevant
- If asked for opinions, base them on the facts in the report`
      }
    ];

    // Add chat history if provided
    if (chatHistory && chatHistory.length > 0) {
      for (const msg of chatHistory) {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    // Add current question
    messages.push({
      role: 'user',
      content: question
    });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: messages
    });

    const answer = response.choices[0].message.content;
    res.json({ answer });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process question' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
