require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

const SEC_API_KEY = process.env.SEC_API_KEY;
const EARNINGSCALL_API_KEY = process.env.EARNINGSCALL_API_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

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
  return fs.readFileSync('/Users/jackcahn/retailbbg/memo-template.txt', 'utf8');
}

// Load AI instructions from external file (edit ai-instructions.txt and save - no restart needed)
function getAIInstructions() {
  const content = fs.readFileSync('/Users/jackcahn/retailbbg/ai-instructions.txt', 'utf8');
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

    const report = firstDraft.choices[0].message.content;

    // Convert markdown to HTML
    const html = convertReportToHTML(report, ticker.toUpperCase(), realStockPrice);

    // Save to cache (save both markdown and HTML)
    saveToCache(ticker, report, html);
    const v1Duration = ((Date.now() - v1StartTime) / 1000).toFixed(1);
    console.log(`Generated and cached new report for ${ticker.toUpperCase()} in ${v1Duration}s`);

    res.json({ report, html, cached: false, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
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

    // Clean up any citation links
    let answer = response.output_text
      .replace(/\(\[.*?\]\(.*?\)\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    res.json({ answer });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process question' });
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
  DOW30: [
    'AAPL', 'AMGN', 'AXP', 'BA', 'CAT', 'CRM', 'CSCO', 'CVX', 'DIS', 'DOW',
    'GS', 'HD', 'HON', 'IBM', 'INTC', 'JNJ', 'JPM', 'KO', 'MCD', 'MMM',
    'MRK', 'MSFT', 'NKE', 'PG', 'TRV', 'UNH', 'V', 'VZ', 'WBA', 'WMT'
  ],
  NASDAQ100: [
    'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'TSLA', 'AVGO', 'COST', 'PEP',
    'ADBE', 'CSCO', 'NFLX', 'AMD', 'INTC', 'CMCSA', 'TMUS', 'QCOM', 'TXN', 'AMGN',
    'INTU', 'AMAT', 'ISRG', 'BKNG', 'HON', 'SBUX', 'VRTX', 'GILD', 'ADI', 'ADP',
    'MDLZ', 'LRCX', 'REGN', 'PANW', 'PYPL', 'MU', 'KLAC', 'SNPS', 'MRVL', 'CDNS'
  ],
  SP500: [
    'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'TSLA', 'BRK.B', 'UNH', 'XOM',
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
  'BRK.B': 'Berkshire Hathaway',
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

    // Fetch explanations in parallel
    const explanationPromises = [
      ...winnersToExplain.map(async (stock) => {
        stock.explanation = await searchStockMovementReason(stock.ticker, stock.companyName, stock.changePercent);
        return stock;
      }),
      ...losersToExplain.map(async (stock) => {
        stock.explanation = await searchStockMovementReason(stock.ticker, stock.companyName, stock.changePercent);
        return stock;
      })
    ];

    await Promise.all(explanationPromises);

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

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
