require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const SEC_API_KEY = process.env.SEC_API_KEY;
const API_NINJAS_KEY = process.env.API_NINJAS_KEY;

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

  try {
    // Calculate last 4 quarters
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentQuarter = Math.ceil((now.getMonth() + 1) / 3);

    const quarters = [];
    let year = currentYear;
    let quarter = currentQuarter;

    for (let i = 0; i < 2; i++) {
      quarters.push({ year, quarter });
      quarter--;
      if (quarter === 0) {
        quarter = 4;
        year--;
      }
    }

    // Fetch all 4 quarters in parallel
    const transcriptPromises = quarters.map(async ({ year, quarter }) => {
      try {
        const response = await fetch(
          `https://api.api-ninjas.com/v1/earningstranscript?ticker=${ticker}&year=${year}&quarter=${quarter}`,
          {
            headers: { 'X-Api-Key': API_NINJAS_KEY }
          }
        );

        if (!response.ok) {
          return null;
        }

        const data = await response.json();
        if (!data || !data.transcript) {
          return null;
        }

        // Extract Q&A section only
        const qaSection = extractQASection(data.transcript);

        return {
          year: data.year,
          quarter: data.quarter,
          transcript: qaSection
        };
      } catch (err) {
        return null;
      }
    });

    const results = await Promise.all(transcriptPromises);
    const transcripts = results.filter(t => t !== null);

    if (transcripts.length === 0) {
      console.log(`No earnings transcripts found for ${ticker}`);
      return null;
    }

    const earningsData = {
      ticker: ticker.toUpperCase(),
      transcripts: transcripts
    };

    console.log(`Fetched ${transcripts.length} earnings transcripts for ${ticker}`);

    // Cache the data
    saveEarningsToCache(ticker, earningsData);

    return earningsData;
  } catch (error) {
    console.error('API Ninjas error:', error);
    return null;
  }
}

const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Reference memo as few-shot example
const REFERENCE_MEMO = `
**Broadcom (AVGO) — Initiation of Coverage**

**What Broadcom Does in AI**

Broadcom is the leading merchant partner for custom AI accelerators (ASICs) designed and deployed by hyperscalers. These chips are co-designed with customers to run specific training and inference workloads at scale, optimizing for power efficiency, cost per compute, and tight integration with data center infrastructure. Unlike GPUs, these ASICs eliminate excess programmability and scale economically once volumes reach hyperscale levels.

Broadcom co-designed Google's Tensor Processing Unit (TPU) starting with TPU v1 and continuing through multiple generations. This was the first large-scale, production deployment of custom AI silicon and remains the most mature non-GPU AI accelerator platform in operation. The TPU program established Broadcom as the default external partner for hyperscalers seeking to internalize AI compute.

Since Google, Broadcom has expanded this model across additional hyperscalers. Industry disclosures, supply-chain data, and customer behavior point to active custom AI silicon programs with Google, Meta, ByteDance, and Apple, among others. These engagements are multi-year and multi-generation. Once deployed, switching vendors requires re-architecting software stacks, retraining models, and redesigning data center infrastructure, creating very high switching costs.

Broadcom's role extends beyond logic design. It delivers full silicon platforms, including high-speed SerDes, advanced packaging, memory interfaces, power optimization, and co-optimized networking. This breadth reduces execution risk for customers and materially limits the number of viable competitors.

**Why Hyperscalers Are Moving to Custom AI Silicon**

At scale, AI workloads are dominated by a narrow set of operations. GPUs carry flexibility that hyperscalers do not fully utilize but still pay for in power consumption and unit cost. Custom ASICs can deliver materially better performance per watt and cost per inference once volumes justify development.

As AI moves from experimentation to persistent production workloads, these economics become decisive. Hyperscalers with sustained demand benefit from internal silicon roadmaps, while GPUs remain optimal for flexibility, smaller-scale deployments, and rapidly evolving workloads. Broadcom is the primary merchant enabler of this shift.

**Demand Visibility and Scale**

Broadcom serves a limited number of AI customers with long-term capacity commitments extending multiple years forward. Management has described AI demand as infrastructure build-out rather than cyclical spending, with visibility measured in tens of billions of dollars of backlog.

This level of forward visibility is rare in semiconductors and reflects the planning horizons associated with hyperscale data center construction and AI platform deployment. AI-related revenue is growing materially faster than the rest of Broadcom's semiconductor portfolio and represents a disproportionate share of incremental growth.

**Networking: The Binding Constraint in AI Scaling**

Broadcom is the dominant supplier of Ethernet switching silicon inside hyperscale data centers. Its switches connect AI accelerators across large clusters, enabling distributed training and inference at scale.

As clusters grow from thousands to tens of thousands of accelerators, networking becomes a primary constraint. Model parallelism and distributed workloads drive exponential increases in east-west traffic. Regardless of whether compute is powered by GPUs or custom ASICs, traffic flows through Broadcom networking silicon.

This gives Broadcom dual exposure: it benefits both from overall AI compute growth and from the shift toward internal accelerators.

**Competitive Positioning**

In custom AI silicon, Broadcom has very few credible peers.

Marvell is the most frequently cited alternative but is structurally weaker. Its AI business is overwhelmingly concentrated in a single customer: Amazon (AWS), supporting internal accelerators such as Trainium and Inferentia. AWS is a price-setter rather than a collaborative partner, resulting in lower-margin, narrower-scope engagements. Marvell lacks Broadcom's depth in end-to-end platforms, particularly across networking, advanced packaging, and system-level co-design. Its AI revenue remains highly customer-concentrated and more easily displaced.

MediaTek operates primarily in cost-optimized SoCs and consumer-scale silicon. While capable in integration and volume manufacturing, it lacks relevance in high-performance AI training and large-scale data center inference and does not meaningfully compete in hyperscale AI platforms or networking.

Beyond these names, competition thins rapidly. Sustaining custom AI silicon programs at hyperscale requires advanced process expertise, high-speed I/O, packaging, software co-design, and the balance sheet to support multi-generation commitments. Hyperscalers rarely dual-source early-stage AI ASICs, reinforcing concentration once a design enters production.

In networking, Broadcom remains the clear leader in high-end Ethernet switching for AI data centers. Ethernet's cost structure, ecosystem maturity, and software compatibility continue to favor Broadcom as clusters scale.

**Key Debates on the Stock**

1. Will Custom ASICs Meaningfully Displace GPUs?
The debate is not full displacement but incremental adoption. Even partial migration of hyperscale workloads represents very large dollar volumes. Broadcom does not need GPUs to lose relevance to win.

2. How Concentrated Is AI Revenue?
AI revenue is driven by a small number of hyperscalers. Bulls argue this increases visibility and switching costs. Bears worry about negotiating leverage. In practice, internal silicon programs tend to persist once deployed.

3. Does Networking Growth Fully Offset Compute Volatility?
AI networking demand scales with cluster size, not accelerator vendor. As long as AI compute grows, Broadcom's networking exposure provides a stabilizing second engine.

4. Is VMware a Distraction or a Stabilizer?
VMware is not an AI driver. It matters for valuation and cash flow stability, but the AI thesis stands independently.

5. Is Broadcom Fully Priced?
Broadcom lacks the headline visibility of GPU-centric AI names. The debate is whether the durability and visibility of its AI revenue are fully reflected in expectations.
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
4. "reddit ${ticker.toUpperCase()} stock" — what are investors saying?
5. "${ticker.toUpperCase()} analyst report"

Find:
- The PRIMARY narrative driving this stock (not generic description)
- Key customers (with evidence)
- Direct competitors (for the main growth driver)
- Bull/bear debates investors actually have

Only include verified facts. Cite sources.`;

    const researchResponse = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: researchPrompt
    });

    const research = researchResponse.output_text;

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

    // STEP 2: Generate first draft using Chat Completions API with few-shot example
    const firstDraftMessages = [
      {
        role: 'system',
        content: `You are a senior hedge fund analyst writing initiation memos. Your memos are dense, factual, and insight-rich. Every sentence should teach something.

BANNED PHRASES: "global technology leader", "cutting-edge", "well-positioned", "comprehensive portfolio", "digital transformation", or any generic phrase that could describe any company.

Write in narrative form with bold section headers. Target 3000-5000 words.`
      },
      {
        role: 'user',
        content: `Here is an example of an excellent initiation memo. Study its style, density, and structure:

${REFERENCE_MEMO}

---

Now write a similar quality memo for ${ticker.toUpperCase()}.

Here is research on ${ticker.toUpperCase()}:
${research}
${secContext}
${earningsContext}

Requirements:
- Match the density and style of the example memo above
- Bold section headers
- Lead with the core thesis (what actually matters for the stock)
- Name specific customers, competitors, and products
- Every sentence must convey concrete information
- No filler, no generic language
- NO conclusion section
- 3000-5000 words
- **Bold the 1-2 most important sentences in each section** — just bold the sentence itself, do NOT add labels like "Key Insight:" or "Important:" before it

KEY DEBATES SECTION (required format):
Include a "**Key Debates on the Stock**" section with 4-5 numbered debates. For each debate:
1. State the question clearly
2. **Bull Case:** 2-3 sentences
3. **Bear Case:** 2-3 sentences

Example format:
**1. Will Custom ASICs Meaningfully Displace GPUs?**
**Bull Case:** Even partial migration of hyperscale workloads represents large dollar volumes. Broadcom doesn't need GPUs to lose relevance to win.
**Bear Case:** GPU flexibility remains valuable for rapidly evolving AI workloads. Custom ASICs lock customers into specific architectures.`
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

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
