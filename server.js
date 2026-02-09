require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const cron = require('node-cron');

// JWT secret - in production, use environment variable
const JWT_SECRET = process.env.JWT_SECRET || 'retailbbg-jwt-secret-key-2024';

const SEC_API_KEY = process.env.SEC_API_KEY;
const EARNINGSCALL_API_KEY = process.env.EARNINGSCALL_API_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// Initialize Google OAuth client
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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

function saveToCache(ticker, report, html) {
  const cachePath = getCachePath(ticker);
  const cacheData = {
    ticker: ticker.toUpperCase(),
    report,
    html,
    timestamp: Date.now(),
    generatedAt: new Date().toISOString()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
  } catch (error) {
    console.error('Error writing cache:', error);
  }
}

// Delay helper for rate limiting API calls
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================
// TOKEN USAGE LOGGING
// ============================================
const TOKEN_USAGE_LOG_PATH = path.join(CACHE_DIR, 'token-usage.json');

function logTokenUsage(endpoint, usage, model = 'gpt-4o') {
  try {
    // Read existing log
    let logData = { entries: [] };
    if (fs.existsSync(TOKEN_USAGE_LOG_PATH)) {
      try {
        logData = JSON.parse(fs.readFileSync(TOKEN_USAGE_LOG_PATH, 'utf8'));
      } catch (err) {
        console.error('Error parsing token usage log, starting fresh:', err.message);
        logData = { entries: [] };
      }
    }

    // Add new entry
    const entry = {
      timestamp: new Date().toISOString(),
      endpoint,
      promptTokens: usage?.prompt_tokens || usage?.input_tokens || 0,
      completionTokens: usage?.completion_tokens || usage?.output_tokens || 0,
      totalTokens: usage?.total_tokens || ((usage?.prompt_tokens || usage?.input_tokens || 0) + (usage?.completion_tokens || usage?.output_tokens || 0)),
      model
    };
    logData.entries.push(entry);

    // Keep only last 7 days of data
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    logData.entries = logData.entries.filter(e => new Date(e.timestamp) >= sevenDaysAgo);

    // Save updated log
    fs.writeFileSync(TOKEN_USAGE_LOG_PATH, JSON.stringify(logData, null, 2));
    console.log(`[Token Log] ${endpoint}: ${entry.totalTokens} tokens (${entry.promptTokens} prompt, ${entry.completionTokens} completion)`);
  } catch (error) {
    console.error('Error logging token usage:', error.message);
  }
}

// ============================================
// COMPANY DESCRIPTIONS CACHE (Permanent)
// ============================================
const COMPANY_DESCRIPTIONS_PATH = path.join(CACHE_DIR, 'company-descriptions.json');

function getCompanyDescriptions() {
  try {
    if (fs.existsSync(COMPANY_DESCRIPTIONS_PATH)) {
      return JSON.parse(fs.readFileSync(COMPANY_DESCRIPTIONS_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading company descriptions:', err.message);
  }
  return {};
}

function saveCompanyDescription(ticker, description) {
  try {
    const descriptions = getCompanyDescriptions();
    descriptions[ticker.toUpperCase()] = {
      description,
      generatedAt: new Date().toISOString()
    };
    fs.writeFileSync(COMPANY_DESCRIPTIONS_PATH, JSON.stringify(descriptions, null, 2));
    console.log(`[Company Desc] Saved description for ${ticker}`);
  } catch (err) {
    console.error('Error saving company description:', err.message);
  }
}

function getCompanyDescription(ticker) {
  const descriptions = getCompanyDescriptions();
  return descriptions[ticker.toUpperCase()]?.description || null;
}

async function generateCompanyDescription(ticker, companyName) {
  const name = companyName || COMPANY_NAMES[ticker] || ticker;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Write ONE sentence (15-20 words) describing what ${name} does as a company. Be factual and concise. Example: "Nvidia designs GPUs for gaming, AI training, and data center acceleration." Just the sentence, no quotes.`
      }]
    });
    logTokenUsage('company-descriptions', response.usage, 'gpt-4o-mini');

    let description = response.choices[0].message.content.trim();
    description = description.replace(/^["']|["']$/g, '').trim();

    // Cache permanently
    saveCompanyDescription(ticker, description);

    return description;
  } catch (err) {
    console.error(`Error generating description for ${ticker}:`, err.message);
    return `${name} is a publicly traded company.`;
  }
}

async function getOrGenerateCompanyDescription(ticker, companyName) {
  // Check cache first
  const cached = getCompanyDescription(ticker);
  if (cached) {
    return cached;
  }
  // Generate and cache
  return await generateCompanyDescription(ticker, companyName);
}

// ============================================
// FINNHUB NEWS API
// ============================================
async function getFinnhubNews(ticker) {
  if (!FINNHUB_API_KEY) {
    console.log('[Finnhub] No API key configured');
    return null;
  }

  try {
    // Get news from last 3 days
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 3);

    const fromStr = from.toISOString().split('T')[0];
    const toStr = to.toISOString().split('T')[0];

    const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromStr}&to=${toStr}&token=${FINNHUB_API_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[Finnhub] Error fetching news for ${ticker}: ${response.status}`);
      return null;
    }

    const news = await response.json();

    // Return top 5 headlines
    if (news && news.length > 0) {
      const headlines = news.slice(0, 5).map(item => item.headline).join('\n');
      console.log(`[Finnhub] Found ${Math.min(news.length, 5)} headlines for ${ticker}`);
      return headlines;
    }

    console.log(`[Finnhub] No news found for ${ticker}`);
    return null;
  } catch (err) {
    console.error(`[Finnhub] Error fetching news for ${ticker}:`, err.message);
    return null;
  }
}

// CEO data lookup (from Claude's training knowledge)
const CEO_DATA_PATH = path.join(__dirname, 'ceo-data.json');

function getCeoData(ticker) {
  try {
    if (!fs.existsSync(CEO_DATA_PATH)) {
      return null;
    }
    const ceoData = JSON.parse(fs.readFileSync(CEO_DATA_PATH, 'utf8'));
    const tickerUpper = ticker.toUpperCase();
    if (ceoData[tickerUpper]) {
      console.log(`Found CEO data for ${tickerUpper}: ${ceoData[tickerUpper].ceo}`);
      return ceoData[tickerUpper];
    }
    return null;
  } catch (error) {
    console.error('Error reading CEO data:', error);
    return null;
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

  const MAX_QA_LENGTH = 20000;

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
    console.log(`No Q&A marker found, using last ${MAX_QA_LENGTH} chars`);
    return transcript.slice(-MAX_QA_LENGTH);
  }

  // Extract Q&A section and truncate to max length
  const qaSection = transcript.substring(qaStart);
  console.log(`Found Q&A section starting with: "${markerUsed}" (${qaSection.length} chars, truncating to ${MAX_QA_LENGTH})`);
  return qaSection.slice(0, MAX_QA_LENGTH);
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

// Web search cache (for company research)
const WEBSEARCH_CACHE_DIR = path.join(__dirname, 'cache', 'websearch');
const WEBSEARCH_CACHE_MAX_AGE_DAYS = 7; // Cache for 7 days

if (!fs.existsSync(WEBSEARCH_CACHE_DIR)) {
  fs.mkdirSync(WEBSEARCH_CACHE_DIR, { recursive: true });
}

function getWebSearchCachePath(ticker) {
  return path.join(WEBSEARCH_CACHE_DIR, `${ticker.toUpperCase()}_research.json`);
}

function getCachedWebSearch(ticker) {
  const cachePath = getWebSearchCachePath(ticker);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= WEBSEARCH_CACHE_MAX_AGE_DAYS) {
      console.log(`Using cached web search for ${ticker} (cached ${ageDays.toFixed(1)} days ago)`);
      return cached.data;
    }
    return null; // Cache expired
  } catch (error) {
    console.error('Error reading web search cache:', error);
    return null;
  }
}

function saveWebSearchToCache(ticker, data) {
  const cachePath = getWebSearchCachePath(ticker);
  const cacheData = {
    ticker: ticker.toUpperCase(),
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log(`Cached web search for ${ticker}`);
  } catch (error) {
    console.error('Error writing web search cache:', error);
  }
}

// Alpha Vantage cache (30 days - financials don't change often)
const ALPHAVANTAGE_CACHE_DIR = path.join(__dirname, 'cache', 'alphavantage');
const ALPHAVANTAGE_CACHE_MAX_AGE_DAYS = 30;

if (!fs.existsSync(ALPHAVANTAGE_CACHE_DIR)) {
  fs.mkdirSync(ALPHAVANTAGE_CACHE_DIR, { recursive: true });
}

function getAlphaVantageCachePath(ticker) {
  return path.join(ALPHAVANTAGE_CACHE_DIR, `${ticker.toUpperCase()}_financials.json`);
}

function getCachedAlphaVantage(ticker) {
  const cachePath = getAlphaVantageCachePath(ticker);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= ALPHAVANTAGE_CACHE_MAX_AGE_DAYS) {
      console.log(`Using cached Alpha Vantage data for ${ticker} (cached ${ageDays.toFixed(1)} days ago)`);
      return cached.data;
    }
    return null;
  } catch (error) {
    console.error('Error reading Alpha Vantage cache:', error);
    return null;
  }
}

function saveAlphaVantageToCache(ticker, data) {
  const cachePath = getAlphaVantageCachePath(ticker);
  const cacheData = {
    ticker: ticker.toUpperCase(),
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log(`Cached Alpha Vantage data for ${ticker}`);
  } catch (error) {
    console.error('Error writing Alpha Vantage cache:', error);
  }
}

async function fetchAlphaVantageFinancials(ticker) {
  // Check cache first
  const cached = getCachedAlphaVantage(ticker);
  if (cached) {
    return cached;
  }

  if (!ALPHA_VANTAGE_API_KEY) {
    console.log('No Alpha Vantage API key configured');
    return null;
  }

  try {
    const url = `https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=${ticker.toUpperCase()}&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.annualReports || data.annualReports.length === 0) {
      console.log(`No Alpha Vantage data for ${ticker}`);
      return null;
    }

    // Get last 5 years of data
    const rawReports = data.annualReports.slice(0, 5).map(report => {
      const revenue = parseFloat(report.totalRevenue) || 0;
      const grossProfit = parseFloat(report.grossProfit) || 0;
      const ebitda = parseFloat(report.ebitda) || 0;
      const netIncome = parseFloat(report.netIncome) || 0;

      return {
        fiscalYear: report.fiscalDateEnding.substring(0, 4),
        revenue,
        grossProfit,
        grossMargin: revenue > 0 ? (grossProfit / revenue * 100).toFixed(1) : 'N/A',
        ebitda,
        ebitdaMargin: revenue > 0 ? (ebitda / revenue * 100).toFixed(1) : 'N/A',
        netIncome,
        netMargin: revenue > 0 ? (netIncome / revenue * 100).toFixed(1) : 'N/A'
      };
    });

    // Calculate YoY growth (need to compare with previous year)
    const reports = rawReports.map((report, index) => {
      const prevReport = rawReports[index + 1]; // Previous year is next in array (sorted newest first)
      let yoyGrowth = 'N/A';
      if (prevReport && prevReport.revenue > 0) {
        yoyGrowth = ((report.revenue - prevReport.revenue) / prevReport.revenue * 100).toFixed(1);
      }
      return { ...report, yoyGrowth };
    });

    // Cache the results
    saveAlphaVantageToCache(ticker, reports);

    console.log(`Fetched Alpha Vantage financials for ${ticker}`);
    return reports;
  } catch (error) {
    console.error('Error fetching Alpha Vantage data:', error);
    return null;
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

// Redirect root to Market Update (new home page)
app.get('/', (req, res) => {
  res.redirect('/market.html');
});

// Clean URLs for earnings reviews: /pltr-earnings, /aapl-earnings, etc.
app.get('/:tickerEarnings', (req, res, next) => {
  const param = req.params.tickerEarnings.toLowerCase();
  if (param.endsWith('-earnings')) {
    // Serve earnings.html - client will read ticker from URL
    res.sendFile(path.join(__dirname, 'public', 'earnings.html'));
  } else {
    next();
  }
});

// Clean URLs for initiation reports: /tsla, /aapl, etc.
app.get('/:ticker', (req, res, next) => {
  const ticker = req.params.ticker.toUpperCase();
  // Skip if it looks like a file request or known route
  if (ticker.includes('.') || ['API', 'MARKET', 'PORTFOLIO', 'THEMATIC', 'EARNINGS', 'IDEAGENERATION', 'WATCHLIST', 'TOP-MOVERS'].includes(ticker)) {
    return next();
  }
  // Serve index.html - client will read ticker from URL
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Thematic/Idea Generation routing - serve thematic.html for clean URLs
app.get('/ideageneration', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'thematic.html'));
});

app.get('/thematic', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'thematic.html'));
});

app.get('/thematic/:theme', (req, res, next) => {
  const theme = req.params.theme.toLowerCase();
  // Skip if it looks like a file request
  if (theme.includes('.')) {
    return next();
  }
  // Serve thematic.html - client will read theme from URL
  res.sendFile(path.join(__dirname, 'public', 'thematic.html'));
});

app.get('/top-movers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

app.get('/portfolio', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watchlist.html'));
});

app.use(express.static('public'));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Memo template with section instructions
// Convert markdown report to styled HTML
function convertReportToHTML(markdown, ticker, realStockPrice = null) {
  // Company name lookup (short names for header)
  const companyNames = {
    'AAPL': 'Apple',
    'MSFT': 'Microsoft',
    'GOOGL': 'Alphabet',
    'GOOG': 'Alphabet',
    'AMZN': 'Amazon',
    'NVDA': 'NVIDIA',
    'META': 'Meta',
    'TSLA': 'Tesla',
    'AVGO': 'Broadcom',
    'JPM': 'JPMorgan',
    'V': 'Visa',
    'UNH': 'UnitedHealth',
    'HD': 'Home Depot',
    'MA': 'Mastercard',
    'PG': 'Procter & Gamble',
    'JNJ': 'Johnson & Johnson',
    'COST': 'Costco',
    'ABBV': 'AbbVie',
    'MRK': 'Merck',
    'CRM': 'Salesforce',
    'AMD': 'AMD',
    'NFLX': 'Netflix',
    'ADBE': 'Adobe',
    'PEP': 'PepsiCo',
    'KO': 'Coca-Cola',
    'TMO': 'Thermo Fisher',
    'INTC': 'Intel',
    'CSCO': 'Cisco',
    'DIS': 'Disney',
    'VZ': 'Verizon',
    'CMCSA': 'Comcast',
    'PFE': 'Pfizer',
    'WMT': 'Walmart',
    'NKE': 'Nike',
    'T': 'AT&T',
    'BA': 'Boeing',
    'CAT': 'Caterpillar',
    'GS': 'Goldman Sachs',
    'IBM': 'IBM',
    'MMM': '3M',
    'MCD': "McDonald's",
    'QCOM': 'Qualcomm',
    'TXN': 'Texas Instruments',
    'UBER': 'Uber',
    'PYPL': 'PayPal',
    'SQ': 'Block',
    'SHOP': 'Shopify',
    'ZM': 'Zoom',
    'ABNB': 'Airbnb',
    'COIN': 'Coinbase',
    'SNOW': 'Snowflake',
    'PLTR': 'Palantir',
    'RIVN': 'Rivian',
    'LCID': 'Lucid',
    'SMTC': 'Semtech',
    'MTSI': 'MACOM',
  };

  // If not in lookup, try to extract short name from Yahoo Finance data or use ticker
  let companyName = companyNames[ticker] || ticker;

  // Sector lookup
  const sectors = {
    'AAPL': 'Consumer Electronics',
    'MSFT': 'Software',
    'GOOGL': 'Internet Services',
    'GOOG': 'Internet Services',
    'AMZN': 'E-Commerce',
    'NVDA': 'Semiconductors',
    'META': 'Social Media',
    'TSLA': 'Electric Vehicles',
    'AVGO': 'Semiconductors',
    'JPM': 'Banking',
    'V': 'Financial Services',
    'AMD': 'Semiconductors',
    'NFLX': 'Streaming',
    'ADBE': 'Software',
    'CRM': 'Software',
    'INTC': 'Semiconductors',
    'CSCO': 'Networking',
    'QCOM': 'Semiconductors',
    'TXN': 'Semiconductors',
  };
  const sector = sectors[ticker] || 'Technology';

  // Exchange lookup (simplified - most large caps are NASDAQ or NYSE)
  const nyseStocks = ['JPM', 'V', 'UNH', 'HD', 'MA', 'PG', 'JNJ', 'MRK', 'PEP', 'KO', 'DIS', 'VZ', 'PFE', 'WMT', 'NKE', 'BA', 'CAT', 'GS', 'IBM', 'MMM', 'MCD'];
  const exchange = nyseStocks.includes(ticker) ? 'NYSE' : 'NASDAQ';

  // Extract price and price target
  let price = '';
  const priceMatch = markdown.match(/trading at \$?([\d,.]+)/i) ||
                     markdown.match(/\$(\d+(?:\.\d+)?)\s*(?:per share)?/i);
  if (priceMatch) {
    let priceNum = parseFloat(priceMatch[1].replace(/,/g, ''));
    // Round to nearest $1 if above $10, or $0.1 if below $10
    if (priceNum >= 10) {
      priceNum = Math.round(priceNum);
    } else {
      priceNum = Math.round(priceNum * 10) / 10;
    }
    price = '$' + priceNum;
  }

  let priceTarget = '';
  const ptMatch = markdown.match(/price target[:\s]+\$?([\d,.]+)/i) ||
                  markdown.match(/PT[:\s]+\$?([\d,.]+)/i);
  if (ptMatch) {
    let ptNum = parseFloat(ptMatch[1].replace(/,/g, '').replace(/\.$/, ''));
    // Round to nearest $1 if above $10, or $0.1 if below $10
    if (ptNum >= 10) {
      ptNum = Math.round(ptNum);
    } else {
      ptNum = Math.round(ptNum * 10) / 10;
    }
    priceTarget = '$' + ptNum;
  }

  // Start building HTML
  let html = `
    <div class="report-header">
      <div class="header-left">
        <div class="report-type">Initiation of Coverage</div>
        <div class="company-name">${companyName}</div>
        <div class="ticker-info">${exchange}: ${ticker} · ${sector}</div>
      </div>
    </div>
  `;

  // Process the markdown content
  let content = markdown;

  // Remove any title headers
  content = content.replace(/^#\s+.+$/gm, '');

  // Extract and format Investment Thesis section specially
  const thesisMatch = content.match(/##\s*Investment Thesis\s*\n([\s\S]*?)(?=\n##\s|\n###\s|$)/i);
  if (thesisMatch) {
    let thesisText = thesisMatch[1].trim()
      // Remove price mentions like "Trading at $XXX" or "Current price: $XXX"
      .replace(/trading at \$[\d,.]+\.?\s*/gi, '')
      .replace(/current price[:\s]+\$?[\d,.]+\.?\s*/gi, '')
      .replace(/price[:\s]+\$[\d,.]+\.?\s*/gi, '')
      // Remove price target mentions like "Price target: $XXX" or "PT: $XXX"
      .replace(/price target[:\s]+\$?[\d,.]+\.?\s*/gi, '')
      .replace(/PT[:\s]+\$?[\d,.]+\.?\s*/gi, '')
      .replace(/target[:\s]+\$[\d,.]+\.?\s*/gi, '')
      // Remove standalone dollar amounts followed by period
      .replace(/\$[\d,.]+\.\s+/g, '')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, ' ')
      .replace(/\n/g, ' ')
      // Clean up any double spaces
      .replace(/\s+/g, ' ')
      .trim();
    html += `
    <div class="thesis-box">
      <div class="thesis-header">
        <div class="thesis-icon">!</div>
        <div class="thesis-label">Investment Thesis</div>
      </div>
      <div class="thesis-text">${thesisText}</div>
    </div>
    `;
    content = content.replace(/##\s*Investment Thesis\s*\n[\s\S]*?(?=\n##\s|\n###\s|$)/i, '');
  }

  // Helper function to process Key Insight callouts within text
  function processInsights(text) {
    // Match **Key Insight:** or Key Insight: patterns
    const insightRegex = /\*?\*?Key Insight:\*?\*?\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/gi;
    return text.replace(insightRegex, (match, insightText) => {
      return `<div class="insight-box"><div class="insight-label">Key Insight</div><div class="insight-text">${insightText.trim()}</div></div>`;
    });
  }

  // Helper function to convert markdown tables to HTML (Goldman Sachs style)
  function convertTable(tableText) {
    const lines = tableText.trim().split('\n');
    if (lines.length < 2) return tableText;

    let tableHtml = '<div class="table-container">';
    tableHtml += '<div class="table-title">Financial Summary</div>';
    tableHtml += '<table class="data-table">';

    // Header row
    const headers = lines[0].split('|').map(h => h.trim()).filter(h => h);
    tableHtml += '<thead><tr>';
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      // Mark estimate columns (contain 'E' like FY2026E)
      const isEstimate = /E$/i.test(header) || header.toLowerCase().includes('est');
      tableHtml += `<th${isEstimate ? ' class="estimate"' : ''}>${header}</th>`;
    }
    tableHtml += '</tr></thead>';

    // Find which columns are estimates
    const estimateCols = headers.map((h, i) => i > 0 && (/E$/i.test(h) || h.toLowerCase().includes('est')));

    // Skip separator line (line 1 with dashes)
    // Data rows
    tableHtml += '<tbody>';
    for (let i = 2; i < lines.length; i++) {
      const cells = lines[i].split('|').map(c => c.trim()).filter(c => c);
      if (cells.length > 0) {
        const metricName = cells[0].toLowerCase();
        const isMarginOrGrowth = metricName.includes('margin') || metricName.includes('growth') || metricName.includes('yoy');

        tableHtml += `<tr${isMarginOrGrowth ? ' class="margin-row"' : ''}>`;
        for (let j = 0; j < cells.length; j++) {
          let cellValue = cells[j];
          let classes = [];

          if (j === 0) {
            // First column (metric name)
            if (isMarginOrGrowth) {
              classes.push('metric-indent');
            }
          } else {
            // Data columns
            // Check if negative (has minus sign or parentheses)
            const isNegative = /^-|^\(|^-?\$.*-|^-?\d+.*-/.test(cellValue) || /\(-?\d/.test(cellValue);
            // Check if positive growth
            const isPositiveGrowth = isMarginOrGrowth && /^\+?\d+\.?\d*%$/.test(cellValue) && !isNegative;

            if (isNegative) {
              classes.push('negative');
              // Format with parentheses if not already
              if (cellValue.startsWith('-') && !cellValue.includes('(')) {
                cellValue = '(' + cellValue.substring(1) + ')';
              }
            } else if (isPositiveGrowth) {
              classes.push('positive');
              if (!cellValue.startsWith('+')) {
                cellValue = '+' + cellValue;
              }
            }

            // Mark estimate columns
            if (estimateCols[j]) {
              classes.push('estimate-col');
            }
          }

          tableHtml += `<td${classes.length ? ' class="' + classes.join(' ') + '"' : ''}>${cellValue}</td>`;
        }
        tableHtml += '</tr>';
      }
    }
    tableHtml += '</tbody>';

    tableHtml += '<tfoot><tr><td colspan="' + headers.length + '">Source: Company filings, Alpha Vantage. E = Consensus estimates.</td></tr></tfoot>';
    tableHtml += '</table></div>';
    return tableHtml;
  }

  // Process sections
  const sections = content.split(/(?=^##\s)/m);

  for (const section of sections) {
    if (!section.trim()) continue;

    // Main section header
    const sectionMatch = section.match(/^##\s+(.+?)$/m);
    if (sectionMatch) {
      const sectionTitle = sectionMatch[1].trim();
      let sectionContent = section.replace(/^##\s+.+$/m, '').trim();

      // Check if this is Key Risks section
      if (sectionTitle.toLowerCase().includes('key risks')) {
        html += `<h2>${sectionTitle}</h2>`;
        // Convert risk items to risk boxes
        const riskItems = sectionContent.split(/(?=\*\*\d+\.|(?<=\n)\d+\.)/);
        for (const item of riskItems) {
          const riskMatch = item.match(/\*?\*?(\d+\.)?\s*([^:*]+?)[:*]\*?\*?\s*([\s\S]*)/);
          if (riskMatch && riskMatch[2]) {
            const riskTitle = riskMatch[2].trim().replace(/\*\*/g, '');
            const riskDesc = riskMatch[3].trim().replace(/\*\*/g, '').replace(/\n/g, ' ');
            html += `<div class="risk-box"><strong>${riskTitle}</strong><p>${riskDesc}</p></div>`;
          } else if (item.trim()) {
            html += `<p>${item.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
          }
        }
        continue;
      }

      // Check if this is Key Debates section
      if (sectionTitle.toLowerCase().includes('key debates')) {
        html += `<h2>${sectionTitle}</h2>`;
        const debates = sectionContent.split(/(?=###\s*\d+\.)/);
        for (const debate of debates) {
          const debateMatch = debate.match(/###\s*(\d+)\.\s*(.+?)\n/);
          if (debateMatch) {
            const question = debateMatch[2].trim();
            let debateContent = debate.replace(/###\s*\d+\.\s*.+?\n/, '');

            const bullMatch = debateContent.match(/\*\*Bull Case:\*\*\s*([\s\S]*?)(?=\*\*Bear Case|\n\n|$)/i);
            const bearMatch = debateContent.match(/\*\*Bear Case:\*\*\s*([\s\S]*?)(?=\n\n|$)/i);

            html += `<div class="debate-box">`;
            html += `<div class="debate-question">${debateMatch[1]}. ${question}</div>`;
            if (bullMatch) html += `<p class="bull-case"><strong>Bull Case:</strong> ${bullMatch[1].trim()}</p>`;
            if (bearMatch) html += `<p class="bear-case"><strong>Bear Case:</strong> ${bearMatch[1].trim()}</p>`;
            html += `</div>`;
          }
        }
        continue;
      }

      // Check if this is Key Customers section
      if (sectionTitle.toLowerCase().includes('key customers') || sectionTitle.toLowerCase().includes('customers & partnerships')) {
        html += `<h2>${sectionTitle}</h2>`;
        // Convert customer items to customer boxes - try ### headers first, then **bold** format
        const headerPattern = /###\s*(\d+)\.\s*(.+?)\n([\s\S]*?)(?=###\s*\d+\.|$)/g;
        let headerMatch;
        let hasCustomerBoxes = false;

        while ((headerMatch = headerPattern.exec(sectionContent)) !== null) {
          const customerNum = headerMatch[1];
          const customerName = headerMatch[2].trim();
          const customerDesc = headerMatch[3].trim().replace(/\n/g, ' ');
          html += `<div class="customer-box"><strong>${customerNum}. ${customerName}</strong><p>${customerDesc}</p></div>`;
          hasCustomerBoxes = true;
        }

        // Fallback to **1. Name** format
        if (!hasCustomerBoxes) {
          const boldPattern = /\*\*(\d+)\.\s*([^*]+)\*\*\s*\n?([\s\S]*?)(?=\*\*\d+\.|$)/g;
          let boldMatch;
          while ((boldMatch = boldPattern.exec(sectionContent)) !== null) {
            const customerNum = boldMatch[1];
            const customerName = boldMatch[2].trim();
            const customerDesc = boldMatch[3].trim().replace(/\n/g, ' ');
            if (customerName.length > 1) { // Ensure we got a real name
              html += `<div class="customer-box"><strong>${customerNum}. ${customerName}</strong><p>${customerDesc}</p></div>`;
              hasCustomerBoxes = true;
            }
          }
        }

        if (!hasCustomerBoxes) {
          html += `<p>${sectionContent.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
        }
        continue;
      }

      // Check if this is Competitive Landscape/Positioning section
      if (sectionTitle.toLowerCase().includes('competitive') || sectionTitle.toLowerCase().includes('competition')) {
        html += `<h2>${sectionTitle}</h2>`;
        let hasCompetitorBoxes = false;

        // Try **1. Competitor Name** format (same as customers)
        const boldPattern = /\*\*(\d+)\.\s*([^*]+)\*\*\s*\n?([\s\S]*?)(?=\*\*\d+\.|$)/g;
        let boldMatch;
        while ((boldMatch = boldPattern.exec(sectionContent)) !== null) {
          const competitorNum = boldMatch[1];
          const competitorName = boldMatch[2].trim();
          const competitorDesc = boldMatch[3].trim().replace(/\n/g, ' ');
          if (competitorName.length > 1) { // Ensure we got a real name
            html += `<div class="competitor-box"><strong>${competitorNum}. ${competitorName}</strong><p>${competitorDesc}</p></div>`;
            hasCompetitorBoxes = true;
          }
        }

        // Fallback to ### headers
        if (!hasCompetitorBoxes) {
          const headerPattern = /###\s*(\d+)\.\s*(.+?)\n([\s\S]*?)(?=###\s*\d+\.|$)/g;
          let headerMatch;
          while ((headerMatch = headerPattern.exec(sectionContent)) !== null) {
            const competitorNum = headerMatch[1];
            const competitorName = headerMatch[2].trim();
            const competitorDesc = headerMatch[3].trim().replace(/\n/g, ' ');
            html += `<div class="competitor-box"><strong>${competitorNum}. ${competitorName}</strong><p>${competitorDesc}</p></div>`;
            hasCompetitorBoxes = true;
          }
        }

        if (!hasCompetitorBoxes) {
          html += `<p>${sectionContent.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
        }
        continue;
      }

      // Check if this is Valuation section
      if (sectionTitle.toLowerCase() === 'valuation') {
        html += `<h2>${sectionTitle}</h2>`;

        // Look for Price Target summary box
        const ptSummaryMatch = sectionContent.match(/\*\*Price Target:\s*\$?([\d,.]+)[^*]*\*\*\s*([^\n]*(?:\n(?!\n)[^\n]*)*)?/i);
        let remainingContent = sectionContent;

        if (ptSummaryMatch) {
          // Extract content before the price target summary
          const beforePT = sectionContent.substring(0, ptSummaryMatch.index).trim();
          const afterPT = sectionContent.substring(ptSummaryMatch.index + ptSummaryMatch[0].length).trim();

          // Process paragraphs before PT summary
          if (beforePT) {
            const paragraphs = beforePT.split(/\n\n+/);
            for (const p of paragraphs) {
              if (p.trim()) {
                html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
              }
            }
          }

          // Add valuation summary box
          const ptValue = ptSummaryMatch[0].match(/\*\*([^*]+)\*\*/)[1];
          const ptExplanation = ptSummaryMatch[2] ? ptSummaryMatch[2].trim() : '';
          html += `<div class="valuation-summary"><strong>${ptValue}</strong>`;
          if (ptExplanation) {
            html += `<p style="margin-top: 8px;">${ptExplanation}</p>`;
          }
          html += `</div>`;

          // Process paragraphs after PT summary
          if (afterPT) {
            const paragraphs = afterPT.split(/\n\n+/);
            for (const p of paragraphs) {
              if (p.trim()) {
                html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
              }
            }
          }
        } else {
          // No PT summary found, process normally
          const paragraphs = sectionContent.split(/\n\n+/);
          for (const p of paragraphs) {
            if (p.trim()) {
              html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
            }
          }
        }
        continue;
      }

      // Check if this is Financial Analysis section (may contain tables)
      if (sectionTitle.toLowerCase().includes('financial')) {
        html += `<h2>${sectionTitle}</h2>`;

        // Look for markdown tables - more flexible regex
        const tableMatch = sectionContent.match(/\|.+\|[\r\n]+\|[-:\s|]+\|[\r\n]+((?:\|.+\|[\r\n]*)+)/);
        if (tableMatch) {
          const tableStart = sectionContent.indexOf(tableMatch[0]);
          const beforeTable = sectionContent.substring(0, tableStart).trim();
          const afterTable = sectionContent.substring(tableStart + tableMatch[0].length).trim();

          // Process content before table
          if (beforeTable) {
            const paragraphs = beforeTable.split(/\n\n+/);
            for (const p of paragraphs) {
              if (p.trim()) {
                html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
              }
            }
          }

          // Convert and add table
          html += convertTable(tableMatch[0]);

          // Process content after table
          if (afterTable) {
            const paragraphs = afterTable.split(/\n\n+/);
            for (const p of paragraphs) {
              if (p.trim()) {
                html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
              }
            }
          }
        } else {
          // No table found, try to create one from structured data
          // Look for lines that look like financial data
          const lines = sectionContent.split('\n');
          let hasStructuredData = false;
          let tableData = [];

          for (const line of lines) {
            // Check for lines with metrics and numbers
            const metricMatch = line.match(/^[-•*]?\s*(.+?):\s*([\$\d%.,BMK\s]+.*)$/);
            if (metricMatch) {
              tableData.push({ metric: metricMatch[1].trim(), values: metricMatch[2].trim() });
              hasStructuredData = true;
            }
          }

          if (hasStructuredData && tableData.length >= 3) {
            html += '<table class="data-table"><tr><th>Metric</th><th>Value</th></tr>';
            for (const row of tableData) {
              html += `<tr><td>${row.metric}</td><td class="number">${row.values}</td></tr>`;
            }
            html += '</table>';
          } else {
            // Fallback: process as regular paragraphs
            const paragraphs = sectionContent.split(/\n\n+/);
            for (const p of paragraphs) {
              if (p.trim()) {
                html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
              }
            }
          }
        }
        continue;
      }

      // Check if this is Appendix section with Q&A
      if (sectionTitle.toLowerCase().includes('appendix') || sectionTitle.toLowerCase().includes('earnings call q&a')) {
        html += `<h2>${sectionTitle}</h2>`;
        // Look for Q: and A: patterns
        const qaPattern = /\*\*Q:\s*([^*]+)\*\*\s*\n?\s*A:\s*([^\n*]+(?:\n(?!\*\*Q:)[^\n*]+)*)/gi;
        let qaMatch;
        let hasQA = false;

        while ((qaMatch = qaPattern.exec(sectionContent)) !== null) {
          const question = qaMatch[1].trim();
          const answer = qaMatch[2].trim();
          html += `<div class="qa-item"><div class="qa-question">Q: ${question}</div><div class="qa-answer">A: ${answer}</div></div>`;
          hasQA = true;
        }

        if (!hasQA) {
          // Fallback to regular paragraph processing
          const paragraphs = sectionContent.split(/\n\n+/);
          for (const p of paragraphs) {
            if (p.trim()) {
              html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
            }
          }
        }
        continue;
      }

      html += `<h2>${sectionTitle}</h2>`;

      // Check for sub-sections (### headers)
      if (sectionContent.includes('###')) {
        const subSections = sectionContent.split(/(?=###\s)/);
        for (const sub of subSections) {
          // Try numbered format first: ### 1. Title
          const numberedMatch = sub.match(/^###\s*(\d+)\.\s*(.+?)$/m);
          // Also try non-numbered format: ### Title
          const unNumberedMatch = sub.match(/^###\s*([^#\d\n].+?)$/m);

          if (numberedMatch) {
            html += `<h3><span class="num">${numberedMatch[1]}</span>${numberedMatch[2].trim()}</h3>`;
            let subContent = sub.replace(/^###\s*.+$/m, '').trim();

            // Process Key Insights within sub-content
            subContent = processInsights(subContent);

            // If processInsights added insight-box, don't double-process those parts
            if (subContent.includes('insight-box')) {
              html += subContent;
            } else {
              const paragraphs = subContent.split(/\n\n+/);
              for (const p of paragraphs) {
                if (p.trim()) {
                  // Check for Key Insight in paragraph
                  if (p.toLowerCase().includes('key insight:')) {
                    const insightText = p.replace(/\*\*key insight:\*\*/i, '').replace(/key insight:/i, '').trim();
                    html += `<div class="insight-box"><div class="insight-label">Key Insight</div><div class="insight-text">${insightText}</div></div>`;
                  } else {
                    html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
                  }
                }
              }
            }
          } else if (unNumberedMatch) {
            // Non-numbered sub-section like ### Founding Story
            html += `<h3>${unNumberedMatch[1].trim()}</h3>`;
            let subContent = sub.replace(/^###\s*.+$/m, '').trim();

            subContent = processInsights(subContent);
            if (subContent.includes('insight-box')) {
              html += subContent;
            } else {
              const paragraphs = subContent.split(/\n\n+/);
              for (const p of paragraphs) {
                if (p.trim()) {
                  if (p.toLowerCase().includes('key insight:')) {
                    const insightText = p.replace(/\*\*key insight:\*\*/i, '').replace(/key insight:/i, '').trim();
                    html += `<div class="insight-box"><div class="insight-label">Key Insight</div><div class="insight-text">${insightText}</div></div>`;
                  } else {
                    html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
                  }
                }
              }
            }
          } else if (sub.trim() && !sub.startsWith('###')) {
            const paragraphs = sub.split(/\n\n+/);
            for (const p of paragraphs) {
              if (p.trim()) {
                // Check for Key Insight
                if (p.toLowerCase().includes('key insight:')) {
                  const insightText = p.replace(/\*\*key insight:\*\*/i, '').replace(/key insight:/i, '').trim();
                  html += `<div class="insight-box"><div class="insight-label">Key Insight</div><div class="insight-text">${insightText}</div></div>`;
                } else {
                  html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
                }
              }
            }
          }
        }
      } else {
        // No sub-sections, just paragraphs
        const paragraphs = sectionContent.split(/\n\n+/);
        for (const p of paragraphs) {
          if (p.trim()) {
            // Check for Key Insight
            if (p.toLowerCase().includes('key insight:')) {
              const insightText = p.replace(/\*\*key insight:\*\*/i, '').replace(/key insight:/i, '').trim();
              html += `<div class="insight-box"><div class="insight-label">Key Insight</div><div class="insight-text">${insightText}</div></div>`;
            } else {
              html += `<p>${p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
            }
          }
        }
      }
    }
  }

  return html;
}

// Generate full HTML document for PDF
function generateFullHTML(reportHtml, ticker) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Initiation of Coverage - ${ticker}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Times New Roman', Georgia, serif;
      background: white;
      color: #1a1a1a;
      line-height: 1.7;
    }

    .page {
      background: white;
      max-width: 900px;
      margin: 0 auto;
      padding: 48px 56px;
    }

    /* Header */
    .report-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid #00205b;
      padding-bottom: 20px;
      margin-bottom: 28px;
    }
    .header-left { flex: 1; }
    .report-type {
      font-family: Arial, sans-serif;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #00205b;
      margin-bottom: 10px;
      font-weight: 600;
    }
    .company-name {
      font-size: 38px;
      font-weight: bold;
      color: #00205b;
      margin-bottom: 4px;
    }
    .ticker-info {
      font-family: Arial, sans-serif;
      font-size: 13px;
      color: #666;
    }
    .header-right {
      text-align: right;
      font-family: Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: flex-end;
    }
    .price {
      font-size: 32px;
      font-weight: bold;
      color: #1a1a1a;
    }
    .rating-badge {
      display: inline-block;
      background: #00205b;
      color: white;
      padding: 6px 16px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 1px;
      margin-top: 8px;
    }

    /* Investment Thesis Box */
    .thesis-box {
      background: #00205b;
      color: white;
      padding: 24px 28px;
      margin-bottom: 32px;
    }
    .thesis-header {
      display: flex;
      align-items: center;
      margin-bottom: 14px;
    }
    .thesis-icon {
      width: 26px;
      height: 26px;
      background: white;
      color: #00205b;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 15px;
      margin-right: 12px;
      font-family: Arial, sans-serif;
    }
    .thesis-label {
      font-family: Arial, sans-serif;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 2px;
      opacity: 0.8;
    }
    .thesis-text {
      font-size: 17px;
      line-height: 1.6;
    }
    .thesis-text strong { color: #7dd3fc; }

    /* Section Headers */
    h2 {
      font-family: Arial, sans-serif;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #00205b;
      border-bottom: 1px solid #ddd;
      padding-bottom: 8px;
      margin-top: 40px;
      margin-bottom: 18px;
    }

    /* Sub-section Headers */
    h3 {
      font-family: Arial, sans-serif;
      font-size: 16px;
      font-weight: 600;
      color: #00205b;
      margin-top: 28px;
      margin-bottom: 12px;
    }
    h3 .num {
      display: inline-block;
      width: 28px;
      height: 28px;
      background: #00205b;
      color: white;
      border-radius: 50%;
      text-align: center;
      line-height: 28px;
      font-size: 13px;
      margin-right: 10px;
    }

    h4 {
      font-family: Arial, sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: #444;
      margin-top: 20px;
      margin-bottom: 10px;
    }

    /* Body Text */
    p {
      margin-bottom: 14px;
      text-align: justify;
      font-size: 15px;
    }

    /* Key Insight Box */
    .insight-box {
      background: #f0f4f8;
      border-left: 4px solid #00205b;
      padding: 16px 20px;
      margin: 24px 0;
    }
    .insight-label {
      font-family: Arial, sans-serif;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #00205b;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .insight-text {
      font-style: italic;
      color: #333;
      font-size: 15px;
    }

    /* Customer/Partner Boxes */
    .customer-box {
      background: #f0f7ff;
      border-left: 4px solid #2196f3;
      padding: 14px 18px;
      margin: 14px 0;
      border-radius: 0 4px 4px 0;
    }
    .customer-box strong {
      color: #1565c0;
      font-family: Arial, sans-serif;
      font-size: 14px;
    }
    .customer-box p {
      margin: 8px 0 0 0;
      font-size: 14px;
    }

    /* Competitor Section */
    .competitor-box {
      background: #fff8e1;
      border-left: 4px solid #ff9800;
      padding: 14px 18px;
      margin: 14px 0;
      border-radius: 0 4px 4px 0;
    }
    .competitor-box strong {
      color: #e65100;
      font-family: Arial, sans-serif;
      font-size: 14px;
    }
    .competitor-box p {
      margin: 8px 0 0 0;
      font-size: 14px;
    }

    /* Key Debates */
    .debate-box {
      background: #f5f5f5;
      border-left: 4px solid #00205b;
      padding: 16px 20px;
      margin: 16px 0;
      border-radius: 0 4px 4px 0;
    }
    .debate-question {
      font-family: Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      color: #00205b;
      margin-bottom: 12px;
    }
    .bull-case {
      color: #2e7d32;
      margin: 8px 0;
      font-size: 14px;
    }
    .bull-case strong { font-family: Arial, sans-serif; }
    .bear-case {
      color: #c62828;
      margin: 8px 0;
      font-size: 14px;
    }
    .bear-case strong { font-family: Arial, sans-serif; }

    /* Data Table - Goldman Sachs Style */
    .table-container {
      margin: 20px 0;
    }
    .table-title {
      font-size: 11px;
      font-weight: bold;
      color: #00205b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      border-bottom: 2px solid #00205b;
      padding-bottom: 4px;
    }
    .table-subtitle {
      font-size: 10px;
      color: #666;
      margin-bottom: 12px;
      font-style: italic;
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      margin: 0;
      font-family: 'Times New Roman', Georgia, serif;
      font-size: 12px;
    }
    .data-table thead tr {
      border-bottom: 2px solid #00205b;
    }
    .data-table th {
      background: transparent;
      color: #00205b;
      padding: 8px 12px;
      text-align: right;
      font-weight: bold;
      font-size: 11px;
      border-bottom: 2px solid #00205b;
    }
    .data-table th:first-child {
      text-align: left;
      width: 140px;
    }
    .data-table th.estimate {
      color: #666;
      font-style: italic;
    }
    .data-table td {
      padding: 6px 12px;
      border-bottom: 1px solid #e0e0e0;
      text-align: right;
    }
    .data-table td:first-child {
      text-align: left;
      font-weight: 500;
      color: #333;
    }
    .data-table tr:hover {
      background: #f8f9fa;
    }
    .data-table .section-row td {
      font-weight: bold;
      background: #f5f5f5;
      color: #00205b;
      border-bottom: 1px solid #ccc;
      padding-top: 10px;
    }
    .data-table .metric-indent {
      padding-left: 24px;
      font-size: 11px;
      color: #555;
    }
    .data-table .negative {
      color: #c00;
    }
    .data-table .positive {
      color: #006600;
    }
    .data-table .estimate-col {
      background: #fafafa;
      color: #666;
      font-style: italic;
    }
    .data-table tfoot td {
      font-size: 9px;
      color: #888;
      padding-top: 12px;
      border: none;
      text-align: left;
    }

    /* Lists */
    ul, ol {
      margin: 14px 0 14px 24px;
      font-size: 15px;
    }
    li { margin-bottom: 8px; }

    /* Valuation Box */
    .valuation-summary {
      background: #e8f5e9;
      border: 1px solid #81c784;
      padding: 18px 22px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .valuation-summary strong {
      color: #2e7d32;
      font-family: Arial, sans-serif;
    }

    /* Risk Box */
    .risk-box {
      background: #ffebee;
      border-left: 4px solid #ef5350;
      padding: 14px 18px;
      margin: 14px 0;
      border-radius: 0 4px 4px 0;
    }
    .risk-box strong {
      color: #c62828;
      font-family: Arial, sans-serif;
      font-size: 14px;
    }
    .risk-box p {
      margin: 8px 0 0 0;
      font-size: 14px;
    }

    /* Q&A styling for Appendix */
    .qa-item {
      margin: 16px 0;
      padding-left: 16px;
      border-left: 3px solid #e0e0e0;
    }
    .qa-question {
      font-weight: 600;
      color: #00205b;
      margin-bottom: 8px;
    }
    .qa-answer {
      color: #444;
    }
  </style>
</head>
<body>
  <div class="page">
    ${reportHtml}
  </div>
</body>
</html>`;
}

// v1: Load memo template from external file (edit memo-template.txt and save - no restart needed)
function getMemoTemplate() {
  return fs.readFileSync(path.join(__dirname, 'memo-template.txt'), 'utf8');
}

// Load AI instructions from external file (edit ai-instructions.txt and save - no restart needed)
function getAIInstructions() {
  const content = fs.readFileSync(path.join(__dirname, 'ai-instructions.txt'), 'utf8');
  const systemMatch = content.match(/## SYSTEM PROMPT\n([\s\S]*?)(?=## SECTION-SPECIFIC|$)/);
  const instructionsMatch = content.match(/## SECTION-SPECIFIC INSTRUCTIONS\n([\s\S]*?)$/);
  return {
    systemPrompt: systemMatch ? systemMatch[1].trim() : '',
    sectionInstructions: instructionsMatch ? instructionsMatch[1].trim() : ''
  };
}

// v2: Direct HTML generation - AI writes HTML directly in the exact mockup format
const V2_HTML_TEMPLATE = `You are a senior Goldman Sachs equity research analyst. Generate a professional investment research report in HTML format.

CRITICAL: Output ONLY the HTML content below. No markdown. No code blocks. Just raw HTML starting with <div class="report-header"> and ending with the conclusion paragraphs.

Use this EXACT HTML structure. Fill in the content for the requested ticker with realistic, specific facts, numbers, and professional analysis:

<div class="report-header">
  <div class="header-left">
    <div class="report-type">Initiation of Coverage</div>
    <div class="company-name">[COMPANY FULL NAME]</div>
    <div class="ticker-info">[EXCHANGE]: [TICKER] · [SECTOR]</div>
  </div>
  <div class="header-right">
    <div class="price">[CURRENT STOCK PRICE - will be replaced with real price]</div>
  </div>
</div>

<div class="thesis-box">
  <div class="thesis-header">
    <div class="thesis-icon">!</div>
    <div class="thesis-label">Investment Thesis</div>
  </div>
  <div class="thesis-text">
    <strong>[ACTION like "Buy TICKER."]</strong> [2-3 punchy sentences explaining the core thesis. Be specific with facts and numbers. Example: "Dominant semiconductor franchise with unmatched FCF generation. VMware acquisition transforms the business into an infrastructure software powerhouse. AI networking tailwinds accelerating. Trading at discount to intrinsic value despite best-in-class capital allocation."]
  </div>
</div>

<h2>History & Business Overview</h2>
<p>
  [First paragraph: When was the company founded? How has it evolved to get to where it is today? Key pivots or transformations.]
</p>
<p>
  [Second paragraph: What are the key products/services the company sells? Business segments with revenue percentages.]
</p>
<p>
  [Third paragraph: Major acquisitions or strategic moves with dates and deal values. Current market position.]
</p>

<div class="insight-box">
  <div class="insight-label">Key Insight</div>
  <div class="insight-text">
    [One specific, quantified insight about the business. Example: "Broadcom's semiconductor business generates 50%+ gross margins with minimal capex requirements, resulting in industry-leading free cash flow conversion of approximately 45% of revenue."]
  </div>
</div>

<h2>Thesis Details</h2>
<p style="font-style: italic; color: #666; margin-bottom: 20px;">This is the most important section - it should be 40-50% of the entire memo. Go deep on each point with specific facts, numbers, and evidence.</p>

<h3><span class="num">1</span>[First Thesis Point Title]</h3>
<p>
  [First paragraph with specific facts, numbers, market share data, customer wins, etc.]
</p>
<p>
  [Second paragraph expanding on this point with more detail.]
</p>

<h3><span class="num">2</span>[Second Thesis Point Title]</h3>
<p>
  [First paragraph with specific facts about this point.]
</p>
<p>
  [Second paragraph with supporting details.]
</p>

<h3><span class="num">3</span>[Third Thesis Point Title]</h3>
<p>
  [First paragraph with specific facts about this point.]
</p>
<p>
  [Second paragraph with supporting details.]
</p>

<h3><span class="num">4</span>[Fourth Thesis Point Title]</h3>
<p>
  [First paragraph with specific facts about this point.]
</p>
<p>
  [Second paragraph with supporting details.]
</p>

<h3><span class="num">5</span>[Fifth Thesis Point Title - optional, include if there's a strong 5th point]</h3>
<p>
  [First paragraph with specific facts about this point.]
</p>
<p>
  [Second paragraph with supporting details.]
</p>

<h2>Key Customers & Partnerships</h2>

<div class="customer-box">
  <strong>1. [Customer Name]</strong>
  <p>[Description of relationship, % of revenue, contract details, strategic importance. 2-3 sentences.]</p>
</div>

<div class="customer-box">
  <strong>2. [Customer Name]</strong>
  <p>[Description of relationship and importance. 2-3 sentences.]</p>
</div>

<div class="customer-box">
  <strong>3. [Customer Name]</strong>
  <p>[Description of relationship and importance. 2-3 sentences.]</p>
</div>

<h2>Competitive Positioning</h2>
<p>
  [Intro paragraph about the company's market position and competitive advantages.]
</p>

<div class="competitor-box">
  <strong>[Market/Product Category]</strong>
  <p>[Competitors in this space, company's market share, competitive advantages. 2-3 sentences.]</p>
</div>

<div class="competitor-box">
  <strong>[Market/Product Category]</strong>
  <p>[Competitors in this space, market dynamics, company's position. 2-3 sentences.]</p>
</div>

<div class="competitor-box">
  <strong>[Market/Product Category]</strong>
  <p>[Competitors, competitive dynamics, switching costs. 2-3 sentences.]</p>
</div>

<h2>Key Debates</h2>

<div class="debate-box">
  <div class="debate-question">1. [Key investor question/debate about the stock]</div>
  <p class="bull-case"><strong>Bull Case:</strong> [2-3 sentences with the bullish perspective with specific supporting facts.]</p>
  <p class="bear-case"><strong>Bear Case:</strong> [2-3 sentences with the bearish perspective with specific concerns.]</p>
</div>

<div class="debate-box">
  <div class="debate-question">2. [Second key debate]</div>
  <p class="bull-case"><strong>Bull Case:</strong> [Bullish perspective with facts.]</p>
  <p class="bear-case"><strong>Bear Case:</strong> [Bearish perspective with concerns.]</p>
</div>

<div class="debate-box">
  <div class="debate-question">3. [Third key debate]</div>
  <p class="bull-case"><strong>Bull Case:</strong> [Bullish perspective.]</p>
  <p class="bear-case"><strong>Bear Case:</strong> [Bearish perspective.]</p>
</div>

<h2>Management Quality</h2>
<p>
  [First paragraph about CEO background, tenure, track record with specific accomplishments and value created.]
</p>
<p>
  [Second paragraph about management team, operational excellence, capital allocation philosophy.]
</p>

<div class="insight-box">
  <div class="insight-label">Key Insight</div>
  <div class="insight-text">
    [Specific insight about management compensation, incentives, or alignment with shareholders.]
  </div>
</div>

<h2>Retail Sentiment</h2>
<p>
  [First paragraph about social media mentions, Reddit discussions, retail trading activity.]
</p>
<p>
  [Second paragraph about key themes in retail discussion, sentiment breakdown, notable concerns or enthusiasm.]
</p>

<h2>Financial Analysis</h2>

<table class="data-table">
  <tr>
    <th>Metric</th>
    <th>FY[YEAR-1]</th>
    <th>FY[YEAR]E</th>
    <th>FY[YEAR+1]E</th>
    <th>FY[YEAR+2]E</th>
  </tr>
  <tr>
    <td>Revenue ($B)</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
  </tr>
  <tr>
    <td>Growth (%)</td>
    <td class="number">[value]%</td>
    <td class="number">[value]%</td>
    <td class="number">[value]%</td>
    <td class="number">[value]%</td>
  </tr>
  <tr>
    <td>Adj. EBITDA ($B)</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
  </tr>
  <tr>
    <td>EBITDA Margin</td>
    <td class="number">[value]%</td>
    <td class="number">[value]%</td>
    <td class="number">[value]%</td>
    <td class="number">[value]%</td>
  </tr>
  <tr>
    <td>Free Cash Flow ($B)</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
    <td class="number">[value]</td>
  </tr>
  <tr>
    <td>EPS (Adj.)</td>
    <td class="number">$[value]</td>
    <td class="number">$[value]</td>
    <td class="number">$[value]</td>
    <td class="number">$[value]</td>
  </tr>
</table>
<p style="font-size: 13px; color: #666; font-style: italic;">[Any relevant footnotes about the financials, like stock splits]</p>

<h2>Valuation</h2>
<p>
  [Paragraph about current valuation multiples (P/E, EV/EBITDA), comparison to peers, historical context. Do NOT include a price target or green summary box.]
</p>

<h2>Key Risks</h2>

<div class="risk-box">
  <strong>[Risk 1 Title]</strong>
  <p>[Specific description of this risk with quantified impact if possible. 2-3 sentences.]</p>
</div>

<div class="risk-box">
  <strong>[Risk 2 Title]</strong>
  <p>[Specific description of this risk. 2-3 sentences.]</p>
</div>

<div class="risk-box">
  <strong>[Risk 3 Title]</strong>
  <p>[Specific description of this risk. 2-3 sentences.]</p>
</div>

<div class="risk-box">
  <strong>[Risk 4 Title]</strong>
  <p>[Specific description of this risk. 2-3 sentences.]</p>
</div>

<h2>Appendix: Key Earnings Call Q&A</h2>
<p style="font-style: italic; color: #666;">Selected questions from recent earnings calls that reveal key debates and management thinking.</p>

<div class="qa-item">
  <p class="qa-question"><strong>Q: [Analyst question - direct quote or close paraphrase about a key debate or growth driver]</strong></p>
  <p class="qa-answer">A: [Management's response - direct quote or close paraphrase]</p>
</div>

<div class="qa-item">
  <p class="qa-question"><strong>Q: [Second analyst question about risks or opportunities]</strong></p>
  <p class="qa-answer">A: [Management's response]</p>
</div>

<div class="qa-item">
  <p class="qa-question"><strong>Q: [Third analyst question about strategy or competitive positioning]</strong></p>
  <p class="qa-answer">A: [Management's response]</p>
</div>

<div class="qa-item">
  <p class="qa-question"><strong>Q: [Fourth analyst question - optional]</strong></p>
  <p class="qa-answer">A: [Management's response]</p>
</div>

<p style="font-size: 12px; color: #888; margin-top: 20px;">Note: Only include this Appendix section if earnings transcript data is available. Skip entirely if no transcripts provided.</p>

IMPORTANT GUIDELINES:
1. Output ONLY the raw HTML - no markdown code blocks, no backticks, no explanations
2. Use realistic, specific numbers based on your knowledge (revenue figures, margins, market share, etc.)
3. Write like a real Goldman Sachs analyst - professional, confident, fact-dense
4. Every sentence should convey specific information - no filler phrases like "well-positioned" or "industry leader"
5. Include actual competitor names, customer names, and market data
6. For financials, use realistic projections consistent with the company's growth profile
7. The thesis should be punchy and direct - "Buy [TICKER]." as the opener
8. Do NOT include a Conclusion section
9. Do NOT include a price target or any green valuation-summary box`;

app.post('/api/generate-report', async (req, res) => {
  const { ticker, forceRefresh, version = 'v1' } = req.body;
  console.log(`Request: ticker=${ticker}, forceRefresh=${forceRefresh}, version=${version}`);
  // Load template fresh each time (so edits to memo-template.txt take effect immediately)
  const memoTemplate = getMemoTemplate();

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker is required' });
  }

  // Check cache first (unless forceRefresh is requested)
  if (!forceRefresh) {
    const cached = getCachedReport(ticker);
    if (cached) {
      console.log(`Returning cached report for ${ticker.toUpperCase()} (generated ${cached.generatedAt})`);
      // If no HTML in cache, generate it
      const html = cached.html || convertReportToHTML(cached.report, ticker.toUpperCase());
      return res.json({
        report: cached.report,
        html,
        cached: true,
        generatedAt: cached.generatedAt
      });
    }
  }

  try {
    // V2: Direct HTML generation - AI outputs HTML directly in the exact mockup format
    if (version === 'v2') {
      console.log(`Generating v2 report for ${ticker.toUpperCase()} (direct HTML generation)...`);

      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 12000,
        messages: [
          {
            role: 'user',
            content: `${V2_HTML_TEMPLATE}\n\nGenerate this report for ${ticker.toUpperCase()}.`
          }
        ]
      });
      logTokenUsage('initiation', response.usage);

      // The response IS the HTML - no conversion needed
      let html = response.choices[0].message.content;

      // Clean up any markdown code block wrappers if the AI added them
      html = html.replace(/^```html?\s*/i, '').replace(/\s*```$/i, '').trim();

      // Store the HTML as both report and html (for v2, they're the same)
      saveToCache(ticker, html, html);
      console.log(`Generated and cached v2 report for ${ticker.toUpperCase()}`);

      return res.json({ report: html, html, cached: false, generatedAt: new Date().toISOString() });
    }

    // V3: Research data + direct HTML generation (best of v1 and v2)
    if (version === 'v3') {
      const v3StartTime = Date.now();
      console.log(`Generating v3 report for ${ticker.toUpperCase()} (research + direct HTML)...`);

      // Fetch real stock price from Yahoo Finance
      let realStockPrice = null;
      try {
        const quote = await yahooFinance.quote(ticker.toUpperCase());
        if (quote && quote.regularMarketPrice !== undefined) {
          realStockPrice = quote.regularMarketPrice;
          console.log(`Fetched real stock price for ${ticker.toUpperCase()}: $${realStockPrice}`);
        }
      } catch (err) {
        console.error(`Error fetching stock price for ${ticker}:`, err.message);
      }

      // Fetch all research data like v1
      const secDataPromise = fetch10KData(ticker.toUpperCase());
      const earningsPromise = fetchEarningsTranscripts(ticker.toUpperCase());

      const researchPrompt = `You are a hedge fund analyst researching ${ticker.toUpperCase()}.
Search for: bull/bear cases, investment thesis, earnings takeaways, analyst views, current CEO and management team.
Find: primary narrative, key customers, competitors, debates investors have, current CEO name and background (IMPORTANT: verify this is the CURRENT CEO as of 2024/2025).
Only verified facts.`;

      // Check web search cache first
      let research = getCachedWebSearch(ticker);

      if (!research) {
        console.log(`Running web search for ${ticker} (v3)...`);
        const researchResponse = await client.responses.create({
          model: 'gpt-4o',
          tools: [{ type: 'web_search' }],
          input: researchPrompt
        });
        if (researchResponse.usage) logTokenUsage('initiation', researchResponse.usage);
        research = researchResponse.output_text;
        saveWebSearchToCache(ticker, research);
      }
      const [secData, earningsData] = await Promise.all([secDataPromise, earningsPromise]);

      // Format research data
      let researchContext = `\n\n--- RESEARCH DATA ---\n\n**Web Research:**\n${research}\n`;

      if (secData) {
        researchContext += `\n**10-K Filing (${secData.fiscalYear}):**\n`;
        for (const [name, content] of Object.entries(secData.sections)) {
          if (content) researchContext += `${name}: ${content.substring(0, 2000)}\n`;
        }
      }

      if (earningsData && earningsData.transcripts) {
        researchContext += `\n**Earnings Transcripts:**\n`;
        for (const t of earningsData.transcripts) {
          researchContext += `Q${t.quarter} ${t.year}: ${t.transcript.substring(0, 2000)}\n`;
        }
      }

      researchContext += `\n**Management Team:** Use the CEO/management information from the web research above. This data is more current than training knowledge.\n`;

      // Generate HTML directly using v2 template + research data
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 12000,
        messages: [
          {
            role: 'user',
            content: `${V2_HTML_TEMPLATE}

--- USE THIS RESEARCH DATA ---
${researchContext}
---

Generate this report for ${ticker.toUpperCase()}. Use the research data above for accurate, specific facts. Output ONLY raw HTML.`
          }
        ]
      });
      logTokenUsage('initiation', response.usage);

      let html = response.choices[0].message.content;
      html = html.replace(/^```html?\s*/i, '').replace(/\s*```$/i, '').trim();

      // Inject real stock price if we fetched it
      if (realStockPrice !== null) {
        // Replace any price in the header with the real price
        html = html.replace(/<div class="price">[^<]*<\/div>/i, `<div class="price">$${realStockPrice.toFixed(2)}</div>`);
      }

      saveToCache(ticker, html, html);
      const v3Duration = ((Date.now() - v3StartTime) / 1000).toFixed(1);
      console.log(`Generated and cached v3 report for ${ticker.toUpperCase()} in ${v3Duration}s`);

      return res.json({ report: html, html, cached: false, generatedAt: new Date().toISOString() });
    }

    // V1: Full research approach with 10-K, earnings, web search (markdown output)
    const v1StartTime = Date.now();

    // Fetch real stock price and financial data from Yahoo Finance
    let realStockPrice = null;
    let financialData = null;
    try {
      const quote = await yahooFinance.quote(ticker.toUpperCase());
      if (quote && quote.regularMarketPrice !== undefined) {
        realStockPrice = quote.regularMarketPrice;
        console.log(`Fetched real stock price for ${ticker.toUpperCase()}: $${realStockPrice}`);
      }

      // Fetch detailed financial data
      const summary = await yahooFinance.quoteSummary(ticker.toUpperCase(), {
        modules: ['incomeStatementHistory', 'incomeStatementHistoryQuarterly', 'balanceSheetHistory', 'cashflowStatementHistory', 'financialData', 'defaultKeyStatistics', 'earningsHistory', 'earningsTrend']
      });

      if (summary) {
        financialData = {
          // Current metrics
          marketCap: summary.financialData?.marketCap,
          revenue: summary.financialData?.totalRevenue,
          grossMargin: summary.financialData?.grossMargins,
          ebitdaMargin: summary.financialData?.ebitdaMargins,
          operatingMargin: summary.financialData?.operatingMargins,
          profitMargin: summary.financialData?.profitMargins,
          freeCashFlow: summary.financialData?.freeCashflow,

          // Valuation
          trailingPE: summary.defaultKeyStatistics?.trailingPE,
          forwardPE: summary.defaultKeyStatistics?.forwardPE,
          pegRatio: summary.defaultKeyStatistics?.pegRatio,
          priceToBook: summary.defaultKeyStatistics?.priceToBook,
          enterpriseValue: summary.defaultKeyStatistics?.enterpriseValue,
          evToRevenue: summary.defaultKeyStatistics?.enterpriseToRevenue,
          evToEbitda: summary.defaultKeyStatistics?.enterpriseToEbitda,

          // Historical income statements
          incomeHistory: summary.incomeStatementHistory?.incomeStatementHistory?.slice(0, 4),

          // Historical EPS (quarterly)
          earningsHistory: summary.earningsHistory?.history,

          // Earnings trend/estimates
          earningsTrend: summary.earningsTrend?.trend
        };
        console.log(`Fetched financial data for ${ticker.toUpperCase()}`);
      }
    } catch (err) {
      console.error(`Error fetching Yahoo Finance data for ${ticker}:`, err.message);
    }

    // STEP 1a: Fetch 10-K data, earnings transcript, and Alpha Vantage financials (run in parallel)
    console.log(`Fetching 10-K, earnings transcript, and financials for ${ticker.toUpperCase()}...`);
    const secDataPromise = fetch10KData(ticker.toUpperCase());
    const earningsPromise = fetchEarningsTranscripts(ticker.toUpperCase());
    // Wrap Alpha Vantage in catch so it doesn't break report if it fails
    const alphaVantagePromise = fetchAlphaVantageFinancials(ticker.toUpperCase()).catch(err => {
      console.error('Alpha Vantage error (continuing without):', err.message);
      return null;
    });

    // STEP 1b: Research with web search (using Responses API for web search)
    const researchPrompt = `You are a hedge fund analyst researching ${ticker.toUpperCase()}.

Search for INVESTOR-FOCUSED content:
1. "${ticker.toUpperCase()} bull case bear case" — what are investors debating?
2. "${ticker.toUpperCase()} investment thesis" or "${ticker.toUpperCase()} stock thesis"
3. "${ticker.toUpperCase()} earnings call key takeaways" — what did management emphasize?
4. "${ticker.toUpperCase()} analyst report"
5. "${ticker.toUpperCase()} CEO" or "${ticker.toUpperCase()} management team" — who is the current CEO and key executives?

Find:
- The PRIMARY narrative driving this stock (not generic description)
- Key customers (with evidence)
- Direct competitors (for the main growth driver)
- Bull/bear debates investors actually have
- Current CEO name, when they became CEO, and their background (IMPORTANT: verify this is the CURRENT CEO as of 2024/2025)

Only include verified facts. Cite sources.`;

    // Check web search cache first
    let research = getCachedWebSearch(ticker);

    if (!research) {
      console.log(`Running web search for ${ticker}...`);
      const researchResponse = await client.responses.create({
        model: 'gpt-4o',
        tools: [{ type: 'web_search' }],
        input: researchPrompt
      });
      if (researchResponse.usage) logTokenUsage('initiation', researchResponse.usage);
      research = researchResponse.output_text;
      saveWebSearchToCache(ticker, research);
    }

    // Wait for SEC data, earnings transcript, and Alpha Vantage
    const [secData, earningsData, alphaVantageData] = await Promise.all([secDataPromise, earningsPromise, alphaVantagePromise]);

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

    // Format Yahoo Finance financial data
    let financialContext = '';
    if (financialData) {
      financialContext = `\n\n--- VALUATION DATA (for Valuation section only) ---\n`;

      // Helper to format large numbers
      const formatNum = (n) => {
        if (!n) return 'N/A';
        if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
        if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
        return `$${n.toFixed(0)}`;
      };
      const formatPct = (n) => n ? `${(n * 100).toFixed(1)}%` : 'N/A';

      financialContext += `**Valuation Metrics:**\n`;
      financialContext += `- Market Cap: ${formatNum(financialData.marketCap)}\n`;
      financialContext += `- Trailing P/E: ${financialData.trailingPE ? financialData.trailingPE.toFixed(1) + 'x' : 'N/A'}\n`;
      financialContext += `- Forward P/E: ${financialData.forwardPE ? financialData.forwardPE.toFixed(1) + 'x' : 'N/A'}\n`;
      financialContext += `- PEG Ratio: ${financialData.pegRatio ? financialData.pegRatio.toFixed(2) + 'x' : 'N/A'}\n`;
      financialContext += `- Price/Book: ${financialData.priceToBook ? financialData.priceToBook.toFixed(2) + 'x' : 'N/A'}\n`;
      financialContext += `- EV/Revenue: ${financialData.evToRevenue ? financialData.evToRevenue.toFixed(2) + 'x' : 'N/A'}\n`;
      financialContext += `- EV/EBITDA: ${financialData.evToEbitda ? financialData.evToEbitda.toFixed(1) + 'x' : 'N/A'}\n\n`;

      // Historical income statements with calculated metrics - years as columns
      if (financialData.incomeHistory && financialData.incomeHistory.length > 0) {
        const history = financialData.incomeHistory.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

        // Aggregate quarterly EPS into annual EPS
        const annualEps = {};
        if (financialData.earningsHistory && financialData.earningsHistory.length > 0) {
          for (const q of financialData.earningsHistory) {
            if (q.epsActual && q.quarter) {
              const year = new Date(q.quarter).getFullYear();
              if (!annualEps[year]) annualEps[year] = { total: 0, count: 0 };
              annualEps[year].total += q.epsActual;
              annualEps[year].count += 1;
            }
          }
        }

        // Build arrays for each metric
        const years = [];
        const revenues = [];
        const growths = [];
        const grossMargins = [];
        const operatingMargins = [];
        const netIncomes = [];
        const eps = [];

        for (let i = 0; i < history.length; i++) {
          const stmt = history[i];
          const year = new Date(stmt.endDate).getFullYear();
          const revenue = stmt.totalRevenue;
          const grossProfit = stmt.grossProfit;
          const operatingIncome = stmt.operatingIncome;
          const netIncome = stmt.netIncome;

          years.push(`FY${year}`);
          revenues.push(formatNum(revenue));
          netIncomes.push(formatNum(netIncome));

          // Get annual EPS only if we have all 4 quarters of data
          if (annualEps[year] && annualEps[year].count >= 4) {
            eps.push(`$${annualEps[year].total.toFixed(2)}`);
          } else {
            eps.push('--');
          }

          // Calculate YoY growth
          if (i > 0 && history[i-1].totalRevenue) {
            const prevRevenue = history[i-1].totalRevenue;
            growths.push(`${(((revenue - prevRevenue) / prevRevenue) * 100).toFixed(1)}%`);
          } else {
            growths.push('N/A');
          }

          // Calculate margins
          grossMargins.push(revenue ? `${((grossProfit / revenue) * 100).toFixed(1)}%` : 'N/A');
          operatingMargins.push(revenue ? `${((operatingIncome / revenue) * 100).toFixed(1)}%` : 'N/A');
        }

        // Add forward estimates from earningsTrend
        if (financialData.earningsTrend && financialData.earningsTrend.length > 0) {
          const currentYear = new Date().getFullYear();
          for (const trend of financialData.earningsTrend) {
            // Look for annual estimates (0y = current year, +1y = next year)
            if (trend.period === '0y' || trend.period === '+1y') {
              const estYear = trend.period === '0y' ? currentYear : currentYear + 1;
              years.push(`FY${estYear}E`);

              if (trend.revenueEstimate?.avg) {
                revenues.push(formatNum(trend.revenueEstimate.avg));
              } else {
                revenues.push('N/A');
              }

              if (trend.revenueEstimate?.growth) {
                growths.push(`${(trend.revenueEstimate.growth * 100).toFixed(1)}%`);
              } else {
                growths.push('N/A');
              }

              grossMargins.push('--');
              operatingMargins.push('--');
              netIncomes.push('--');

              if (trend.earningsEstimate?.avg) {
                eps.push(`$${trend.earningsEstimate.avg.toFixed(2)}`);
              } else {
                eps.push('N/A');
              }
            }
          }
        }

        financialContext += `**Historical Financial Data (reference only):**\n`;
        financialContext += `| Metric | ${years.join(' | ')} |\n`;
        financialContext += `|--------|${years.map(() => '-------:').join('|')}|\n`;
        financialContext += `| Revenue | ${revenues.join(' | ')} |\n`;
        financialContext += `| YoY Growth | ${growths.join(' | ')} |\n`;
        financialContext += `| Gross Margin | ${grossMargins.join(' | ')} |\n`;
        financialContext += `| Operating Margin | ${operatingMargins.join(' | ')} |\n`;
        financialContext += `| Net Income | ${netIncomes.join(' | ')} |\n`;
        financialContext += `| EPS | ${eps.join(' | ')} |\n`;
        financialContext += '\n';
      }

      // Current TTM metrics
      financialContext += `**Current (TTM) Metrics:**\n`;
      financialContext += `- Revenue: ${formatNum(financialData.revenue)}\n`;
      financialContext += `- Gross Margin: ${formatPct(financialData.grossMargin)}\n`;
      financialContext += `- EBITDA Margin: ${formatPct(financialData.ebitdaMargin)}\n`;
      financialContext += `- Operating Margin: ${formatPct(financialData.operatingMargin)}\n`;
      financialContext += `- Net Margin: ${formatPct(financialData.profitMargin)}\n`;
      financialContext += `- Free Cash Flow: ${formatNum(financialData.freeCashFlow)}\n\n`;

      // Earnings estimates
      if (financialData.earningsTrend && financialData.earningsTrend.length > 0) {
        financialContext += `**Analyst Estimates (Forward):**\n`;
        for (const trend of financialData.earningsTrend) {
          if (trend.period && trend.earningsEstimate?.avg) {
            financialContext += `${trend.period}: EPS Est $${trend.earningsEstimate.avg.toFixed(2)}`;
            if (trend.revenueEstimate?.avg) {
              financialContext += `, Revenue Est ${formatNum(trend.revenueEstimate.avg)}`;
            }
            if (trend.revenueEstimate?.growth) {
              financialContext += `, Growth Est ${(trend.revenueEstimate.growth * 100).toFixed(1)}%`;
            }
            financialContext += '\n';
          }
        }
      }
    }

    // Add Alpha Vantage financial data for the table
    if (alphaVantageData && alphaVantageData.length > 0) {
      financialContext += `\n\n--- FINANCIAL DATA FOR TABLE (USE THESE EXACT NUMBERS) ---\n`;
      const reversed = [...alphaVantageData].reverse(); // oldest to newest

      // Get forward estimates from Yahoo Finance
      let forwardYears = [];
      let forwardRevenue = [];
      let forwardGrowth = [];
      if (financialData && financialData.earningsTrend) {
        for (const t of financialData.earningsTrend) {
          if ((t.period === '0y' || t.period === '+1y') && t.revenueEstimate && t.revenueEstimate.avg) {
            const latestFY = parseInt(reversed[reversed.length - 1].fiscalYear);
            const estYear = t.period === '0y' ? latestFY + 1 : latestFY + 2;
            forwardYears.push('FY' + estYear + 'E');
            forwardRevenue.push('$' + (t.revenueEstimate.avg / 1e6).toFixed(0) + 'M');
            forwardGrowth.push(t.revenueEstimate.growth ? (t.revenueEstimate.growth * 100).toFixed(1) + '%' : 'N/A');
          }
        }
      }

      const allYears = [...reversed.map(r => 'FY' + r.fiscalYear), ...forwardYears];
      const allRevenue = [...reversed.map(r => '$' + (r.revenue / 1e6).toFixed(0) + 'M'), ...forwardRevenue];
      const allGrowth = [...reversed.map(r => r.yoyGrowth === 'N/A' ? 'N/A' : r.yoyGrowth + '%'), ...forwardGrowth];
      const emptyEst = forwardYears.map(() => '-');

      financialContext += `| Metric | ${allYears.join(' | ')} |\n`;
      financialContext += `|--------|${allYears.map(() => '-------:').join('|')}|\n`;
      financialContext += `| Revenue | ${allRevenue.join(' | ')} |\n`;
      financialContext += `| YoY Growth | ${allGrowth.join(' | ')} |\n`;
      financialContext += `| Gross Profit | ${[...reversed.map(r => '$' + (r.grossProfit / 1e6).toFixed(0) + 'M'), ...emptyEst].join(' | ')} |\n`;
      financialContext += `| Gross Margin | ${[...reversed.map(r => r.grossMargin + '%'), ...emptyEst].join(' | ')} |\n`;
      financialContext += `| EBITDA | ${[...reversed.map(r => '$' + (r.ebitda / 1e6).toFixed(0) + 'M'), ...emptyEst].join(' | ')} |\n`;
      financialContext += `| EBITDA Margin | ${[...reversed.map(r => r.ebitdaMargin + '%'), ...emptyEst].join(' | ')} |\n`;
      financialContext += `| Net Income | ${[...reversed.map(r => '$' + (r.netIncome / 1e6).toFixed(0) + 'M'), ...emptyEst].join(' | ')} |\n`;
      financialContext += `| Net Margin | ${[...reversed.map(r => r.netMargin + '%'), ...emptyEst].join(' | ')} |\n`;
    }

    // Look up CEO data from our known data file
    const ceoData = getCeoData(ticker);
    let managementContext = `**MANAGEMENT TEAM:**\n`;
    if (ceoData) {
      managementContext += `VERIFIED CEO DATA (use this, not web research):\n`;
      managementContext += `- CEO: ${ceoData.ceo} (since ${ceoData.since})\n`;
      if (ceoData.cfo) {
        managementContext += `- CFO: ${ceoData.cfo}`;
        if (ceoData.cfo_since) managementContext += ` (since ${ceoData.cfo_since})`;
        managementContext += `\n`;
      }
      if (ceoData.background) managementContext += `- Background: ${ceoData.background}\n`;
    } else {
      managementContext += `Use the CEO/management information from the WEB RESEARCH above.\n`;
    }

    // STEP 2: Generate memo using Chat Completions API with template
    const aiInstructions = getAIInstructions();
    const firstDraftMessages = [
      {
        role: 'system',
        content: aiInstructions.systemPrompt
      },
      {
        role: 'user',
        content: `Write an initiation of coverage memo for ${ticker.toUpperCase()} following this EXACT template structure:

${memoTemplate}

---

Here is the research data to use:

**WEB RESEARCH:**
${research}

${secContext}

${earningsContext}

${financialContext}

${managementContext}

---

IMPORTANT INSTRUCTIONS:
${aiInstructions.sectionInstructions}`
      }
    ];

    const firstDraft = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 8000,
      messages: firstDraftMessages
    });
    logTokenUsage('initiation', firstDraft.usage);

    const report = firstDraft.choices[0].message.content;

    // Convert markdown to HTML
    let html = convertReportToHTML(report, ticker.toUpperCase(), realStockPrice);

    // Save to cache (save both markdown and HTML)
    saveToCache(ticker, report, html);
    const v1Duration = ((Date.now() - v1StartTime) / 1000).toFixed(1);
    console.log(`Generated and cached new report for ${ticker.toUpperCase()} in ${v1Duration}s`);

    res.json({ report, html, cached: false, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error generating report:', error);

    // Provide more specific error messages based on error type
    if (error.code === 'insufficient_quota' || error.status === 429) {
      res.status(503).json({
        error: 'AI service temporarily unavailable due to usage limits. Please try again in a few minutes.',
        errorCode: 'QUOTA_EXCEEDED'
      });
    } else if (error.message?.includes('timeout') || error.code === 'ETIMEDOUT') {
      res.status(504).json({
        error: 'Request timed out while generating report. Please try again.',
        errorCode: 'TIMEOUT'
      });
    } else {
      res.status(500).json({ error: 'Failed to generate report' });
    }
  }
});

// Chat endpoint for follow-up questions
app.post('/api/chat', async (req, res) => {
  const { ticker, question, report, chatHistory } = req.body;

  if (!ticker || !question) {
    return res.status(400).json({ error: 'Ticker and question are required' });
  }

  try {
    console.log(`Chat: ${ticker} - "${question}"`);

    // Format conversation history
    let conversation = '';
    if (chatHistory && chatHistory.length > 0) {
      conversation = 'Previous conversation:\n';
      for (const msg of chatHistory) {
        conversation += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      }
      conversation += '\n';
    }

    const prompt = `You're a helpful assistant. The user is researching ${ticker.toUpperCase()} stock.

Here's the report they're looking at:
${report}

${conversation}User: ${question}

Instructions:
- Give a SHORT, conversational answer (2-4 sentences for simple questions)
- No headers, bullet points, or heavy formatting
- Write like you're chatting, not writing a report
- Use web search if needed for current info`;

    const response = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: prompt
    });
    if (response.usage) logTokenUsage('chat', response.usage);

    // Clean up any citation links
    let answer = response.output_text
      .replace(/\(\[.*?\]\(.*?\)\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    res.json({ answer });
  } catch (error) {
    console.error('Chat error:', error);

    if (error.code === 'insufficient_quota' || error.status === 429) {
      res.status(503).json({
        error: 'AI service temporarily unavailable due to usage limits. Please try again in a few minutes.',
        errorCode: 'QUOTA_EXCEEDED'
      });
    } else {
      res.status(500).json({ error: 'Failed to process question' });
    }
  }
});

// PDF generation endpoint
app.post('/api/download-pdf', async (req, res) => {
  const { ticker } = req.body;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker is required' });
  }

  try {
    // Get cached report
    const cached = getCachedReport(ticker);
    if (!cached) {
      return res.status(404).json({ error: 'Report not found. Please generate the report first.' });
    }

    const html = cached.html || convertReportToHTML(cached.report, ticker.toUpperCase());
    const fullHtml = generateFullHTML(html, ticker.toUpperCase());

    console.log(`Generating PDF for ${ticker.toUpperCase()}...`);

    // Launch puppeteer and generate PDF
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: {
        top: '0.25in',
        right: '0.25in',
        bottom: '0.25in',
        left: '0.25in'
      }
    });

    await browser.close();

    console.log(`PDF generated for ${ticker.toUpperCase()}`);

    // Send PDF as download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${ticker.toUpperCase()}_Research_Report.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ============================================
// PORTFOLIO MOVERS ENDPOINT
// ============================================

// Cache for portfolio movers (15 minute TTL)
const PORTFOLIO_CACHE_DIR = path.join(__dirname, 'cache', 'portfolio');
const PORTFOLIO_CACHE_TTL_MINUTES = 15;

// Ensure portfolio cache directory exists
if (!fs.existsSync(PORTFOLIO_CACHE_DIR)) {
  fs.mkdirSync(PORTFOLIO_CACHE_DIR, { recursive: true });
}

// Index constituents (simplified lists for performance)
const INDEX_CONSTITUENTS = {
  NASDAQ100: [
    'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'TSLA', 'AVGO', 'COST', 'PEP',
    'ADBE', 'CSCO', 'NFLX', 'AMD', 'INTC', 'CMCSA', 'TMUS', 'QCOM', 'TXN', 'AMGN',
    'INTU', 'AMAT', 'ISRG', 'BKNG', 'HON', 'SBUX', 'VRTX', 'GILD', 'ADI', 'ADP',
    'MDLZ', 'LRCX', 'REGN', 'PANW', 'PYPL', 'MU', 'KLAC', 'SNPS', 'MRVL', 'CDNS'
  ],
  SP500: [
    'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'TSLA', 'UNH', 'XOM',
    'JNJ', 'JPM', 'V', 'PG', 'MA', 'HD', 'CVX', 'MRK', 'ABBV', 'LLY',
    'PEP', 'KO', 'COST', 'AVGO', 'MCD', 'WMT', 'CSCO', 'TMO', 'ACN', 'ABT',
    'DHR', 'VZ', 'ADBE', 'CRM', 'NKE', 'CMCSA', 'NEE', 'TXN', 'PM', 'INTC',
    'WFC', 'NFLX', 'AMD', 'UPS', 'BMY', 'QCOM', 'RTX', 'AMGN', 'T', 'LOW',
    'SPGI', 'BA', 'MS', 'CAT', 'GS', 'IBM', 'SBUX', 'PFE', 'GE', 'DE',
    'BLK', 'INTU', 'GILD', 'MDLZ', 'AXP', 'ISRG', 'BKNG', 'ADI', 'MMM', 'VRTX'
  ]
};

// Company name lookup (short names)
const COMPANY_NAMES = {
  'AAPL': 'Apple',
  'MSFT': 'Microsoft',
  'AMZN': 'Amazon',
  'NVDA': 'NVIDIA',
  'GOOGL': 'Alphabet',
  'META': 'Meta',
  'TSLA': 'Tesla',
    'UNH': 'UnitedHealth',
  'XOM': 'Exxon Mobil',
  'JNJ': 'Johnson & Johnson',
  'JPM': 'JPMorgan',
  'V': 'Visa',
  'PG': 'Procter & Gamble',
  'MA': 'Mastercard',
  'HD': 'Home Depot',
  'CVX': 'Chevron',
  'MRK': 'Merck',
  'ABBV': 'AbbVie',
  'LLY': 'Eli Lilly',
  'PEP': 'PepsiCo',
  'KO': 'Coca-Cola',
  'COST': 'Costco',
  'AVGO': 'Broadcom',
  'MCD': "McDonald's",
  'WMT': 'Walmart',
  'CSCO': 'Cisco',
  'TMO': 'Thermo Fisher',
  'ACN': 'Accenture',
  'ABT': 'Abbott',
  'DHR': 'Danaher',
  'VZ': 'Verizon',
  'ADBE': 'Adobe',
  'CRM': 'Salesforce',
  'NKE': 'Nike',
  'CMCSA': 'Comcast',
  'NEE': 'NextEra Energy',
  'TXN': 'Texas Instruments',
  'PM': 'Philip Morris',
  'INTC': 'Intel',
  'WFC': 'Wells Fargo',
  'NFLX': 'Netflix',
  'AMD': 'AMD',
  'UPS': 'UPS',
  'BMY': 'Bristol-Myers Squibb',
  'QCOM': 'Qualcomm',
  'RTX': 'RTX',
  'AMGN': 'Amgen',
  'T': 'AT&T',
  'LOW': "Lowe's",
  'SPGI': 'S&P Global',
  'BA': 'Boeing',
  'MS': 'Morgan Stanley',
  'CAT': 'Caterpillar',
  'GS': 'Goldman Sachs',
  'IBM': 'IBM',
  'SBUX': 'Starbucks',
  'PFE': 'Pfizer',
  'GE': 'GE',
  'DE': 'Deere',
  'BLK': 'BlackRock',
  'INTU': 'Intuit',
  'GILD': 'Gilead',
  'MDLZ': 'Mondelez',
  'AXP': 'American Express',
  'ISRG': 'Intuitive Surgical',
  'BKNG': 'Booking',
  'ADI': 'Analog Devices',
  'MMM': '3M',
  'VRTX': 'Vertex',
  'DOW': 'Dow',
  'HON': 'Honeywell',
  'TRV': 'Travelers',
  'WBA': 'Walgreens',
  'TMUS': 'T-Mobile',
  'AMAT': 'Applied Materials',
  'ADP': 'ADP',
  'LRCX': 'Lam Research',
  'REGN': 'Regeneron',
  'PANW': 'Palo Alto Networks',
  'PYPL': 'PayPal',
  'MU': 'Micron',
  'KLAC': 'KLA',
  'SNPS': 'Synopsys',
  'MRVL': 'Marvell',
  'CDNS': 'Cadence',
  'SMTC': 'Semtech',
  'MTSI': 'MACOM'
};

function getPortfolioCachePath(index, tickers) {
  const key = index === 'CUSTOM' ? `CUSTOM_${tickers.sort().join('_')}` : index;
  return path.join(PORTFOLIO_CACHE_DIR, `${key}.json`);
}

function getCachedPortfolioData(index, tickers) {
  const cachePath = getPortfolioCachePath(index, tickers || []);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.timestamp;
    const ageMinutes = ageMs / (1000 * 60);

    if (ageMinutes <= PORTFOLIO_CACHE_TTL_MINUTES) {
      console.log(`Using cached portfolio data (cached ${ageMinutes.toFixed(1)} minutes ago)`);
      return cached.data;
    }
    return null;
  } catch (error) {
    console.error('Error reading portfolio cache:', error);
    return null;
  }
}

function savePortfolioToCache(index, tickers, data) {
  const cachePath = getPortfolioCachePath(index, tickers || []);
  const cacheData = {
    data,
    timestamp: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log('Cached portfolio data');
  } catch (error) {
    console.error('Error writing portfolio cache:', error);
  }
}

// Check if current time is before market open (9:30 AM ET)
function isBeforeMarketOpen() {
  const now = new Date();
  // Convert to ET (handle daylight saving)
  const etOptions = { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false };
  const etTime = now.toLocaleString('en-US', etOptions);
  const [hours, minutes] = etTime.split(':').map(Number);

  // Before 9:30 AM ET
  return hours < 9 || (hours === 9 && minutes < 30);
}

// Fetch stock data using Yahoo Finance API
async function fetchStockData(tickers) {
  const stockData = [];

  // Fetch quotes for all tickers in parallel
  const quotePromises = tickers.map(async (ticker) => {
    try {
      const quote = await yahooFinance.quote(ticker);
      if (quote && quote.regularMarketPrice !== undefined) {
        const changePercent = quote.regularMarketChangePercent || 0;
        return {
          ticker,
          companyName: quote.shortName || quote.longName || COMPANY_NAMES[ticker] || ticker,
          price: quote.regularMarketPrice,
          changePercent
        };
      }
    } catch (error) {
      console.error(`Error fetching ${ticker}:`, error.message);
    }
    return null;
  });

  const results = await Promise.all(quotePromises);

  for (const result of results) {
    if (result) {
      stockData.push(result);
    }
  }

  return stockData;
}

// Search for why a stock moved
async function searchStockMovementReason(ticker, companyName, changePercent) {
  const direction = changePercent > 0 ? 'up' : 'down';
  const changeAbs = Math.abs(changePercent).toFixed(1);

  const prompt = `Search for recent news explaining why ${companyName} (${ticker}) stock is ${direction} ${changeAbs}% today.

Find the PRIMARY reason for the stock movement. Look for:
- Earnings reports or guidance
- Analyst upgrades/downgrades
- Major news or announcements
- Industry/sector trends
- Macroeconomic factors affecting this stock

Provide a brief 1-2 sentence explanation of WHY the stock moved. Be specific and cite the actual reason. If you cannot find a specific reason, say "No specific news found for today's movement."`;

  try {
    const response = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: prompt
    });

    // Clean up the response
    let explanation = response.output_text
      .replace(/\(\[.*?\]\(.*?\)\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    // Limit length
    if (explanation.length > 300) {
      explanation = explanation.substring(0, 297) + '...';
    }

    return explanation;
  } catch (error) {
    console.error(`Error searching for ${ticker} movement reason:`, error);
    return 'Unable to determine reason for movement.';
  }
}

app.post('/api/portfolio-movers', async (req, res) => {
  const { index, tickers } = req.body;

  if (!index) {
    return res.status(400).json({ error: 'Index is required' });
  }

  if (index === 'CUSTOM' && (!tickers || tickers.length === 0)) {
    return res.status(400).json({ error: 'Tickers are required for custom portfolio' });
  }

  // Check cache first
  const cached = getCachedPortfolioData(index, tickers);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    // Get the list of tickers to analyze
    let tickerList;
    if (index === 'CUSTOM') {
      tickerList = tickers.map(t => t.toUpperCase());
    } else {
      tickerList = INDEX_CONSTITUENTS[index];
      if (!tickerList) {
        return res.status(400).json({ error: 'Invalid index' });
      }
    }

    console.log(`Fetching portfolio movers for ${index} (${tickerList.length} stocks)...`);

    // Check if before market open
    const useYesterday = isBeforeMarketOpen();
    if (useYesterday) {
      console.log('Before market open - will use yesterday\'s data');
    }

    // Fetch stock data
    const stockData = await fetchStockData(tickerList);
    console.log(`Fetched data for ${stockData.length} stocks`);

    // Filter for stocks with |change| >= 5%
    const significantMovers = stockData.filter(s => Math.abs(s.changePercent) >= 5);
    console.log(`Found ${significantMovers.length} stocks with >= 5% movement`);

    // Separate winners and losers
    const winners = significantMovers
      .filter(s => s.changePercent > 0)
      .sort((a, b) => b.changePercent - a.changePercent);

    const losers = significantMovers
      .filter(s => s.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent);

    // Fetch explanations for movers (limit to top 5 each to avoid too many API calls)
    const winnersToExplain = winners.slice(0, 5);
    const losersToExplain = losers.slice(0, 5);

    console.log(`Searching for explanations (${winnersToExplain.length} winners, ${losersToExplain.length} losers)...`);

    // Fetch explanations with rate limiting (batches of 3)
    const allToExplain = [...winnersToExplain, ...losersToExplain];
    const batchSize = 3;

    for (let i = 0; i < allToExplain.length; i += batchSize) {
      const batch = allToExplain.slice(i, i + batchSize);
      console.log(`Processing explanation batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allToExplain.length / batchSize)}...`);

      await Promise.all(batch.map(async (stock) => {
        stock.explanation = await searchStockMovementReason(stock.ticker, stock.companyName, stock.changePercent);
      }));

      // Add delay between batches (except for the last batch)
      if (i + batchSize < allToExplain.length) {
        console.log('Waiting 5 seconds before next batch to avoid rate limits...');
        await delay(5000);
      }
    }

    // For stocks beyond top 5, add generic explanation
    for (const stock of winners.slice(5)) {
      stock.explanation = 'No detailed analysis available for this stock.';
    }
    for (const stock of losers.slice(5)) {
      stock.explanation = 'No detailed analysis available for this stock.';
    }

    // Format the response
    const asOf = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }) + ' ET';

    const result = {
      winners,
      losers,
      asOf,
      totalStocksAnalyzed: stockData.length,
      useYesterdayData: useYesterday
    };

    // Cache the result
    savePortfolioToCache(index, tickers, result);

    res.json({ ...result, cached: false });
  } catch (error) {
    console.error('Portfolio movers error:', error);
    res.status(500).json({ error: 'Failed to fetch portfolio movers' });
  }
});

// ============================================
// MARKET MOVERS ENDPOINT (Top 10 Gainers/Losers)
// ============================================

// Cache for market movers (smart TTL based on market hours)
const MARKET_MOVERS_CACHE_DIR = path.join(__dirname, 'cache', 'market-movers');

// Smart cache expiry helper - returns milliseconds until cache should expire
function getMarketCacheExpiry() {
  const now = new Date();

  // Get current time in ET
  const etOptions = { timeZone: 'America/New_York', hour12: false };
  const etString = now.toLocaleString('en-US', {
    ...etOptions,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // Parse ET time components
  const [datePart, timePart] = etString.split(', ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);

  // Get day of week in ET (0 = Sunday, 6 = Saturday)
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = etDate.getDay();

  const currentMinutes = hour * 60 + minute;
  const marketOpen = 9 * 60 + 30;  // 9:30 AM = 570 minutes
  const marketClose = 16 * 60;      // 4:00 PM = 960 minutes

  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isDuringMarketHours = isWeekday && currentMinutes >= marketOpen && currentMinutes < marketClose;

  if (isDuringMarketHours) {
    // During market hours: cache for 30 minutes
    console.log('Market is OPEN - using 30 minute cache TTL');
    return 30 * 60 * 1000; // 30 minutes in ms
  }

  // Calculate time until next market open
  let daysUntilOpen = 0;

  if (dayOfWeek === 0) {
    // Sunday -> Monday
    daysUntilOpen = 1;
  } else if (dayOfWeek === 6) {
    // Saturday -> Monday
    daysUntilOpen = 2;
  } else if (dayOfWeek === 5 && currentMinutes >= marketClose) {
    // Friday after close -> Monday
    daysUntilOpen = 3;
  } else if (currentMinutes >= marketClose) {
    // Weekday after close -> next day
    daysUntilOpen = 1;
  } else if (currentMinutes < marketOpen) {
    // Weekday before open -> same day
    daysUntilOpen = 0;
  }

  // Calculate milliseconds until 9:30 AM ET on next market open day
  const msUntilMidnight = ((24 * 60) - currentMinutes) * 60 * 1000;
  const msFromMidnightToOpen = marketOpen * 60 * 1000;
  const msForFullDays = Math.max(0, daysUntilOpen - 1) * 24 * 60 * 60 * 1000;

  let msUntilOpen;
  if (daysUntilOpen === 0) {
    // Same day, before market open
    msUntilOpen = (marketOpen - currentMinutes) * 60 * 1000;
  } else {
    msUntilOpen = msUntilMidnight + msForFullDays + msFromMidnightToOpen;
  }

  // Add a small buffer (1 minute) to ensure we don't hit cache right before open
  msUntilOpen += 60 * 1000;

  const hoursUntilOpen = (msUntilOpen / (1000 * 60 * 60)).toFixed(1);
  console.log(`Market is CLOSED - caching until next market open (${hoursUntilOpen} hours)`);

  return msUntilOpen;
}

// Check if cache is still valid based on market-aware expiry
function isMarketMoversCacheValid(timestamp) {
  const now = new Date();
  const cacheTime = new Date(timestamp);

  // Get current time in ET
  const etOptions = { timeZone: 'America/New_York', hour12: false };
  const nowETString = now.toLocaleString('en-US', {
    ...etOptions,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const cacheETString = cacheTime.toLocaleString('en-US', {
    ...etOptions,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Parse ET time components
  const [nowDatePart, nowTimePart] = nowETString.split(', ');
  const [nowHour, nowMinute] = nowTimePart.split(':').map(Number);
  const [cacheDatePart, cacheTimePart] = cacheETString.split(', ');
  const [cacheHour, cacheMinute] = cacheTimePart.split(':').map(Number);

  const nowET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const cacheET = new Date(cacheTime.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = nowET.getDay();

  const nowMinutes = nowHour * 60 + nowMinute;
  const cacheMinutes = cacheHour * 60 + cacheMinute;
  const marketOpen = 9 * 60 + 30;  // 9:30 AM = 570 minutes
  const marketClose = 16 * 60;      // 4:00 PM = 960 minutes

  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isDuringMarketHours = isWeekday && nowMinutes >= marketOpen && nowMinutes < marketClose;

  // During market hours: cache is valid for 30 minutes
  if (isDuringMarketHours) {
    const cacheAge = Date.now() - timestamp;
    const thirtyMinutes = 30 * 60 * 1000;
    return cacheAge < thirtyMinutes;
  }

  // Market is closed - cache is valid if created after last market close
  // Key: Check if cache was created during or after the most recent trading session

  // Find the most recent market close time
  let lastMarketClose = new Date(nowET);

  if (dayOfWeek === 0) {
    // Sunday - last close was Friday 4 PM
    lastMarketClose.setDate(lastMarketClose.getDate() - 2);
    lastMarketClose.setHours(16, 0, 0, 0);
  } else if (dayOfWeek === 6) {
    // Saturday - last close was Friday 4 PM
    lastMarketClose.setDate(lastMarketClose.getDate() - 1);
    lastMarketClose.setHours(16, 0, 0, 0);
  } else if (nowMinutes < marketOpen) {
    // Weekday before market open - last close was previous trading day 4 PM
    if (dayOfWeek === 1) {
      // Monday before open - last close was Friday
      lastMarketClose.setDate(lastMarketClose.getDate() - 3);
    } else {
      // Tue-Fri before open - last close was yesterday
      lastMarketClose.setDate(lastMarketClose.getDate() - 1);
    }
    lastMarketClose.setHours(16, 0, 0, 0);
  } else {
    // Weekday after market close - last close was today 4 PM
    lastMarketClose.setHours(16, 0, 0, 0);
  }

  // Cache is valid if it was created after the last market close
  // This means we have post-close data that's still relevant
  const cacheIsAfterLastClose = cacheET >= lastMarketClose;

  if (cacheIsAfterLastClose) {
    console.log('Cache is valid - created after last market close');
    return true;
  }

  // Cache predates last market close - it's stale
  console.log('Cache is stale - created before last market close');
  return false;
}

// Ensure market movers cache directory exists
if (!fs.existsSync(MARKET_MOVERS_CACHE_DIR)) {
  fs.mkdirSync(MARKET_MOVERS_CACHE_DIR, { recursive: true });
}


// Full S&P 500 constituents (~500 stocks)
const SP500_STOCKS = [
  // Information Technology
  'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'AMD', 'ADBE', 'ACN', 'CSCO',
  'INTC', 'QCOM', 'TXN', 'IBM', 'INTU', 'AMAT', 'NOW', 'MU', 'ADI', 'LRCX',
  'SNPS', 'KLAC', 'CDNS', 'APH', 'MSI', 'FTNT', 'ROP', 'TEL', 'ADSK', 'PANW',
  'NXPI', 'MCHP', 'HPQ', 'KEYS', 'ANSS', 'FSLR', 'IT', 'MPWR', 'ON', 'CDW',
  'TYL', 'ZBRA', 'GLW', 'TDY', 'STX', 'NTAP', 'SWKS', 'PTC', 'EPAM', 'TRMB',
  'JNPR', 'WDC', 'AKAM', 'ENPH', 'GEN', 'FFIV', 'QRVO', 'HPE', 'CTSH',
  // Financials
  'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'SPGI', 'MS', 'AXP', 'BLK',
  'C', 'SCHW', 'CB', 'PGR', 'MMC', 'ICE', 'CME', 'AON', 'MCO', 'PNC',
  'AJG', 'USB', 'TFC', 'MET', 'TRV', 'AIG', 'AFL', 'ALL', 'COIN', 'BK',
  'PRU', 'COF', 'AMP', 'DFS', 'MSCI', 'FIS', 'MTB', 'HIG', 'FITB', 'STT',
  'RJF', 'WRB', 'FRC', 'HBAN', 'CFG', 'RF', 'NDAQ', 'NTRS', 'KEY', 'CINF',
  'CBOE', 'SIVB', 'BRO', 'SYF', 'L', 'WTW', 'RE', 'TROW', 'GL', 'ACGL',
  'AIZ', 'LNC', 'IVZ', 'ZION', 'BEN', 'MKTX', 'FNF',
  // Healthcare
  'UNH', 'LLY', 'JNJ', 'MRK', 'ABBV', 'TMO', 'ABT', 'PFE', 'DHR', 'BMY',
  'AMGN', 'ELV', 'MDT', 'ISRG', 'GILD', 'CI', 'SYK', 'VRTX', 'REGN', 'CVS',
  'BSX', 'ZTS', 'HUM', 'BDX', 'MCK', 'HCA', 'EW', 'A', 'DXCM', 'IDXX',
  'IQV', 'MTD', 'BIIB', 'CNC', 'ILMN', 'RMD', 'CAH', 'ZBH', 'LH', 'WAT',
  'WBA', 'GEHC', 'ABC', 'HOLX', 'DGX', 'BAX', 'ALGN', 'STE', 'VTRS', 'MOH',
  'TECH', 'INCY', 'CRL', 'RVTY', 'COO', 'TFX', 'PODD', 'HSIC', 'OGN', 'BIO',
  'DVA', 'XRAY',
  // Consumer Discretionary
  'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'BKNG', 'TJX', 'SBUX', 'CMG',
  'MAR', 'ORLY', 'AZO', 'GM', 'F', 'ROST', 'HLT', 'YUM', 'DHI', 'LEN',
  'EBAY', 'APTV', 'NVR', 'LVS', 'GRMN', 'DRI', 'POOL', 'PHM', 'RCL', 'CCL',
  'ULTA', 'TSCO', 'DECK', 'BWA', 'GPC', 'KMX', 'EXPE', 'MGM', 'BBWI', 'TPR',
  'ETSY', 'LKQ', 'WYNN', 'CZR', 'HAS', 'WHR', 'RL', 'NCLH', 'MHK', 'AAP',
  'PENN', 'VFC', 'NWL', 'ABNB', 'DPZ', 'LULU',
  // Communication Services
  'GOOGL', 'GOOG', 'META', 'NFLX', 'DIS', 'CMCSA', 'VZ', 'T', 'TMUS', 'CHTR',
  'EA', 'ATVI', 'WBD', 'TTWO', 'OMC', 'LYV', 'IPG', 'MTCH', 'DISH', 'PARA',
  'FOXA', 'FOX', 'NWS', 'NWSA', 'LUMN',
  // Consumer Staples
  'PG', 'KO', 'PEP', 'COST', 'WMT', 'PM', 'MO', 'MDLZ', 'CL', 'TGT',
  'EL', 'GIS', 'KMB', 'STZ', 'SYY', 'ADM', 'KDP', 'HSY', 'K', 'MKC',
  'KHC', 'CHD', 'CLX', 'CAG', 'HRL', 'TSN', 'SJM', 'TAP', 'LW', 'CPB',
  'BG', 'BF.B', 'DG', 'DLTR', 'KR', 'WBA',
  // Industrials
  'CAT', 'RTX', 'DE', 'UNP', 'HON', 'UPS', 'BA', 'GE', 'LMT', 'ADP',
  'ETN', 'WM', 'ITW', 'EMR', 'NOC', 'GD', 'FDX', 'CSX', 'PH', 'NSC',
  'PCAR', 'TT', 'CTAS', 'JCI', 'CARR', 'OTIS', 'GWW', 'CMI', 'AME', 'FAST',
  'CPRT', 'VRSK', 'RSG', 'ODFL', 'PAYX', 'XYL', 'EFX', 'HWM', 'DOV', 'PWR',
  'IR', 'FTV', 'ROK', 'WAB', 'IEX', 'LHX', 'SWK', 'TDG', 'HUBB', 'BR',
  'JBHT', 'DAL', 'LUV', 'URI', 'MAS', 'EXPD', 'BALL', 'ALK', 'PNR', 'J',
  'UAL', 'AAL', 'NDSN', 'GNRC', 'TXT', 'CHRW', 'ALLE', 'AOS', 'SNA', 'LDOS',
  'PAYC', 'RHI', 'GPN', 'AXON', 'BLDR', 'FICO', 'CSGP', 'CBOE',
  // Energy
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PXD', 'PSX', 'VLO', 'OXY',
  'WMB', 'HES', 'KMI', 'DVN', 'HAL', 'OKE', 'FANG', 'BKR', 'TRGP', 'CTRA',
  'MRO', 'EQT', 'APA', 'MTDR', 'PR',
  // Materials
  'LIN', 'APD', 'SHW', 'FCX', 'NEM', 'ECL', 'DOW', 'NUE', 'CTVA', 'DD',
  'PPG', 'VMC', 'MLM', 'ALB', 'IFF', 'LYB', 'FMC', 'CE', 'BALL', 'AVY',
  'IP', 'PKG', 'EMN', 'CF', 'MOS', 'SEE', 'WRK', 'AMCR',
  // Utilities
  'NEE', 'SO', 'DUK', 'SRE', 'AEP', 'D', 'EXC', 'XEL', 'PCG', 'ED',
  'PEG', 'WEC', 'ES', 'EIX', 'AWK', 'DTE', 'ETR', 'FE', 'AEE', 'PPL',
  'CMS', 'CEG', 'CNP', 'EVRG', 'ATO', 'NI', 'LNT', 'NRG', 'PNW', 'AES',
  // Real Estate
  'PLD', 'AMT', 'CCI', 'EQIX', 'PSA', 'O', 'WELL', 'SPG', 'DLR', 'VICI',
  'AVB', 'EQR', 'SBAC', 'WY', 'ARE', 'VTR', 'EXR', 'IRM', 'MAA', 'DRE',
  'ESS', 'UDR', 'INVH', 'HST', 'PEAK', 'KIM', 'CPT', 'REG', 'BXP', 'FRT',
  'CBRE', 'CSGP', 'DOC',
  // Additional S&P 500 constituents
  'UBER', 'PYPL', 'SQ', 'SHOP', 'NOW', 'SNOW', 'TEAM', 'ZS', 'CRWD',
  'DDOG', 'NET', 'MDB', 'OKTA', 'ZM', 'DOCU', 'ROKU', 'SNAP', 'PINS', 'TWTR',
  'PLTR', 'PATH', 'RIVN', 'LCID', 'NIO', 'MRVL', 'ARM', 'SMCI', 'DELL', 'LULU'
];

// Nasdaq 100 constituents
const NASDAQ_100_STOCKS = [
  'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'TSLA', 'AVGO', 'COST', 'ASML',
  'NFLX', 'AMD', 'PEP', 'ADBE', 'CSCO', 'TMUS', 'INTC', 'CMCSA', 'TXN', 'QCOM',
  'INTU', 'AMGN', 'HON', 'AMAT', 'ISRG', 'BKNG', 'SBUX', 'VRTX', 'GILD', 'ADP',
  'MDLZ', 'REGN', 'LRCX', 'ADI', 'PANW', 'MU', 'KLAC', 'SNPS', 'CDNS', 'PYPL',
  'MELI', 'MAR', 'ORLY', 'ABNB', 'CTAS', 'CRWD', 'MRVL', 'NXPI', 'CSX', 'PCAR',
  'CHTR', 'FTNT', 'MNST', 'AEP', 'PAYX', 'DXCM', 'ROST', 'WDAY', 'CPRT', 'MRNA',
  'KDP', 'ODFL', 'KHC', 'AZN', 'MCHP', 'IDXX', 'FAST', 'GEHC', 'EA', 'EXC',
  'LULU', 'CTSH', 'VRSK', 'DLTR', 'BKR', 'BIIB', 'XEL', 'CSGP', 'FANG', 'DDOG',
  'TEAM', 'ANSS', 'ILMN', 'ON', 'WBD', 'ZS', 'TTWO', 'CDW', 'GFS', 'WBA',
  'ALGN', 'SIRI', 'ENPH', 'ZM', 'LCID', 'RIVN', 'JD', 'PDD', 'SPLK', 'OKTA'
];

// Russell 2000 - using a representative subset (top holdings + additional small caps)
const RUSSELL_2000_STOCKS = [
  // Top Russell 2000 holdings
  'SMCI', 'CORT', 'CELH', 'CVNA', 'MEDP', 'ONTO', 'FN', 'CRVL', 'RMBS', 'OII',
  'AMR', 'BCC', 'CALM', 'BOOT', 'UFPI', 'VIRT', 'ACIW', 'NSIT', 'LNTH', 'COOP',
  'REZI', 'RBC', 'PIPR', 'UPST', 'KTOS', 'HALO', 'AVNT', 'PTEN', 'CRS', 'APOG',
  'SIG', 'PRFT', 'WINA', 'SANM', 'DIOD', 'CABO', 'SPXC', 'MTH', 'SHAK', 'NTNX',
  'NVAX', 'WOLF', 'DV', 'RXRX', 'TTMI', 'KURA', 'MGNI', 'TASK', 'ASGN', 'EVH',
  'CHEF', 'BCPC', 'PINC', 'BL', 'AZTA', 'COMP', 'AGYS', 'CYTK', 'FORM', 'SPSC',
  'ENR', 'RCUS', 'TMHC', 'VECO', 'TFIN', 'VITL', 'ETSY', 'DKNG', 'PLUG', 'FROG',
  'SMAR', 'GTLB', 'ESTC', 'TENB', 'BILL', 'PCOR', 'CFLT', 'PATH', 'MNDY', 'VEEV',
  'DOCN', 'APPN', 'ASAN', 'RNG', 'COUP', 'FIVN', 'GWRE', 'NCNO', 'KD', 'VRNS',
  'ALTR', 'FRSH', 'JAMF', 'QTWO', 'LITE', 'SITM', 'AEHR', 'PRGS', 'NTNX', 'PD'
];

// Index configuration mapping
const INDEX_CONFIG = {
  sp500: { name: 'S&P 500', stocks: SP500_STOCKS },
  nasdaq: { name: 'Nasdaq 100', stocks: NASDAQ_100_STOCKS },
  russell: { name: 'Russell 2000', stocks: RUSSELL_2000_STOCKS }
};

function getMarketMoversCachePath(index = 'sp500') {
  const today = new Date().toISOString().split('T')[0];
  return path.join(MARKET_MOVERS_CACHE_DIR, `movers_${index}_${today}.json`);
}

function getMarketMoversPricesCachePath(index = 'sp500') {
  const today = new Date().toISOString().split('T')[0];
  return path.join(MARKET_MOVERS_CACHE_DIR, `prices_${index}_${today}.json`);
}

function getCachedMarketMovers(index = 'sp500') {
  let cachePath = getMarketMoversCachePath(index);

  // If today's cache doesn't exist (e.g., weekends), fall back to most recent cache file
  if (!fs.existsSync(cachePath)) {
    const files = fs.readdirSync(MARKET_MOVERS_CACHE_DIR)
      .filter(f => f.startsWith(`movers_${index}_`) && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length > 0) {
      cachePath = path.join(MARKET_MOVERS_CACHE_DIR, files[0]);
      console.log(`[Market Movers] Today's cache not found, using most recent: ${files[0]}`);
    } else {
      return null;
    }
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.timestamp;
    const ageMinutes = ageMs / (1000 * 60);

    // ALWAYS return cached data if it exists - never trigger regeneration on user request
    // Cache freshness only matters for scheduled refresh, not for serving users
    console.log(`Using cached market movers for ${index} (cached ${ageMinutes.toFixed(1)} minutes ago)`);

    // Dynamically add hasTranscript field (transcript availability may have changed since cache)
    const data = cached.data;
    if (data.gainers) {
      data.gainers = data.gainers.map(stock => ({
        ...stock,
        hasTranscript: hasEarningsTranscript(stock.ticker)
      }));
    }
    if (data.losers) {
      data.losers = data.losers.map(stock => ({
        ...stock,
        hasTranscript: hasEarningsTranscript(stock.ticker)
      }));
    }
    return data;
  } catch (error) {
    console.error('Error reading market movers cache:', error);
    return null;
  }
}

function saveMarketMoversToCache(data, index = 'sp500') {
  const cachePath = getMarketMoversCachePath(index);
  const cacheData = {
    data,
    timestamp: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log(`Cached market movers data for ${index}`);
  } catch (error) {
    console.error('Error writing market movers cache:', error);
  }
}

// Helper function to extract thesis from cached initiation report
function getThesisFromCachedReport(ticker) {
  const cachePath = path.join(CACHE_DIR, `${ticker.toUpperCase()}.json`);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.timestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > CACHE_MAX_AGE_DAYS) {
      return null; // Cache expired
    }

    // Extract thesis from the report (Markdown format)
    const report = cached.report || cached.html;
    if (!report) {
      return null;
    }

    // Look for "## Investment Thesis" section in Markdown
    const thesisMatch = report.match(/## Investment Thesis\s*\n\n([\s\S]*?)(?=\n\n##|$)/);
    if (thesisMatch) {
      let thesis = thesisMatch[1].trim();
      console.log(`Found cached thesis for ${ticker} from Markdown report`);
      return {
        thesis,
        hasFullReport: true,
        reportAge: ageDays
      };
    }

    // Fallback: try HTML format (legacy)
    const htmlMatch = report.match(/<div class="thesis-text"[^>]*>([\s\S]*?)<\/div>/);
    if (htmlMatch) {
      let thesis = htmlMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        thesis,
        hasFullReport: true,
        reportAge: ageDays
      };
    }

    return null;
  } catch (error) {
    console.error(`Error reading cached report for ${ticker}:`, error);
    return null;
  }
}

// Helper function to generate a brief investment thesis using OpenAI
async function generateBriefThesis(ticker, companyName) {
  const name = companyName || COMPANY_NAMES[ticker] || ticker;

  try {
    const thesisPrompt = `Write a one-paragraph investment thesis for ${name} (${ticker}).

REQUIREMENTS:
- One solid paragraph, 4-6 sentences
- Aggressive, confident, punchy tone
- Short sentences. No fluff. No filler.
- Cover: what the company does, why it's compelling, competitive advantages, growth drivers
- Sound like a conviction buy from a top hedge fund analyst

STYLE TO MATCH (this is the exact tone you must replicate):
"Palantir owns government AI. No competitor comes close in defense and intelligence. Commercial segment is exploding. Foundry platform is sticky - once you're in, you don't leave. AIP is the next growth engine. Trading at a premium but dominance justifies valuation."

"NVIDIA dominates AI-driven data centers. Its proprietary GPUs are unrivaled. Acceleration in AI growth positions NVIDIA for exponential scale."

FORBIDDEN - NEVER USE:
- "represents an investment opportunity"
- "further analysis recommended"
- "we believe"
- "attractive positioning"
- "favorable dynamics"
- Any hedging or wishy-washy language

Write the thesis now as one paragraph:`;

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [
        { role: 'user', content: thesisPrompt }
      ]
    });
    logTokenUsage('thematic', response.usage);

    let thesis = response.choices[0].message.content.trim();
    // Clean up any markdown or formatting
    thesis = thesis.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^["']|["']$/g, '').trim();

    return {
      thesis,
      hasFullReport: false,
      generated: true
    };
  } catch (error) {
    console.error(`Error generating thesis for ${ticker}:`, error);
    return {
      thesis: `${name} is a category leader with strong competitive moats. Growth trajectory remains intact. Management is executing.`,
      hasFullReport: false,
      generated: true,
      error: true
    };
  }
}

// Helper function to get thesis for a stock (from cache or generate new)
async function getStockThesis(ticker, companyName) {
  // First check for cached initiation report
  const cachedThesis = getThesisFromCachedReport(ticker);
  if (cachedThesis) {
    console.log(`Found cached thesis for ${ticker}`);
    return cachedThesis;
  }

  // Generate brief thesis if no cached report
  console.log(`Generating brief thesis for ${ticker}`);
  return await generateBriefThesis(ticker, companyName);
}

// Generate stock explanation using Finnhub news API + GPT-4o-mini
async function generateStockExplanation(ticker, companyName, changePercent) {
  try {
    const direction = changePercent > 0 ? 'up' : 'down';
    const changeAbs = Math.abs(changePercent).toFixed(2);
    const name = companyName || COMPANY_NAMES[ticker] || ticker;

    // Get or generate company description (permanently cached)
    const companyDescription = await getOrGenerateCompanyDescription(ticker, name);

    // Get news headlines from Finnhub (fast, cheap)
    const headlines = await getFinnhubNews(ticker);

    let catalyst;

    if (headlines) {
      // Use GPT-4o-mini to extract catalyst from headlines (cheap)
      const prompt = `${name} (${ticker}) stock is ${direction} ${changeAbs}% today.

Recent headlines:
${headlines}

Write ONE sentence (15-25 words) explaining the likely catalyst for today's move based on these headlines.

REQUIREMENTS:
- Be specific with numbers if available
- Start directly with the catalyst, not the company name
- NO hedging or vague language
- Do NOT mention the stock is up/down X%
- Just ONE sentence

Write ONE catalyst sentence:`;

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      });
      logTokenUsage('top-movers', response.usage, 'gpt-4o-mini');

      catalyst = response.choices[0].message.content.trim();
    } else {
      // Fallback: use GPT-4o-mini with just the stock info (no news)
      const prompt = `${name} (${ticker}) stock is ${direction} ${changeAbs}% today. Write ONE sentence (15-25 words) with a plausible catalyst. Be specific. Just the sentence:`;

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      });
      logTokenUsage('top-movers', response.usage, 'gpt-4o-mini');

      catalyst = response.choices[0].message.content.trim();
    }

    // Clean up the catalyst
    catalyst = catalyst
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/^["']|["']$/g, '')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Ensure catalyst ends with a period
    if (catalyst && !catalyst.match(/[.!?]$/)) {
      catalyst += '.';
    }

    // Validate catalyst isn't too short or just company name
    if (!catalyst || catalyst.length < 20 || catalyst.toLowerCase().includes('i cannot') || catalyst.toLowerCase().includes('i could not')) {
      catalyst = 'Recent market developments and trading activity driving the move.';
    }

    // Combine catalyst + company description
    const analysis = `${catalyst} ${companyDescription}`;

    const result = {
      ticker,
      companyName: name,
      changePercent: changePercent,
      analysis,
      generatedAt: new Date().toISOString()
    };

    return { explanation: analysis };
  } catch (error) {
    console.error(`Error generating explanation for ${ticker}:`, error);
    const direction = changePercent > 0 ? 'higher' : 'lower';
    const changeAbs = Math.abs(changePercent).toFixed(2);
    const name = companyName || COMPANY_NAMES[ticker] || ticker;
    return {
      explanation: `Real-time analysis temporarily unavailable. ${name} is a publicly traded company. Check financial news for the latest developments.`,
      cached: false,
      error: true
    };
  }
}

// GET /api/market-movers - Returns Top 10 gainers and losers with pre-generated explanations
// Accepts optional ?index= query param: sp500 (default), nasdaq, russell
// Accepts optional ?refresh=true to force refresh (otherwise returns cached data)
// New data is also generated during scheduled refresh times (9:31, 11:31, 1:31, 3:31, 4:00 PM ET)
app.get('/api/market-movers', async (req, res) => {
  // Get index from query param, default to sp500
  const indexParam = (req.query.index || 'sp500').toLowerCase();
  const forceRefresh = req.query.refresh === 'true';
  const indexConfig = INDEX_CONFIG[indexParam];

  if (!indexConfig) {
    return res.status(400).json({
      error: 'Invalid index. Valid options: sp500, nasdaq, russell'
    });
  }

  const { name: indexName } = indexConfig;

  // If refresh=true, generate fresh data
  if (forceRefresh) {
    console.log(`[Market Movers] Manual refresh requested for ${indexParam}`);
    try {
      await refreshMarketMoversForIndex(indexParam);
      const freshData = getCachedMarketMovers(indexParam);
      if (freshData) {
        return res.json({ ...freshData, cached: false, index: indexParam, indexName });
      }
    } catch (error) {
      console.error(`[Market Movers] Error during manual refresh for ${indexParam}:`, error.message);
      return res.status(500).json({
        error: 'Failed to refresh market movers data',
        message: error.message,
        index: indexParam,
        indexName
      });
    }
  }

  // Return cached data if it exists
  const cached = getCachedMarketMovers(indexParam);
  if (cached) {
    return res.json({ ...cached, cached: true, index: indexParam, indexName });
  }

  // No cache exists - return error instead of generating (generation happens on schedule only)
  console.log(`[Market Movers] No cache available for ${indexParam} - returning 503`);
  return res.status(503).json({
    error: 'Data not yet available. Please try again later.',
    message: 'Market data is refreshed at 9:31 AM, 11:31 AM, 1:31 PM, 3:31 PM, and 4:00 PM ET.',
    index: indexParam,
    indexName
  });
});


// ============================================
// THEMATIC INVESTMENTS API
// ============================================

// Predefined stock lists for each theme
const THEMATIC_STOCKS = {
  ai: ['NVDA', 'MSFT', 'GOOGL', 'META', 'AMZN'],
  quantum: ['IONQ', 'RGTI', 'QBTS', 'IBM', 'GOOGL'],
  gold: ['GLD', 'NEM', 'GOLD', 'AEM', 'FNV'],
  clean_energy: ['ENPH', 'SEDG', 'FSLR', 'RUN', 'PLUG'],
  cybersecurity: ['CRWD', 'PANW', 'ZS', 'FTNT', 'OKTA'],
  semiconductors: ['NVDA', 'AMD', 'AVGO', 'QCOM', 'INTC'],
  space: ['LMT', 'RTX', 'NOC', 'BA', 'RKLB'],
  biotech: ['MRNA', 'REGN', 'VRTX', 'BIIB', 'GILD']
};

const THEME_NAMES = {
  ai: 'AI / Artificial Intelligence',
  quantum: 'Quantum Computing',
  gold: 'Gold / Precious Metals',
  clean_energy: 'Clean Energy / Renewables',
  cybersecurity: 'Cybersecurity',
  semiconductors: 'Semiconductors',
  space: 'Space / Aerospace',
  biotech: 'Biotech / Genomics'
};

// Thematic cache (30 days)
const THEMATIC_CACHE_DIR = path.join(__dirname, 'cache', 'thematic');
const THEMATIC_CACHE_MAX_AGE_DAYS = 30;

if (!fs.existsSync(THEMATIC_CACHE_DIR)) {
  fs.mkdirSync(THEMATIC_CACHE_DIR, { recursive: true });
}

function getThematicCachePath(theme) {
  return path.join(THEMATIC_CACHE_DIR, `${theme}.json`);
}

function getCachedThematic(theme) {
  const cachePath = getThematicCachePath(theme);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= THEMATIC_CACHE_MAX_AGE_DAYS) {
      console.log(`Using cached thematic data for ${theme} (cached ${ageDays.toFixed(1)} days ago)`);
      return cached.data;
    }
    return null;
  } catch (error) {
    console.error('Error reading thematic cache:', error);
    return null;
  }
}

function saveThematicToCache(theme, data) {
  const cachePath = getThematicCachePath(theme);
  const cacheData = {
    theme,
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log(`Cached thematic data for ${theme}`);
  } catch (error) {
    console.error('Error writing thematic cache:', error);
  }
}

// GET /api/thematic/:theme
app.get('/api/thematic/:theme', async (req, res) => {
  const theme = req.params.theme.toLowerCase();

  if (!THEMATIC_STOCKS[theme]) {
    return res.status(400).json({ error: 'Invalid theme. Valid themes: ' + Object.keys(THEMATIC_STOCKS).join(', ') });
  }

  // Check cache first
  const cached = getCachedThematic(theme);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const tickers = THEMATIC_STOCKS[theme];
    const themeName = THEME_NAMES[theme];

    // Get company names from Yahoo Finance
    const stocksWithNames = await Promise.all(tickers.map(async (ticker) => {
      try {
        const quote = await yahooFinance.quote(ticker);
        return {
          ticker,
          companyName: quote?.shortName || quote?.longName || ticker
        };
      } catch (err) {
        console.log(`Failed to get quote for ${ticker}:`, err.message);
        return { ticker, companyName: ticker };
      }
    }));

    // Generate overviews for all stocks using GPT-4o (with rate limiting)
    // Process in batches of 3 to avoid OpenAI rate limits
    const batchSize = 3;
    const stocksWithOverview = [];

    for (let i = 0; i < stocksWithNames.length; i += batchSize) {
      const batch = stocksWithNames.slice(i, i + batchSize);
      console.log(`Generating overviews batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(stocksWithNames.length / batchSize)}...`);

      const batchResults = await Promise.all(batch.map(async (stock) => {
        try {
          const prompt = `You are a Goldman Sachs equity research analyst. Write a single paragraph (3-4 sentences) explaining why ${stock.companyName} (${stock.ticker}) is a good investment for exposure to the ${themeName} theme.

Focus on:
- How the company is positioned in this theme
- Key competitive advantages or moats
- Growth drivers specific to this theme
- Why it stands out among peers

Write in professional, confident Goldman Sachs analyst style. Be specific with facts and avoid hedging language. Do not use bullet points.`;

          const response = await client.chat.completions.create({
            model: 'gpt-4o',
            max_tokens: 300,
            messages: [{ role: 'user', content: prompt }]
          });
          logTokenUsage('thematic', response.usage);

          return {
            ...stock,
            overview: response.choices[0].message.content.trim()
          };
        } catch (err) {
          console.error(`Failed to generate overview for ${stock.ticker}:`, err.message);
          return {
            ...stock,
            overview: `${stock.companyName} is a key player in the ${themeName} space, offering investors direct exposure to this high-growth sector.`
          };
        }
      }));

      stocksWithOverview.push(...batchResults);

      // Add delay between batches (except for the last batch)
      if (i + batchSize < stocksWithNames.length) {
        console.log('Waiting 5 seconds before next batch to avoid rate limits...');
        await delay(5000);
      }
    }

    // Generate thesis for each stock (from cache or generate new) with rate limiting
    const thesisResults = [];

    for (let i = 0; i < stocksWithOverview.length; i += batchSize) {
      const batch = stocksWithOverview.slice(i, i + batchSize);
      console.log(`Generating thesis batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(stocksWithOverview.length / batchSize)}...`);

      const batchThesis = await Promise.all(
        batch.map(stock => getStockThesis(stock.ticker, stock.companyName))
      );

      thesisResults.push(...batchThesis);

      // Add delay between batches (except for the last batch)
      if (i + batchSize < stocksWithOverview.length) {
        console.log('Waiting 5 seconds before next batch to avoid rate limits...');
        await delay(5000);
      }
    }

    // Combine stocks with thesis data
    const stocks = stocksWithOverview.map((stock, i) => {
      const thesisData = thesisResults[i] || {
        thesis: stock.overview || 'Unable to generate thesis',
        hasFullReport: false
      };
      return {
        ...stock,
        thesis: thesisData.thesis,
        hasFullReport: thesisData.hasFullReport
      };
    });

    const result = {
      theme,
      themeName,
      stocks,
      generatedAt: new Date().toISOString()
    };

    // Cache the result
    saveThematicToCache(theme, result);

    res.json({ ...result, cached: false });
  } catch (error) {
    console.error(`Thematic API error for ${theme}:`, error);

    if (error.code === 'insufficient_quota' || error.status === 429) {
      res.status(503).json({
        error: 'AI service temporarily unavailable due to usage limits. Please try again in a few minutes.',
        errorCode: 'QUOTA_EXCEEDED'
      });
    } else {
      res.status(500).json({ error: 'Failed to generate thematic data' });
    }
  }
});

// ============================================
// Market Update API
// ============================================

// Market update cache (240 minutes / 4 hours - refreshes happen every 2 hours during market hours)
const MARKET_UPDATE_CACHE_DIR = path.join(__dirname, 'cache', 'market');
const MARKET_CACHE_MAX_AGE_MINUTES = 240;

if (!fs.existsSync(MARKET_UPDATE_CACHE_DIR)) {
  fs.mkdirSync(MARKET_UPDATE_CACHE_DIR, { recursive: true });
}

function getMarketCachePath() {
  return path.join(MARKET_UPDATE_CACHE_DIR, 'market-update.json');
}

function getCachedMarketUpdate() {
  const cachePath = getMarketCachePath();
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageMinutes = ageMs / (1000 * 60);

    if (ageMinutes <= MARKET_CACHE_MAX_AGE_MINUTES) {
      console.log(`Using cached market update (cached ${ageMinutes.toFixed(1)} minutes ago)`);
      return cached.data;
    }
    return null;
  } catch (error) {
    console.error('Error reading market cache:', error);
    return null;
  }
}

function saveMarketUpdateToCache(data) {
  const cachePath = getMarketCachePath();
  const cacheData = {
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log('Cached market update');
  } catch (error) {
    console.error('Error writing market cache:', error);
  }
}

// Helper function to check if earnings transcript exists for a ticker
// Only returns true if we have a RECENT transcript (current or previous quarter)
function hasEarningsTranscript(ticker) {
  const cachePath = path.join(EARNINGS_CACHE_DIR, `${ticker.toUpperCase()}_earnings.json`);

  if (!fs.existsSync(cachePath)) {
    return false;
  }

  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const transcripts = data?.data?.transcripts || data?.transcripts || [];

    if (transcripts.length === 0) {
      return false;
    }

    // Get current date to determine the relevant quarter
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12

    // Determine current quarter (Q1: Jan-Mar, Q2: Apr-Jun, Q3: Jul-Sep, Q4: Oct-Dec)
    let currentQuarter;
    if (currentMonth <= 3) currentQuarter = 1;
    else if (currentMonth <= 6) currentQuarter = 2;
    else if (currentMonth <= 9) currentQuarter = 3;
    else currentQuarter = 4;

    // Check if any transcript is from current quarter or previous quarter
    // (companies report results 1-2 months after quarter ends)
    for (const transcript of transcripts) {
      const tYear = transcript.year;
      const tQuarter = transcript.quarter;

      // Accept current quarter or previous quarter transcripts
      // For Q1 2026, accept Q4 2025 and Q1 2026
      // For Q4 2025, accept Q3 2025 and Q4 2025
      const isCurrentQuarter = (tYear === currentYear && tQuarter === currentQuarter);
      const isPreviousQuarter = (
        (tYear === currentYear && tQuarter === currentQuarter - 1) ||
        (currentQuarter === 1 && tYear === currentYear - 1 && tQuarter === 4)
      );

      if (isCurrentQuarter || isPreviousQuarter) {
        // Also verify the transcript has actual content
        if (transcript.transcript && transcript.transcript.length > 100) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    console.error(`Error checking earnings transcript for ${ticker}:`, error.message);
    return false;
  }
}

// Helper function to detect earnings-related keywords in a bullet point
function isEarningsRelated(text) {
  const earningsKeywords = [
    'earnings',
    'quarterly results',
    'beat estimates',
    'missed expectations',
    'eps',
    'revenue beat',
    'revenue miss',
    'guidance',
    'reported',
    'beat expectations',
    'topped estimates',
    'profit',
    'revenue growth',
    'q4',
    'q3',
    'q2',
    'q1',
    'quarter'
  ];

  const lowerText = text.toLowerCase();
  return earningsKeywords.some(keyword => lowerText.includes(keyword));
}

// Helper function to extract ticker from a driver text
function extractTickerFromDriver(text) {
  // Common patterns: "TICKER +X%", "TICKER (up/down X%)", "$TICKER", "ticker:"
  const tickerPatterns = [
    /\b([A-Z]{1,5})\s+[+\-−]?\d+\.?\d*%/,  // NVDA +5%
    /\$([A-Z]{1,5})\b/,                      // $NVDA
    /\b([A-Z]{1,5})\s+\(/,                   // NVDA (
    /\b([A-Z]{2,5})\s+(?:tumbles?|drops?|falls?|rises?|gains?|jumps?|surges?|soars?|slides?|plunges?|plummets?|crashes?|tanks?|nosedives?|rallies?|rockets?|spikes?|skyrockets?)\s+(?:over\s+|about\s+)?(\d+\.?\d*%)/i,  // NVDA tumbles 7.2%
    /\b([A-Z]{2,5})\b(?=.*(?:earnings|reported|beat|missed|guidance|quarter))/i  // NVDA ... earnings
  ];

  for (const pattern of tickerPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      // Exclude common words that look like tickers
      const excludeList = ['THE', 'AND', 'FOR', 'NOT', 'ARE', 'BUT', 'HAS', 'WAS', 'CEO', 'CFO', 'IPO', 'GDP', 'CPI', 'PPI', 'FED', 'ETF', 'BPS', 'YOY', 'QOQ', 'MOM'];
      if (!excludeList.includes(match[1])) {
        return match[1].toUpperCase();
      }
    }
  }
  return null;
}

// Helper function to extract price movement from a driver text
function extractPriceMove(text) {
  // Look for percentage patterns like +5.2%, -3.4%, up 5%, down 3%
  const positivePatterns = [
    /([+]\d+\.?\d*%)/,                                       // +5.2%
    /\b(up\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,           // up 5%, up over 5%
    /\b(gains?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // gains 5%, gains over 5%
    /\b(rises?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // rises 5%, rises over 5%
    /\b(jumps?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // jumps 5%, jumps over 5%
    /\b(surges?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,      // surges 5%, surges over 5%
    /\b(soars?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // soars 5%, soars over 5%
    /\b(climbs?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,      // climbs 5%, climbs over 5%
    /\b(adds?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,        // adds 5%, adds over 5%
    /\b(rockets?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,     // rockets 5%, rockets over 5%
    /\b(spikes?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,      // spikes 5%, spikes over 5%
    /\b(rallies?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,     // rallies 5%, rallies over 5%
    /\b(skyrockets?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i   // skyrockets 5%, skyrockets over 5%
  ];

  const negativePatterns = [
    /([\-−]\d+\.?\d*%)/,                                     // -5.2%
    /\b(down\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,         // down 5%, down over 5%
    /\b(drops?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // drops 5%, drops over 5%
    /\b(falls?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // falls 5%, falls over 5%
    /\b(loses?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // loses 5%, loses over 5%
    /\b(declines?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,    // declines 5%, declines over 5%
    /\b(sheds?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // sheds 5%, sheds over 5%
    /\b(slides?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,      // slides 5%, slides over 5%
    /\b(sinks?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,       // sinks 5%, sinks over 5%
    /\b(plunges?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,     // plunges 5%, plunges over 5%
    /\b(tumbles?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,     // tumbles 5%, tumbles over 5%
    /\b(plummets?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,    // plummets 5%, plummets over 5%
    /\b(crashes?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,     // crashes 5%, crashes over 5%
    /\b(nosedives?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i,   // nosedives 5%, nosedives over 5%
    /\b(tanks?\s+(?:over\s+|about\s+)?)(\d+\.?\d*%)/i        // tanks 5%, tanks over 5%
  ];

  // Check positive patterns first
  for (const pattern of positivePatterns) {
    const match = text.match(pattern);
    if (match) {
      if (match[2]) {
        return '+' + match[2];
      } else if (match[1]) {
        return match[1];
      }
    }
  }

  // Check negative patterns
  for (const pattern of negativePatterns) {
    const match = text.match(pattern);
    if (match) {
      if (match[2]) {
        return '-' + match[2];
      } else if (match[1]) {
        return match[1].replace('−', '-');
      }
    }
  }

  return null;
}

// Enrich drivers with earnings review metadata
function enrichDriversWithEarningsInfo(drivers) {
  return drivers.map(driver => {
    const driverObj = {
      text: driver,
      hasEarningsReview: false,
      ticker: null,
      priceMove: null
    };

    if (isEarningsRelated(driver)) {
      const ticker = extractTickerFromDriver(driver);
      if (ticker && hasEarningsTranscript(ticker)) {
        driverObj.hasEarningsReview = true;
        driverObj.ticker = ticker;
        driverObj.priceMove = extractPriceMove(driver) || '+0%';
      }
    }

    return driverObj;
  });
}

// GET /api/market-update
app.get('/api/market-update', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  // Check cache first (unless forcing refresh)
  if (!forceRefresh) {
    const cached = getCachedMarketUpdate();
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
  }

  try {
    // 1. Fetch index quotes using Yahoo Finance
    const indexSymbols = [
      { symbol: '^GSPC', name: 'S&P 500' },
      { symbol: '^IXIC', name: 'Nasdaq Composite' },
      { symbol: '^DJI', name: 'Dow Jones' }
    ];

    console.log('Fetching market indices...');
    const indices = await Promise.all(indexSymbols.map(async ({ symbol, name }) => {
      try {
        const quote = await yahooFinance.quote(symbol);
        return {
          symbol,
          name,
          price: quote.regularMarketPrice || 0,
          change: quote.regularMarketChange || 0,
          changePercent: quote.regularMarketChangePercent || 0
        };
      } catch (err) {
        console.error(`Failed to fetch ${symbol}:`, err.message);
        return {
          symbol,
          name,
          price: 0,
          change: 0,
          changePercent: 0
        };
      }
    }));

    // 2. Use web search to find today's market drivers
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    console.log('Searching for market drivers...');
    const searchPrompt = `Search for "stock market today ${dateStr} why moving", "stock market news ${dateStr}", and "biggest stock movers today ${dateStr} gainers losers". Find the main reasons why stocks are moving today - what headlines, earnings, economic data, or events are driving market action. Also find specific stocks with large price moves (5%+ gains or losses) and why they are moving.`;

    const searchResponse = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: searchPrompt
    });
    if (searchResponse.usage) logTokenUsage('market-update', searchResponse.usage);

    const searchResults = searchResponse.output_text;

    // 3. Use OpenAI to summarize into 10 bullet points
    console.log('Generating market summary...');
    const summaryPrompt = `You are a markets analyst writing a quick daily brief. Based on this market research, write 10 punchy bullet points explaining what's driving today's market action.

Research:
${searchResults}

Index Performance Today:
- S&P 500: ${indices[0].changePercent >= 0 ? '+' : ''}${indices[0].changePercent.toFixed(2)}%
- Nasdaq: ${indices[1].changePercent >= 0 ? '+' : ''}${indices[1].changePercent.toFixed(2)}%
- Dow Jones: ${indices[2].changePercent >= 0 ? '+' : ''}${indices[2].changePercent.toFixed(2)}%

Rules:
- Each bullet should be ONE sentence, max 20 words
- Be specific with stock names, percentages, and numbers
- Lead with the most important driver
- Aggressive, confident tone - no hedging language
- CRITICAL: Include specific individual stock movers with exact percentages (e.g., "NVDA +5.2%", "TSLA -6.8%")
- If a stock moved 5% or more today, it MUST be mentioned with its exact percentage
- Focus on WHY things are moving, not just that they moved
- At least 3-4 bullets should be about specific individual stock moves with percentages

Return ONLY a JSON array of strings with exactly 10 bullet points, like:
["First driver bullet point", "Second driver bullet point", "Third driver bullet point", ...]`;

    const summaryResponse = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [{ role: 'user', content: summaryPrompt }]
    });
    logTokenUsage('market-update', summaryResponse.usage);

    let drivers = [];
    try {
      const content = summaryResponse.choices[0].message.content.trim();
      // Extract JSON array from response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        drivers = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      console.error('Failed to parse drivers:', err.message);
      // Fallback: split by newlines if JSON parsing fails
      drivers = summaryResponse.choices[0].message.content
        .split('\n')
        .filter(line => line.trim().length > 0)
        .slice(0, 10);
    }

    // Enrich drivers with earnings review info
    const enrichedDrivers = enrichDriversWithEarningsInfo(drivers);

    const result = {
      indices,
      drivers: enrichedDrivers,
      asOf: new Date().toISOString()
    };

    // Cache the result
    saveMarketUpdateToCache(result);

    res.json({ ...result, cached: false });
  } catch (error) {
    console.error('Market update API error:', error);
    res.status(500).json({ error: 'Failed to fetch market update' });
  }
});

// ============================================
// MARKET DRIVER DETAILS API
// ============================================

// Market driver details cache (4 hours - same as market update)
const MARKET_DRIVER_CACHE_DIR = path.join(__dirname, 'cache', 'market-drivers');
const MARKET_DRIVER_CACHE_MAX_AGE_MINUTES = 240;

if (!fs.existsSync(MARKET_DRIVER_CACHE_DIR)) {
  fs.mkdirSync(MARKET_DRIVER_CACHE_DIR, { recursive: true });
}

// Create a hash of the bullet text for cache filename
function hashBulletText(text) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(text).digest('hex');
}

function getMarketDriverCachePath(bulletText) {
  const hash = hashBulletText(bulletText);
  return path.join(MARKET_DRIVER_CACHE_DIR, `${hash}.json`);
}

function getCachedMarketDriverDetails(bulletText) {
  const cachePath = getMarketDriverCachePath(bulletText);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageMinutes = ageMs / (1000 * 60);

    if (ageMinutes <= MARKET_DRIVER_CACHE_MAX_AGE_MINUTES) {
      console.log(`Using cached market driver details (cached ${ageMinutes.toFixed(1)} minutes ago)`);
      return cached.data;
    }
    return null;
  } catch (error) {
    console.error('Error reading market driver cache:', error);
    return null;
  }
}

function saveMarketDriverDetailsToCache(bulletText, data) {
  const cachePath = getMarketDriverCachePath(bulletText);
  const cacheData = {
    bulletText,
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log('Cached market driver details');
  } catch (error) {
    console.error('Error writing market driver cache:', error);
  }
}

// GET /api/market-driver-details
app.get('/api/market-driver-details', async (req, res) => {
  const { bullet } = req.query;

  if (!bullet) {
    return res.status(400).json({ error: 'Missing required parameter: bullet' });
  }

  // Check cache first
  const cached = getCachedMarketDriverDetails(bullet);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    // Check if this bullet is about a single stock (e.g., "Company Name (TICKER) ...")
    const tickerMatches = bullet.match(/\(([A-Z]{1,5})\)/g);
    const uniqueTickers = tickerMatches ? [...new Set(tickerMatches.map(m => m.replace(/[()]/g, '')))] : [];

    if (uniqueTickers.length === 1) {
      const ticker = uniqueTickers[0];
      console.log(`[Driver Details] Single-stock driver detected: ${ticker} — checking stock explanation cache`);

      // Check if we already have a stock explanation cached for this ticker
      const cachedExplanation = getCachedStockExplanation(ticker);
      if (cachedExplanation) {
        console.log(`[Driver Details] Using cached stock explanation for ${ticker}`);
        const result = {
          bullet,
          analysis: cachedExplanation.analysis,
          generatedAt: cachedExplanation.generatedAt
        };
        saveMarketDriverDetailsToCache(bullet, result);
        return res.json({ ...result, cached: true });
      }
    }

    console.log(`Generating detailed analysis for market driver: "${bullet.substring(0, 50)}..."`);

    // Check if market is open (9:30am - 4:00pm ET on weekdays)
    const now = new Date();
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = etTime.getHours();
    const minute = etTime.getMinutes();
    const dayOfWeek = etTime.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isBeforeOpen = hour < 9 || (hour === 9 && minute < 30);
    const isMondayPreMarket = dayOfWeek === 1 && isBeforeOpen;
    const isPreMarket = !isWeekend && isBeforeOpen;

    // Determine correct time reference:
    // - Weekend or Monday pre-market: data is from Friday
    // - Tue-Fri pre-market: data is from yesterday
    // - Market hours: data is from today
    let timeContext, dayReference;
    if (isWeekend || isMondayPreMarket) {
      timeContext = "Friday (the market hasn't opened since then)";
      dayReference = "Friday";
    } else if (isPreMarket) {
      timeContext = "yesterday (the market hasn't opened yet today)";
      dayReference = "yesterday";
    } else {
      timeContext = "today";
      dayReference = "today";
    }

    // Web search for more context on this market driver
    const searchPrompt = `Search for more information about this market news from ${dayReference}:

"${bullet}"

Find:
- Specific numbers, percentages, and data points
- Company names and stock movements involved
- Analyst reactions or commentary
- Related market impacts

Provide specific facts and quotes from recent news.`;

    console.log(`[Driver Details] Web searching... (time context: ${timeContext})`);
    const searchResponse = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: searchPrompt
    });
    if (searchResponse.usage) logTokenUsage('driver-details-search', searchResponse.usage);

    const newsContext = searchResponse.output_text;

    // Generate 4-paragraph analysis based on search results
    const analysisPrompt = `You are a senior markets analyst. A user clicked on this market driver from ${dayReference}:

"${bullet}"

Note: This market data is from ${timeContext}.

RESEARCH:
${newsContext}

Write 4 paragraphs of analysis. Include specific facts, numbers, percentages, and any important context. Each paragraph should flow naturally into the next.

CRITICAL STYLE RULES:
- Be fact-based. Include as many specific numbers/percentages as you can find.
- Short, punchy sentences. No filler.
- Every sentence must be ADDITIVE - if it doesn't add new information, cut it.
- NO generic investment advice like "investors should weigh risk-reward" or "long-term investors may view this as..."
- NO hedging language or obvious statements.
- Wrap the most important sentence in each paragraph with **bold** markdown.
- Just four flowing paragraphs, no headers.`;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 800,
      messages: [{ role: 'user', content: analysisPrompt }]
    });
    logTokenUsage('driver-details', response.usage);

    const analysis = response.choices[0].message.content.trim();

    const result = {
      bullet,
      analysis,
      generatedAt: new Date().toISOString()
    };

    // Cache the result
    saveMarketDriverDetailsToCache(bullet, result);

    // Also cache as stock explanation if single-stock driver
    if (uniqueTickers.length === 1) {
      const ticker = uniqueTickers[0];
      const stockResult = { ticker, analysis, generatedAt: new Date().toISOString() };
      saveStockExplanationToCache(ticker, stockResult);
      console.log(`[Driver Details] Also saved as stock explanation for ${ticker}`);
    }

    res.json({ ...result, cached: false });
  } catch (error) {
    console.error('Market driver details API error:', error);

    // Check for specific error types
    if (error.code === 'insufficient_quota' || error.status === 429) {
      res.status(503).json({
        error: 'API quota exceeded',
        message: 'OpenAI API quota has been exceeded. Please try again later or contact support.',
        isQuotaError: true
      });
    } else {
      res.status(500).json({
        error: 'Failed to generate market driver analysis',
        message: error.message || 'An unexpected error occurred'
      });
    }
  }
});

// ============================================
// STOCK EXPLANATION DETAILS API
// ============================================

// Stock explanation details cache (4 hours - same as market update)
const STOCK_EXPLANATION_CACHE_DIR = path.join(__dirname, 'cache', 'stock-explanations');
const STOCK_EXPLANATION_CACHE_MAX_AGE_MINUTES = 240;

if (!fs.existsSync(STOCK_EXPLANATION_CACHE_DIR)) {
  fs.mkdirSync(STOCK_EXPLANATION_CACHE_DIR, { recursive: true });
}

function getStockExplanationCachePath(ticker) {
  const today = new Date().toISOString().split('T')[0];
  return path.join(STOCK_EXPLANATION_CACHE_DIR, `${ticker.toUpperCase()}_${today}.json`);
}

function getCachedStockExplanation(ticker) {
  const cachePath = getStockExplanationCachePath(ticker);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageMinutes = ageMs / (1000 * 60);

    if (ageMinutes <= STOCK_EXPLANATION_CACHE_MAX_AGE_MINUTES) {
      console.log(`Using cached stock explanation for ${ticker} (cached ${ageMinutes.toFixed(1)} minutes ago)`);
      return cached.data;
    }
    return null;
  } catch (error) {
    console.error('Error reading stock explanation cache:', error);
    return null;
  }
}

function saveStockExplanationToCache(ticker, data) {
  const cachePath = getStockExplanationCachePath(ticker);
  const cacheData = {
    ticker: ticker.toUpperCase(),
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log(`Cached stock explanation for ${ticker}`);
  } catch (error) {
    console.error('Error writing stock explanation cache:', error);
  }
}

// GET /api/stock-explanation-details
app.get('/api/stock-explanation-details', async (req, res) => {
  const { ticker, companyName, changePercent } = req.query;

  if (!ticker || !companyName || !changePercent) {
    return res.status(400).json({ error: 'Missing required parameters: ticker, companyName, changePercent' });
  }

  // Check cache first
  const cached = getCachedStockExplanation(ticker);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    console.log(`Generating detailed stock explanation for ${ticker} (${changePercent})`);

    const direction = parseFloat(changePercent) >= 0 ? 'up' : 'down';
    const absChange = Math.abs(parseFloat(changePercent)).toFixed(1);

    // Check if market is open (9:30am - 4:00pm ET on weekdays)
    const now = new Date();
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = etTime.getHours();
    const minute = etTime.getMinutes();
    const dayOfWeek = etTime.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isBeforeOpen = hour < 9 || (hour === 9 && minute < 30);
    const isMondayPreMarket = dayOfWeek === 1 && isBeforeOpen;
    const isPreMarket = !isWeekend && isBeforeOpen;

    // Determine correct time reference:
    // - Weekend or Monday pre-market: data is from Friday
    // - Tue-Fri pre-market: data is from yesterday
    // - Market hours: data is from today
    let timeContext, dayReference;
    if (isWeekend || isMondayPreMarket) {
      timeContext = "Friday (the market hasn't opened since then)";
      dayReference = "Friday";
    } else if (isPreMarket) {
      timeContext = "yesterday (the market hasn't opened yet today)";
      dayReference = "yesterday";
    } else {
      timeContext = "today";
      dayReference = "today";
    }

    // Web search for current news
    const searchPrompt = `Why did ${companyName} (${ticker}) stock move ${direction} ${absChange}% ${dayReference}?

Note: This price move is from ${timeContext}.

Search for:
- Earnings results, guidance, and analyst reactions
- Company announcements (acquisitions, products, partnerships)
- Analyst upgrades/downgrades with price targets
- Industry or macro factors affecting the stock

Provide specific facts, numbers, percentages, and quotes from recent news.`;

    console.log(`[Stock Details] Web searching for ${ticker}... (time context: ${timeContext})`);
    const searchResponse = await client.responses.create({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search' }],
      input: searchPrompt
    });
    if (searchResponse.usage) logTokenUsage('stock-details-search', searchResponse.usage);

    const newsContext = searchResponse.output_text;

    // Generate 4-paragraph analysis based on search results
    const analysisPrompt = `You are a senior equity analyst. Based on the research below, write a 4-paragraph analysis of why ${companyName} (${ticker}) moved ${direction} ${absChange}% ${dayReference}.

Note: This price data is from ${timeContext}.

RESEARCH:
${newsContext}

Write 4 paragraphs of analysis. Include the specific catalyst driving the move, relevant numbers (EPS, revenue, guidance, price targets), and any important context. Each paragraph should flow naturally into the next.

CRITICAL STYLE RULES:
- Be fact-based. Include as many specific numbers/percentages as you can find.
- Short, punchy sentences. No filler.
- Every sentence must be ADDITIVE - if it doesn't add new information, cut it.
- NO generic investment advice like "investors should weigh risk-reward" or "long-term investors may view this as..."
- NO hedging language or obvious statements.
- Wrap the most important sentence in each paragraph with **bold** markdown.
- Just four flowing paragraphs, no headers.`;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 800,
      messages: [{ role: 'user', content: analysisPrompt }]
    });
    logTokenUsage('stock-details', response.usage);

    const analysis = response.choices[0].message.content.trim();

    const result = {
      ticker,
      companyName,
      changePercent,
      analysis,
      generatedAt: new Date().toISOString()
    };

    // Cache the result
    saveStockExplanationToCache(ticker, result);

    res.json({ ...result, cached: false });
  } catch (error) {
    console.error('Stock explanation API error:', error);

    // Check for specific error types
    if (error.code === 'insufficient_quota' || error.status === 429) {
      res.status(503).json({
        error: 'API quota exceeded',
        message: 'OpenAI API quota has been exceeded. Please try again later or contact support.',
        isQuotaError: true
      });
    } else {
      res.status(500).json({
        error: 'Failed to generate stock explanation',
        message: error.message || 'An unexpected error occurred'
      });
    }
  }
});

// ============================================
// EARNINGS REVIEW FEATURE
// ============================================

// Earnings review cache (30 days since reviews are based on static transcripts)
const EARNINGS_REVIEW_CACHE_DIR = path.join(__dirname, 'cache', 'earnings-reviews');
const EARNINGS_REVIEW_CACHE_MAX_AGE_DAYS = 30;

if (!fs.existsSync(EARNINGS_REVIEW_CACHE_DIR)) {
  fs.mkdirSync(EARNINGS_REVIEW_CACHE_DIR, { recursive: true });
}

function getEarningsReviewCachePath(ticker, priceMove) {
  // Include price move in cache key to get different reviews for different price movements
  const safePriceMove = priceMove.replace(/[^a-zA-Z0-9+-]/g, '');
  return path.join(EARNINGS_REVIEW_CACHE_DIR, `${ticker.toUpperCase()}_${safePriceMove}.json`);
}

function getCachedEarningsReview(ticker, priceMove) {
  const cachePath = getEarningsReviewCachePath(ticker, priceMove);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const ageMs = Date.now() - cached.cachedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= EARNINGS_REVIEW_CACHE_MAX_AGE_DAYS) {
      console.log(`Using cached earnings review for ${ticker} (cached ${ageDays.toFixed(1)} days ago)`);
      return cached.data;
    }
    return null;
  } catch (error) {
    console.error('Error reading earnings review cache:', error);
    return null;
  }
}

function saveEarningsReviewToCache(ticker, priceMove, data) {
  const cachePath = getEarningsReviewCachePath(ticker, priceMove);
  const cacheData = {
    ticker: ticker.toUpperCase(),
    priceMove,
    data,
    cachedAt: Date.now()
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    console.log(`Cached earnings review for ${ticker}`);
  } catch (error) {
    console.error('Error writing earnings review cache:', error);
  }
}

// GET /api/earnings-review/:ticker
app.get('/api/earnings-review/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const { priceMove } = req.query; // e.g., "+5.2%" or "-7.8%"

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker is required' });
  }

  const normalizedPriceMove = priceMove || '+0%';

  // 1. Check for cached earnings review
  const cached = getCachedEarningsReview(ticker, normalizedPriceMove);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  // 2. Fetch earnings transcript from cache
  const transcriptCachePath = path.join(EARNINGS_CACHE_DIR, `${ticker.toUpperCase()}_earnings.json`);
  if (!fs.existsSync(transcriptCachePath)) {
    return res.status(404).json({ error: `No earnings transcript found for ${ticker}` });
  }

  let transcriptData;
  try {
    transcriptData = JSON.parse(fs.readFileSync(transcriptCachePath, 'utf8'));
  } catch (error) {
    console.error('Error reading earnings transcript:', error);
    return res.status(500).json({ error: 'Failed to read earnings transcript' });
  }

  // Get the most recent transcript
  const transcripts = transcriptData.data?.transcripts || [];
  if (transcripts.length === 0) {
    return res.status(404).json({ error: `No transcripts available for ${ticker}` });
  }

  const latestTranscript = transcripts[0];
  const companyName = transcriptData.data?.companyName || ticker;
  const quarterInfo = `Q${latestTranscript.quarter} ${latestTranscript.year}`;

  // Use more of the transcript for better analysis (up to 25000 chars for full Q&A coverage)
  const fullTranscript = latestTranscript.transcript.substring(0, 25000);

  // 3. Generate Goldman Sachs style earnings review using OpenAI
  console.log(`Generating earnings review for ${ticker}...`);

  const prompt = `You are a Goldman Sachs equity research analyst. Based on this ${quarterInfo} earnings call transcript for ${companyName} (${ticker}) and today's stock price movement (${normalizedPriceMove}), write a comprehensive earnings review.

IMPORTANT: Output in JSON format ONLY. No markdown code blocks.

Style: Professional, analytical, direct. Aggressive, punchy language. Short sentences that convey maximum information.

Return this exact JSON structure:
{
  "headline": "One punchy sentence capturing the most important insight from this earnings. Be aggressive and direct. Example: 'PLTR crushes estimates, AIP demand explodes.' or 'Revenue miss overshadows margin expansion.'",

  "keyTakeaways": [
    "First key metric (revenue/EPS vs estimates with specific numbers)",
    "Second key takeaway (guidance change or notable metric)",
    "Third key takeaway (important management commentary)",
    "Fourth key takeaway (any other critical point)"
  ],

  "keyDebates": {
    "bullCase": [
      "What bulls are emphasizing after this earnings (specific, with numbers if possible)",
      "Second bull point based on Q&A or results",
      "Third bull point (optional)"
    ],
    "bearCase": [
      "What bears are concerned about after this earnings (specific concerns)",
      "Second bear point based on Q&A or results",
      "Third bear point (optional)"
    ]
  },

  "whyItsMoving": "Explanation of the ${normalizedPriceMove} move. Be specific about what in the earnings drove this reaction. 2-3 sentences.",

  "ourView": "Factual analysis of the results and what to watch going forward. Do NOT state bullish/bearish. Just state facts and key metrics to monitor. 2-3 sentences.",

  "managementQA": [
    {
      "analyst": "Analyst name if mentioned, or 'Analyst'",
      "question": "The actual question asked (paraphrased if needed for brevity)",
      "answer": "Management's key response (paraphrased, focus on the substance)"
    }
  ]
}

For managementQA: Extract 5-8 of the most insightful Q&A exchanges from the transcript. Pick questions that reveal key debates, growth drivers, risks, or strategic direction. Include the analyst name if mentioned.

Transcript:
${fullTranscript}`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });
    logTokenUsage('earnings', response.usage);

    let reviewData;
    try {
      // Parse the JSON response
      let content = response.choices[0].message.content.trim();
      // Remove markdown code blocks if present
      content = content.replace(/^```json\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      // Clean up common JSON issues from LLM output
      content = content.replace(/[\x00-\x1F\x7F]/g, ' '); // Remove control characters
      reviewData = JSON.parse(content);
    } catch (parseError) {
      console.error('Error parsing earnings review JSON:', parseError);
      console.error('Raw content (first 500 chars):', response.choices[0].message.content.substring(0, 500));
      // Fallback to old format if JSON parsing fails
      reviewData = {
        headline: 'Earnings results released',
        keyTakeaways: ['See transcript for details'],
        keyDebates: { bullCase: [], bearCase: [] },
        whyItsMoving: `Stock moved ${normalizedPriceMove} following earnings.`,
        ourView: 'Review the full transcript for detailed analysis.',
        managementQA: []
      };
    }

    const result = {
      ticker: ticker.toUpperCase(),
      companyName,
      quarterInfo,
      priceMove: normalizedPriceMove,
      headline: reviewData.headline,
      keyTakeaways: reviewData.keyTakeaways,
      keyDebates: reviewData.keyDebates,
      whyItsMoving: reviewData.whyItsMoving,
      ourView: reviewData.ourView,
      managementQA: reviewData.managementQA,
      generatedAt: new Date().toISOString()
    };

    // 4. Cache the review
    saveEarningsReviewToCache(ticker, normalizedPriceMove, result);

    // 5. Return the review
    res.json({ ...result, cached: false });

  } catch (error) {
    console.error('Error generating earnings review:', error);
    res.status(500).json({ error: 'Failed to generate earnings review' });
  }
});

// ============================================
// TOKEN USAGE MONITORING API
// ============================================

app.get('/api/token-usage', (req, res) => {
  try {
    // Read token usage log
    let logData = { entries: [] };
    if (fs.existsSync(TOKEN_USAGE_LOG_PATH)) {
      try {
        logData = JSON.parse(fs.readFileSync(TOKEN_USAGE_LOG_PATH, 'utf8'));
      } catch (err) {
        console.error('Error parsing token usage log:', err.message);
      }
    }

    const entries = logData.entries || [];
    const now = new Date();
    // Use Eastern Time for "today" boundary
    const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStart = new Date(etNow.getFullYear(), etNow.getMonth(), etNow.getDate());

    // Calculate today's totals
    const todayEntries = entries.filter(e => {
      const entryET = new Date(new Date(e.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' }));
      return entryET >= todayStart;
    });
    const todayTotals = {
      promptTokens: todayEntries.reduce((sum, e) => sum + (e.promptTokens || 0), 0),
      completionTokens: todayEntries.reduce((sum, e) => sum + (e.completionTokens || 0), 0),
      totalTokens: todayEntries.reduce((sum, e) => sum + (e.totalTokens || 0), 0),
      apiCalls: todayEntries.length
    };

    // GPT-4o pricing: $2.50/1M input, $10/1M output
    todayTotals.estimatedCost = (todayTotals.promptTokens * 2.50 / 1000000) + (todayTotals.completionTokens * 10 / 1000000);

    // Hourly breakdown for today
    const hourlyBreakdown = {};
    for (let h = 0; h < 24; h++) {
      hourlyBreakdown[h] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCalls: 0 };
    }
    todayEntries.forEach(e => {
      const hour = new Date(new Date(e.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
      hourlyBreakdown[hour].promptTokens += e.promptTokens || 0;
      hourlyBreakdown[hour].completionTokens += e.completionTokens || 0;
      hourlyBreakdown[hour].totalTokens += e.totalTokens || 0;
      hourlyBreakdown[hour].apiCalls += 1;
    });

    // Breakdown by endpoint for today
    const endpointBreakdown = {};
    todayEntries.forEach(e => {
      const endpoint = e.endpoint || 'unknown';
      if (!endpointBreakdown[endpoint]) {
        endpointBreakdown[endpoint] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCalls: 0 };
      }
      endpointBreakdown[endpoint].promptTokens += e.promptTokens || 0;
      endpointBreakdown[endpoint].completionTokens += e.completionTokens || 0;
      endpointBreakdown[endpoint].totalTokens += e.totalTokens || 0;
      endpointBreakdown[endpoint].apiCalls += 1;
    });

    // Calculate cost for each endpoint
    Object.keys(endpointBreakdown).forEach(endpoint => {
      const data = endpointBreakdown[endpoint];
      data.estimatedCost = (data.promptTokens * 2.50 / 1000000) + (data.completionTokens * 10 / 1000000);
    });

    // Last 7 days summary (Eastern Time)
    const dailySummary = {};
    for (let i = 0; i < 7; i++) {
      const date = new Date(etNow);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      dailySummary[dateStr] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCalls: 0, estimatedCost: 0 };
    }

    entries.forEach(e => {
      const entryET = new Date(new Date(e.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const dateStr = `${entryET.getFullYear()}-${String(entryET.getMonth()+1).padStart(2,'0')}-${String(entryET.getDate()).padStart(2,'0')}`;
      if (dailySummary[dateStr]) {
        dailySummary[dateStr].promptTokens += e.promptTokens || 0;
        dailySummary[dateStr].completionTokens += e.completionTokens || 0;
        dailySummary[dateStr].totalTokens += e.totalTokens || 0;
        dailySummary[dateStr].apiCalls += 1;
      }
    });

    // Calculate cost for each day
    Object.keys(dailySummary).forEach(date => {
      const data = dailySummary[date];
      data.estimatedCost = (data.promptTokens * 2.50 / 1000000) + (data.completionTokens * 10 / 1000000);
    });

    res.json({
      todayTotals,
      hourlyBreakdown,
      endpointBreakdown,
      dailySummary,
      generatedAt: now.toISOString()
    });
  } catch (error) {
    console.error('Token usage API error:', error);
    res.status(500).json({ error: 'Failed to retrieve token usage data' });
  }
});

// ============================================
// PRE-GENERATE COMPANY DESCRIPTIONS
// ============================================
app.get('/api/generate-company-descriptions', async (req, res) => {
  const { index = 'sp500' } = req.query;

  // Get the stock list for the index (currently only S&P 500 supported)
  const stocks = SP500_STOCKS;
  const existingDescriptions = getCompanyDescriptions();

  // Find stocks that don't have descriptions yet
  const missingStocks = stocks.filter(ticker => !existingDescriptions[ticker.toUpperCase()]);

  if (missingStocks.length === 0) {
    return res.json({
      message: 'All company descriptions already cached',
      total: stocks.length,
      cached: stocks.length,
      generated: 0
    });
  }

  console.log(`[Company Desc] Generating descriptions for ${missingStocks.length} stocks...`);

  let generated = 0;
  const errors = [];

  // Process in batches of 5 to avoid rate limits
  for (let i = 0; i < missingStocks.length; i += 5) {
    const batch = missingStocks.slice(i, i + 5);
    const promises = batch.map(async (ticker) => {
      try {
        const name = COMPANY_NAMES[ticker] || ticker;
        await generateCompanyDescription(ticker, name);
        generated++;
      } catch (err) {
        errors.push({ ticker, error: err.message });
      }
    });
    await Promise.all(promises);
    // Small delay between batches
    if (i + 5 < missingStocks.length) {
      await delay(1000);
    }
  }

  res.json({
    message: `Generated ${generated} company descriptions`,
    total: stocks.length,
    cached: stocks.length - missingStocks.length,
    generated,
    errors: errors.length > 0 ? errors : undefined
  });
});

// ============================================
// AUTOMATIC CACHE WARMING FOR PORTFOLIO UPDATE & MARKET UPDATE
// ============================================

// Optimized refresh schedule: 5 times daily during market hours, S&P 500 only
// Refresh times (ET): 9:31 AM, 11:31 AM, 1:31 PM, 3:31 PM, 4:00 PM (end of day)
// This reduces API costs from ~10.6M tokens/day to ~296K tokens/day (97% reduction)
const PORTFOLIO_REFRESH_TIMES = ['09:31', '11:31', '13:31', '15:31', '16:00']; // ET times - both Market Update & Top Movers

// Additional Market Update-only refresh times (does NOT refresh Top Movers)
// 7:30 AM = pre-market summary, 6:00 PM = after-hours summary
const MARKET_UPDATE_ONLY_TIMES = ['07:30', '18:00']; // ET times - Market Update only

// Market Update refresh - lightweight (~2,500 tokens per refresh)
async function refreshMarketUpdate() {
  try {
    console.log('[Cache Warming] Refreshing Market Update...');

    // Fetch index quotes
    const indexSymbols = [
      { symbol: '^GSPC', name: 'S&P 500' },
      { symbol: '^IXIC', name: 'Nasdaq Composite' },
      { symbol: '^DJI', name: 'Dow Jones' }
    ];

    const indices = await Promise.all(indexSymbols.map(async ({ symbol, name }) => {
      try {
        const quote = await yahooFinance.quote(symbol);
        return {
          symbol,
          name,
          price: quote.regularMarketPrice || 0,
          change: quote.regularMarketChange || 0,
          changePercent: quote.regularMarketChangePercent || 0
        };
      } catch (err) {
        console.error(`Failed to fetch ${symbol}:`, err.message);
        return { symbol, name, price: 0, change: 0, changePercent: 0 };
      }
    }));

    // Search for market drivers
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const searchPrompt = `Search for "stock market today ${dateStr} why moving", "stock market news ${dateStr}", and "biggest stock movers today ${dateStr} gainers losers". Find the main reasons why stocks are moving today - what headlines, earnings, economic data, or events are driving market action. Also find specific stocks with large price moves (5%+ gains or losses) and why they are moving.`;

    const searchResponse = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: searchPrompt
    });
    if (searchResponse.usage) logTokenUsage('market-update', searchResponse.usage);

    const searchResults = searchResponse.output_text;

    // Generate summary
    const summaryPrompt = `You are a markets analyst writing a quick daily brief. Based on this market research, write 10 punchy bullet points explaining what's driving today's market action.

Research:
${searchResults}

Index Performance Today:
- S&P 500: ${indices[0].changePercent >= 0 ? '+' : ''}${indices[0].changePercent.toFixed(2)}%
- Nasdaq: ${indices[1].changePercent >= 0 ? '+' : ''}${indices[1].changePercent.toFixed(2)}%
- Dow Jones: ${indices[2].changePercent >= 0 ? '+' : ''}${indices[2].changePercent.toFixed(2)}%

Rules:
- Each bullet should be ONE sentence, max 20 words
- Be specific with stock names, percentages, and numbers
- Lead with the most important driver
- Aggressive, confident tone - no hedging language
- CRITICAL: Include specific individual stock movers with exact percentages (e.g., "NVDA +5.2%", "TSLA -6.8%")
- If a stock moved 5% or more today, it MUST be mentioned with its exact percentage
- Focus on WHY things are moving, not just that they moved
- At least 3-4 bullets should be about specific individual stock moves with percentages

Return ONLY a JSON array of strings with exactly 10 bullet points, like:
["First driver bullet point", "Second driver bullet point", "Third driver bullet point", ...]`;

    const summaryResponse = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [{ role: 'user', content: summaryPrompt }]
    });
    logTokenUsage('market-update', summaryResponse.usage);

    let drivers = [];
    try {
      const content = summaryResponse.choices[0].message.content.trim();
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        drivers = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      drivers = summaryResponse.choices[0].message.content
        .split('\n')
        .filter(line => line.trim().length > 0)
        .slice(0, 10);
    }

    const result = {
      indices,
      drivers,
      asOf: new Date().toISOString()
    };

    saveMarketUpdateToCache(result);
    console.log('[Cache Warming] Market Update cache refreshed successfully');

  } catch (error) {
    console.error('[Cache Warming] Error refreshing Market Update:', error.message);
  }
}

function shouldRefreshPortfolio() {
  const now = new Date();
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = etTime.getDay();
  const hours = etTime.getHours();
  const minutes = etTime.getMinutes();

  // Only Mon-Fri (0 = Sunday, 6 = Saturday)
  if (day === 0 || day === 6) return false;

  // Only during market hours (9:30 AM - 4:05 PM ET, extended for 4:00 PM refresh)
  if (hours < 9 || (hours === 9 && minutes < 30) || hours > 16 || (hours === 16 && minutes >= 5)) return false;

  // Check if current time matches a refresh time (within 5 minute window)
  return PORTFOLIO_REFRESH_TIMES.some(time => {
    const [h, m] = time.split(':').map(Number);
    return hours === h && minutes >= m && minutes < m + 5;
  });
}

// Retry mechanism for failed market movers refreshes (per-index)
const marketMoversRetryTimeouts = {};

function scheduleMarketMoversRetry(index) {
  if (marketMoversRetryTimeouts[index]) return; // Already scheduled for this index
  console.log(`[Market Movers] ${index.toUpperCase()} refresh failed, scheduling retry in 1 hour`);
  marketMoversRetryTimeouts[index] = setTimeout(async () => {
    marketMoversRetryTimeouts[index] = null;
    try {
      const success = await refreshMarketMoversForIndex(index);
      if (success) {
        console.log(`[Market Movers] ${index.toUpperCase()} retry successful`);
      } else {
        console.log(`[Market Movers] ${index.toUpperCase()} retry failed, will try again in 1 hour`);
        scheduleMarketMoversRetry(index);
      }
    } catch (err) {
      console.error(`[Market Movers] ${index.toUpperCase()} retry error:`, err.message);
      scheduleMarketMoversRetry(index);
    }
  }, 60 * 60 * 1000); // 1 hour
}

// Step 1: Fetch stock prices and identify top movers (fast, free ~3-5s)
async function refreshMarketMoversPrices(index) {
  try {
    console.log(`[Market Movers Prices] Fetching prices for ${index.toUpperCase()}...`);

    const indexConfig = INDEX_CONFIG[index];
    const { name: indexName, stocks: indexStocks } = indexConfig;

    // Fetch all stock data
    const stockData = await fetchStockData(indexStocks);
    console.log(`[Market Movers Prices] Fetched data for ${stockData.length} ${indexName} stocks`);

    // Sort by change percent
    const sortedByGain = [...stockData].sort((a, b) => b.changePercent - a.changePercent);
    const sortedByLoss = [...stockData].sort((a, b) => a.changePercent - b.changePercent);

    // Get top 10 gainers and top 10 losers (basic data)
    const gainers = sortedByGain.slice(0, 10).map(s => ({
      ticker: s.ticker,
      companyName: COMPANY_NAMES[s.ticker] || s.companyName,
      price: s.price,
      changePercent: s.changePercent,
      changeDollar: s.price * (s.changePercent / 100) / (1 + s.changePercent / 100)
    }));

    const losers = sortedByLoss.slice(0, 10).map(s => ({
      ticker: s.ticker,
      companyName: COMPANY_NAMES[s.ticker] || s.companyName,
      price: s.price,
      changePercent: s.changePercent,
      changeDollar: s.price * (s.changePercent / 100) / (1 + s.changePercent / 100)
    }));

    const priceData = {
      gainers,
      losers,
      index,
      indexName,
      totalStocksAnalyzed: stockData.length,
      fetchedAt: new Date().toISOString()
    };

    // Save prices-only cache
    const pricesCachePath = getMarketMoversPricesCachePath(index);
    fs.writeFileSync(pricesCachePath, JSON.stringify({ data: priceData, timestamp: Date.now() }, null, 2));
    console.log(`[Market Movers Prices] Saved prices cache for ${index.toUpperCase()}`);

    return priceData;

  } catch (error) {
    console.error(`[Market Movers Prices] Error fetching prices for ${index.toUpperCase()}:`, error.message);
    return null;
  }
}

// Step 2: Generate AI explanations + thesis for top movers (expensive, slow ~8-10 min)
async function refreshMarketMoversExplanations(index) {
  try {
    // Read the current prices cache
    const pricesCachePath = getMarketMoversPricesCachePath(index);
    if (!fs.existsSync(pricesCachePath)) {
      console.error(`[Market Movers Explanations] No prices cache found for ${index.toUpperCase()}`);
      return false;
    }

    const pricesCache = JSON.parse(fs.readFileSync(pricesCachePath, 'utf8'));
    const priceData = pricesCache.data;
    const { gainers: gainersBasic, losers: losersBasic, indexName } = priceData;

    // Generate all 20 explanations and thesis with rate limiting
    console.log(`[Market Movers Explanations] Generating AI explanations for ${index.toUpperCase()}...`);
    const allStocks = [...gainersBasic, ...losersBasic];

    // Process in batches of 3 to avoid OpenAI rate limits
    const batchSize = 3;
    const explanationResults = [];
    const thesisResults = [];

    for (let i = 0; i < allStocks.length; i += batchSize) {
      const batch = allStocks.slice(i, i + batchSize);

      const batchExplanations = await Promise.all(
        batch.map(stock => generateStockExplanation(stock.ticker, stock.companyName, stock.changePercent))
      );
      const batchThesis = await Promise.all(
        batch.map(stock => getStockThesis(stock.ticker, stock.companyName))
      );

      explanationResults.push(...batchExplanations);
      thesisResults.push(...batchThesis);

      // Add delay between batches (except for the last batch)
      if (i + batchSize < allStocks.length) {
        await delay(5000);
      }
    }

    // Attach explanations and thesis to gainers and losers
    const gainers = gainersBasic.map((stock, i) => ({
      ...stock,
      explanation: explanationResults[i].explanation,
      thesis: thesisResults[i].thesis,
      hasFullReport: thesisResults[i].hasFullReport
    }));

    const losers = losersBasic.map((stock, i) => ({
      ...stock,
      explanation: explanationResults[i + 10].explanation,
      thesis: thesisResults[i + 10].thesis,
      hasFullReport: thesisResults[i + 10].hasFullReport
    }));

    const asOf = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }) + ' ET';

    const result = {
      gainers,
      losers,
      asOf,
      index,
      indexName,
      totalStocksAnalyzed: priceData.totalStocksAnalyzed,
      generatedAt: new Date().toISOString()
    };

    // Cache the full result with explanations
    saveMarketMoversToCache(result, index);
    console.log(`[Market Movers Explanations] Successfully cached ${index.toUpperCase()} market movers with explanations`);
    return true;

  } catch (error) {
    console.error(`[Market Movers Explanations] Error generating explanations for ${index.toUpperCase()}:`, error.message);
    console.log(`[Market Movers Explanations] Existing cache for ${index.toUpperCase()} preserved (not cleared on failure)`);
    return false;
  }
}

// Combined: Fetch prices then generate explanations (thin wrapper)
async function refreshMarketMoversForIndex(index) {
  const priceData = await refreshMarketMoversPrices(index);
  if (!priceData) return false;
  return await refreshMarketMoversExplanations(index);
}

// Track last refresh to avoid duplicate refreshes within the same window
let lastPortfolioRefreshTime = null;
let lastMarketUpdateOnlyRefreshTime = null;

async function checkAndRefreshPortfolio() {
  const now = new Date();
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hours = etTime.getHours();
  const minutes = etTime.getMinutes();
  const day = etTime.getDay();
  const currentTimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  const isWeekday = day >= 1 && day <= 5;

  // Check for Market Update-only refresh times (7:30 AM, 6:00 PM)
  const marketUpdateOnlyWindow = MARKET_UPDATE_ONLY_TIMES.find(time => {
    const [h, m] = time.split(':').map(Number);
    return hours === h && minutes >= m && minutes < m + 5;
  });

  if (isWeekday && marketUpdateOnlyWindow && lastMarketUpdateOnlyRefreshTime !== marketUpdateOnlyWindow) {
    lastMarketUpdateOnlyRefreshTime = marketUpdateOnlyWindow;
    console.log(`[Cache Warming] Market Update-only refresh at ${currentTimeStr} ET (window: ${marketUpdateOnlyWindow})`);
    await refreshMarketUpdate();
    console.log('[Cache Warming] Market Update refresh complete');
  }

  // Check for full refresh times (both Market Update + Top Movers)
  if (shouldRefreshPortfolio()) {
    const currentWindow = PORTFOLIO_REFRESH_TIMES.find(time => {
      const [h, m] = time.split(':').map(Number);
      return hours === h && minutes >= m && minutes < m + 5;
    });

    if (currentWindow && lastPortfolioRefreshTime !== currentWindow) {
      lastPortfolioRefreshTime = currentWindow;
      console.log(`[Cache Warming] Full refresh triggered at ${currentTimeStr} ET (window: ${currentWindow})`);

      // Refresh Market Update first (fast, ~2,500 tokens)
      console.log('[Cache Warming] Refreshing Market Update...');
      await refreshMarketUpdate();

      // Then refresh S&P 500 market movers (slower, ~59K tokens)
      console.log('[Cache Warming] Refreshing S&P 500 market movers...');
      const success = await refreshMarketMoversForIndex('sp500');
      if (!success) {
        scheduleMarketMoversRetry();
      }
      console.log('[Cache Warming] All scheduled refreshes complete');
    }
  } else {
    // Reset the tracking when outside refresh windows
    const isInAnyWindow = PORTFOLIO_REFRESH_TIMES.some(time => {
      const [h, m] = time.split(':').map(Number);
      return hours === h && minutes >= m && minutes < m + 5;
    });
    if (!isInAnyWindow) {
      lastPortfolioRefreshTime = null;
    }

    const isInMarketUpdateOnlyWindow = MARKET_UPDATE_ONLY_TIMES.some(time => {
      const [h, m] = time.split(':').map(Number);
      return hours === h && minutes >= m && minutes < m + 5;
    });
    if (!isInMarketUpdateOnlyWindow) {
      lastMarketUpdateOnlyRefreshTime = null;
    }
  }
}

// Cron-based scheduling (replaces unreliable interval checking)
// Market Update + Top Movers: 9:31, 11:31, 1:31, 3:31 PM ET (Mon-Fri)
cron.schedule('31 9,11,13,15 * * 1-5', async () => {
  console.log('[Cron] Running scheduled refresh: Market Update + Top Movers (all indices)');
  await refreshMarketUpdate();
  for (const index of ['sp500', 'nasdaq', 'russell']) {
    const success = await refreshMarketMoversForIndex(index);
    if (!success) scheduleMarketMoversRetry(index);
  }
}, { timezone: 'America/New_York' });

// Market Update + Top Movers: 4:00 PM ET (Mon-Fri)
cron.schedule('0 16 * * 1-5', async () => {
  console.log('[Cron] Running scheduled refresh: Market Update + Top Movers (4 PM, all indices)');
  await refreshMarketUpdate();
  for (const index of ['sp500', 'nasdaq', 'russell']) {
    const success = await refreshMarketMoversForIndex(index);
    if (!success) scheduleMarketMoversRetry(index);
  }
}, { timezone: 'America/New_York' });

// Market Update only: 7:30 AM, 6:00 PM ET (Mon-Fri)
cron.schedule('30 7,18 * * 1-5', async () => {
  console.log('[Cron] Running scheduled refresh: Market Update only');
  await refreshMarketUpdate();
}, { timezone: 'America/New_York' });

// On server startup, just log cache status - DO NOT refresh
// Cache warming only happens on scheduled times (9:31, 11:31, 1:31, 3:31, 4:00 PM ET)
// This prevents excessive OpenAI API usage during development/deployments
setTimeout(() => {
  const marketUpdateCache = getCachedMarketUpdate();
  const marketUpdateCacheIsValid = marketUpdateCache !== null;
  console.log('[Cache Status] Market Update: ' + (marketUpdateCacheIsValid ? 'valid' : 'empty/expired'));

  for (const index of ['sp500', 'nasdaq', 'russell']) {
    const cache = getCachedMarketMovers(index);
    console.log(`[Cache Status] ${index.toUpperCase()} Movers: ` + (cache !== null ? 'valid' : 'empty/expired'));
  }

  console.log('[Cache Status] Skipping startup refresh - will refresh on schedule or user request');
}, 5000);

// ============================================
// USER AUTHENTICATION & WATCHLIST API
// ============================================

// Ensure user and watchlist directories exist
const USERS_DIR = path.join(__dirname, 'cache', 'users');
const WATCHLISTS_DIR = path.join(__dirname, 'cache', 'watchlists');

if (!fs.existsSync(USERS_DIR)) {
  fs.mkdirSync(USERS_DIR, { recursive: true });
}
if (!fs.existsSync(WATCHLISTS_DIR)) {
  fs.mkdirSync(WATCHLISTS_DIR, { recursive: true });
}

const USERS_FILE = path.join(USERS_DIR, 'users.json');

// Helper functions for user management
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading users:', err);
  }
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving users:', err);
  }
}

// Multiple watchlists constants
const MAX_WATCHLISTS_PER_USER = 10;
const MAX_STOCKS_PER_WATCHLIST = 50;
const MAX_WATCHLIST_NAME_LENGTH = 50;

// Generate unique watchlist ID
function generateWatchlistId() {
  return 'watchlist_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Create empty watchlist data structure (new format)
function createEmptyWatchlistData() {
  const defaultWatchlistId = generateWatchlistId();
  const now = new Date().toISOString();
  return {
    version: 2,
    defaultWatchlist: defaultWatchlistId,
    watchlists: {
      [defaultWatchlistId]: {
        id: defaultWatchlistId,
        name: 'My Portfolio',
        tickers: [],
        createdAt: now,
        updatedAt: now
      }
    }
  };
}

// Migrate old array format to new format
function migrateWatchlistData(userId, oldData) {
  const defaultWatchlistId = generateWatchlistId();
  const now = new Date().toISOString();
  const newData = {
    version: 2,
    defaultWatchlist: defaultWatchlistId,
    watchlists: {
      [defaultWatchlistId]: {
        id: defaultWatchlistId,
        name: 'My Portfolio',
        tickers: Array.isArray(oldData) ? oldData : [],
        createdAt: now,
        updatedAt: now
      }
    }
  };
  saveWatchlistData(userId, newData);
  console.log(`Migrated watchlist for user ${userId} to new format`);
  return newData;
}

// Load watchlist data (new format, with auto-migration)
function loadWatchlistData(userId) {
  try {
    const watchlistPath = path.join(WATCHLISTS_DIR, `${userId}.json`);
    if (fs.existsSync(watchlistPath)) {
      const data = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
      // Check if old format (array) and migrate
      if (Array.isArray(data)) {
        return migrateWatchlistData(userId, data);
      }
      // Check if new format
      if (data.version === 2 && data.watchlists) {
        return data;
      }
      // Unknown format, migrate as empty
      return migrateWatchlistData(userId, []);
    }
  } catch (err) {
    console.error('Error loading watchlist data:', err);
  }
  return createEmptyWatchlistData();
}

// Save watchlist data (new format)
function saveWatchlistData(userId, data) {
  try {
    const watchlistPath = path.join(WATCHLISTS_DIR, `${userId}.json`);
    fs.writeFileSync(watchlistPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving watchlist data:', err);
  }
}

// Legacy: Load default watchlist tickers (for backward compatibility)
function loadWatchlist(userId) {
  const data = loadWatchlistData(userId);
  const defaultWl = data.watchlists[data.defaultWatchlist];
  return defaultWl ? defaultWl.tickers : [];
}

// Legacy: Save to default watchlist (for backward compatibility)
function saveWatchlist(userId, tickers) {
  const data = loadWatchlistData(userId);
  if (data.watchlists[data.defaultWatchlist]) {
    data.watchlists[data.defaultWatchlist].tickers = tickers;
    data.watchlists[data.defaultWatchlist].updatedAt = new Date().toISOString();
  }
  saveWatchlistData(userId, data);
}

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Generate unique user ID
function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// POST /api/auth/signup - Create new account
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const emailLower = email.toLowerCase().trim();

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailLower)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const users = loadUsers();

    // Check if user already exists
    if (users[emailLower]) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const userId = generateUserId();
    users[emailLower] = {
      id: userId,
      email: emailLower,
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };

    saveUsers(users);

    // Create empty watchlist
    saveWatchlist(userId, []);

    // Generate token
    const token = jwt.sign({ id: userId, email: emailLower }, JWT_SECRET, { expiresIn: '30d' });

    console.log(`New user registered: ${emailLower}`);

    res.json({
      token,
      user: { id: userId, email: emailLower }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /api/auth/login - Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const emailLower = email.toLowerCase().trim();
    const users = loadUsers();

    const user = users[emailLower];
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    console.log(`User logged in: ${emailLower}`);

    res.json({
      token,
      user: { id: user.id, email: user.email }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/google - Google Sign-In
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Credential is required' });
    }

    // Verify the Google credential token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase().trim();
    const googleId = payload.sub; // Google's unique user ID

    // Load users database
    const users = loadUsers();

    // Check if user already exists
    let user = users[email];
    if (!user) {
      // Create new user with Google account
      const userId = generateUserId();
      user = {
        id: userId,
        email: email,
        googleId: googleId,
        name: payload.name,
        picture: payload.picture,
        createdAt: new Date().toISOString(),
        authProvider: 'google'
      };
      users[email] = user;
      saveUsers(users);

      // Create empty watchlist for new user
      saveWatchlist(userId, []);

      console.log(`New user registered via Google: ${email}`);
    } else {
      // Update existing user with Google ID if not already set
      if (!user.googleId) {
        user.googleId = googleId;
        user.authProvider = 'google';
        saveUsers(users);
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture
      }
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

// GET /api/auth/me - Get current user
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    user: { id: req.user.id, email: req.user.email }
  });
});

// GET /api/watchlist - Get user's watchlist
app.get('/api/watchlist', authenticateToken, (req, res) => {
  try {
    const watchlist = loadWatchlist(req.user.id);
    res.json({ watchlist });
  } catch (error) {
    console.error('Error getting watchlist:', error);
    res.status(500).json({ error: 'Failed to get watchlist' });
  }
});

// POST /api/watchlist/add - Add stock to watchlist
app.post('/api/watchlist/add', authenticateToken, (req, res) => {
  try {
    const { ticker } = req.body;

    if (!ticker) {
      return res.status(400).json({ error: 'Ticker is required' });
    }

    const tickerUpper = ticker.toUpperCase().trim();

    // Validate ticker format (1-5 letters)
    if (!/^[A-Z]{1,5}$/.test(tickerUpper)) {
      return res.status(400).json({ error: 'Invalid ticker format' });
    }

    const watchlist = loadWatchlist(req.user.id);

    // Check if already in watchlist
    if (watchlist.includes(tickerUpper)) {
      return res.status(400).json({ error: 'Stock already in watchlist' });
    }

    // Add to watchlist
    watchlist.push(tickerUpper);
    saveWatchlist(req.user.id, watchlist);

    console.log(`User ${req.user.email} added ${tickerUpper} to watchlist`);

    res.json({ success: true, watchlist });
  } catch (error) {
    console.error('Error adding to watchlist:', error);
    res.status(500).json({ error: 'Failed to add stock' });
  }
});

// DELETE /api/watchlist/remove/:ticker - Remove stock from watchlist
app.delete('/api/watchlist/remove/:ticker', authenticateToken, (req, res) => {
  try {
    const tickerUpper = req.params.ticker.toUpperCase().trim();

    let watchlist = loadWatchlist(req.user.id);
    const initialLength = watchlist.length;

    watchlist = watchlist.filter(t => t !== tickerUpper);

    if (watchlist.length === initialLength) {
      return res.status(404).json({ error: 'Stock not in watchlist' });
    }

    saveWatchlist(req.user.id, watchlist);

    console.log(`User ${req.user.email} removed ${tickerUpper} from watchlist`);

    res.json({ success: true, watchlist });
  } catch (error) {
    console.error('Error removing from watchlist:', error);
    res.status(500).json({ error: 'Failed to remove stock' });
  }
});

// GET /api/watchlist/prices - Get prices for stocks
app.get('/api/watchlist/prices', async (req, res) => {
  try {
    const tickersParam = req.query.tickers;

    if (!tickersParam) {
      return res.status(400).json({ error: 'Tickers parameter required' });
    }

    const tickers = tickersParam.split(',').map(t => t.trim().toUpperCase()).filter(t => t);

    if (tickers.length === 0) {
      return res.status(400).json({ error: 'No valid tickers provided' });
    }

    if (tickers.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 tickers allowed' });
    }

    // Fetch quotes for all tickers in parallel
    const prices = {};

    await Promise.all(tickers.map(async (ticker) => {
      try {
        const quote = await yahooFinance.quote(ticker);
        if (quote && quote.regularMarketPrice !== undefined) {
          prices[ticker] = {
            price: quote.regularMarketPrice,
            changePercent: quote.regularMarketChangePercent || 0,
            changeDollar: quote.regularMarketChange || 0,
            companyName: quote.shortName || quote.longName || ticker,
            previousClose: quote.regularMarketPreviousClose || null
          };
        }
      } catch (err) {
        console.error(`Failed to fetch quote for ${ticker}:`, err.message);
        // Return null price for failed tickers
        prices[ticker] = null;
      }
    }));

    res.json({ prices, asOf: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching prices:', error);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// ============================================
// MULTIPLE WATCHLISTS API ENDPOINTS
// ============================================

// GET /api/watchlists - Get all watchlists for user
app.get('/api/watchlists', authenticateToken, (req, res) => {
  try {
    const data = loadWatchlistData(req.user.id);
    res.json({
      defaultWatchlist: data.defaultWatchlist,
      watchlists: Object.values(data.watchlists)
    });
  } catch (error) {
    console.error('Error getting watchlists:', error);
    res.status(500).json({ error: 'Failed to get watchlists' });
  }
});

// POST /api/watchlists - Create new watchlist
app.post('/api/watchlists', authenticateToken, (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Watchlist name is required' });
    }

    const data = loadWatchlistData(req.user.id);

    // Limit check
    if (Object.keys(data.watchlists).length >= MAX_WATCHLISTS_PER_USER) {
      return res.status(400).json({ error: `Maximum ${MAX_WATCHLISTS_PER_USER} watchlists allowed` });
    }

    const watchlistId = generateWatchlistId();
    const now = new Date().toISOString();

    data.watchlists[watchlistId] = {
      id: watchlistId,
      name: name.trim().substring(0, MAX_WATCHLIST_NAME_LENGTH),
      tickers: [],
      createdAt: now,
      updatedAt: now
    };

    saveWatchlistData(req.user.id, data);

    console.log(`User ${req.user.email} created watchlist: ${name}`);

    res.json({
      success: true,
      watchlist: data.watchlists[watchlistId]
    });
  } catch (error) {
    console.error('Error creating watchlist:', error);
    res.status(500).json({ error: 'Failed to create watchlist' });
  }
});

// PUT /api/watchlists/:watchlistId - Rename watchlist
app.put('/api/watchlists/:watchlistId', authenticateToken, (req, res) => {
  try {
    const { watchlistId } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Watchlist name is required' });
    }

    const data = loadWatchlistData(req.user.id);

    if (!data.watchlists[watchlistId]) {
      return res.status(404).json({ error: 'Watchlist not found' });
    }

    data.watchlists[watchlistId].name = name.trim().substring(0, MAX_WATCHLIST_NAME_LENGTH);
    data.watchlists[watchlistId].updatedAt = new Date().toISOString();

    saveWatchlistData(req.user.id, data);

    console.log(`User ${req.user.email} renamed watchlist to: ${name}`);

    res.json({
      success: true,
      watchlist: data.watchlists[watchlistId]
    });
  } catch (error) {
    console.error('Error renaming watchlist:', error);
    res.status(500).json({ error: 'Failed to rename watchlist' });
  }
});

// DELETE /api/watchlists/:watchlistId - Delete watchlist
app.delete('/api/watchlists/:watchlistId', authenticateToken, (req, res) => {
  try {
    const { watchlistId } = req.params;
    const data = loadWatchlistData(req.user.id);

    if (!data.watchlists[watchlistId]) {
      return res.status(404).json({ error: 'Watchlist not found' });
    }

    // Prevent deleting the last watchlist
    if (Object.keys(data.watchlists).length === 1) {
      return res.status(400).json({ error: 'Cannot delete the last watchlist' });
    }

    const deletedName = data.watchlists[watchlistId].name;
    delete data.watchlists[watchlistId];

    // If deleted watchlist was default, set a new default
    if (data.defaultWatchlist === watchlistId) {
      data.defaultWatchlist = Object.keys(data.watchlists)[0];
    }

    saveWatchlistData(req.user.id, data);

    console.log(`User ${req.user.email} deleted watchlist: ${deletedName}`);

    res.json({
      success: true,
      defaultWatchlist: data.defaultWatchlist
    });
  } catch (error) {
    console.error('Error deleting watchlist:', error);
    res.status(500).json({ error: 'Failed to delete watchlist' });
  }
});

// PUT /api/watchlists/:watchlistId/default - Set as default watchlist
app.put('/api/watchlists/:watchlistId/default', authenticateToken, (req, res) => {
  try {
    const { watchlistId } = req.params;
    const data = loadWatchlistData(req.user.id);

    if (!data.watchlists[watchlistId]) {
      return res.status(404).json({ error: 'Watchlist not found' });
    }

    data.defaultWatchlist = watchlistId;
    saveWatchlistData(req.user.id, data);

    res.json({ success: true });
  } catch (error) {
    console.error('Error setting default watchlist:', error);
    res.status(500).json({ error: 'Failed to set default watchlist' });
  }
});

// POST /api/watchlists/:watchlistId/add - Add ticker to specific watchlist
app.post('/api/watchlists/:watchlistId/add', authenticateToken, (req, res) => {
  try {
    const { watchlistId } = req.params;
    const { ticker } = req.body;

    if (!ticker) {
      return res.status(400).json({ error: 'Ticker is required' });
    }

    const tickerUpper = ticker.toUpperCase().trim();

    if (!/^[A-Z]{1,5}$/.test(tickerUpper)) {
      return res.status(400).json({ error: 'Invalid ticker format' });
    }

    const data = loadWatchlistData(req.user.id);

    if (!data.watchlists[watchlistId]) {
      return res.status(404).json({ error: 'Watchlist not found' });
    }

    const watchlist = data.watchlists[watchlistId];

    if (watchlist.tickers.includes(tickerUpper)) {
      return res.status(400).json({ error: 'Stock already in watchlist' });
    }

    if (watchlist.tickers.length >= MAX_STOCKS_PER_WATCHLIST) {
      return res.status(400).json({ error: `Maximum ${MAX_STOCKS_PER_WATCHLIST} stocks per watchlist` });
    }

    watchlist.tickers.push(tickerUpper);
    watchlist.updatedAt = new Date().toISOString();

    saveWatchlistData(req.user.id, data);

    console.log(`User ${req.user.email} added ${tickerUpper} to watchlist "${watchlist.name}"`);

    res.json({ success: true, tickers: watchlist.tickers });
  } catch (error) {
    console.error('Error adding to watchlist:', error);
    res.status(500).json({ error: 'Failed to add stock' });
  }
});

// DELETE /api/watchlists/:watchlistId/remove/:ticker - Remove ticker from specific watchlist
app.delete('/api/watchlists/:watchlistId/remove/:ticker', authenticateToken, (req, res) => {
  try {
    const { watchlistId, ticker } = req.params;
    const tickerUpper = ticker.toUpperCase().trim();

    const data = loadWatchlistData(req.user.id);

    if (!data.watchlists[watchlistId]) {
      return res.status(404).json({ error: 'Watchlist not found' });
    }

    const watchlist = data.watchlists[watchlistId];
    const initialLength = watchlist.tickers.length;

    watchlist.tickers = watchlist.tickers.filter(t => t !== tickerUpper);

    if (watchlist.tickers.length === initialLength) {
      return res.status(404).json({ error: 'Stock not in watchlist' });
    }

    watchlist.updatedAt = new Date().toISOString();
    saveWatchlistData(req.user.id, data);

    console.log(`User ${req.user.email} removed ${tickerUpper} from watchlist "${watchlist.name}"`);

    res.json({ success: true, tickers: watchlist.tickers });
  } catch (error) {
    console.error('Error removing from watchlist:', error);
    res.status(500).json({ error: 'Failed to remove stock' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`[Cache Warming] Auto-refresh enabled for Market Update & S&P 500 market movers`);
  console.log(`[Cache Warming] Market Update: 7:30 AM, 9:31 AM, 11:31 AM, 1:31 PM, 3:31 PM, 4:00 PM, 6:00 PM ET`);
  console.log(`[Cache Warming] Top Movers: 9:31 AM, 11:31 AM, 1:31 PM, 3:31 PM, 4:00 PM ET`);
});
