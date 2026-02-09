require('dotenv').config({ path: '/Users/jackcahn/retailbbg/.env' });
const OpenAI = require('openai');
const fs = require('fs');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// AVGO context data for all prompts
const avgoContext = `
Company: Broadcom Inc. (AVGO)
Sector: Semiconductors / Infrastructure Software
Market Cap: ~$750B
Forward P/E: 14x
Key Business Lines: Semiconductors (networking, broadband, storage), Infrastructure Software (VMware)
Recent: Acquired VMware for $69B in late 2023
Strengths: #1 in AI networking (custom silicon for hyperscalers), dominant semiconductor franchises, best-in-class FCF margins (50%+)
Growth Drivers: AI networking boom, VMware synergies, 5G infrastructure
`;

// Approach 1: Few-shot example
const prompt1 = `Here is an example of the writing style I want for investment theses:

EXAMPLE (for reference style only):
"Dominant semiconductor franchise with unmatched FCF generation. VMware acquisition transforms the business into an infrastructure software powerhouse. AI networking tailwinds accelerating. Trading at discount to intrinsic value despite best-in-class capital allocation."

Now write an Investment Thesis for Broadcom (AVGO) using this exact style - punchy, short sentences, confident, direct.

Company Data:
${avgoContext}

Write ONLY the Investment Thesis section (3-4 sentences). Match the example style exactly.`;

// Approach 2: Style instructions
const prompt2 = `Write an Investment Thesis for Broadcom (AVGO).

WRITING STYLE REQUIREMENTS:
- Use short, punchy sentences (under 12 words each)
- Be confident and direct - no hedging language
- NO filler phrases like "positions the company", "compelling opportunity", "risk/reward proposition"
- NO phrases like "benefiting from", "enhancing", "represents a"
- Sound like a senior Goldman Sachs analyst writing for the trading desk
- State facts and conclusions only - no explanations
- Use strong, active verbs

Company Data:
${avgoContext}

Write ONLY the Investment Thesis (3-4 sentences).`;

// Approach 3: Negative examples
const prompt3 = `Write an Investment Thesis for Broadcom (AVGO).

DO NOT write like this (BAD - too verbose, generic, filler-laden):
"Broadcom commands a dominant position in semiconductors with industry-leading FCF generation, benefiting from secular trends in AI and 5G. Its acquisition of VMware positions the company as an infrastructure software leader, enhancing revenue diversification and synergies. Despite trading at 14x forward earnings, AVGO presents a compelling risk/reward proposition."

Problems with the bad example:
- "commands a dominant position" - wordy
- "benefiting from secular trends" - filler
- "positions the company" - corporate speak
- "enhancing revenue diversification and synergies" - buzzwords
- "compelling risk/reward proposition" - cliche

WRITE like this (GOOD - punchy, direct, confident):
"[Company] dominates [market]. [Key catalyst] transforms the business. [Growth driver] accelerating. Trading at discount to intrinsic value."

Company Data:
${avgoContext}

Write ONLY the Investment Thesis (3-4 sentences). Be punchy and direct.`;

// Approach 4: Role-play persona
const prompt4 = `You are a senior semiconductor analyst at Goldman Sachs with 20 years of experience. You're writing a quick thesis for the trading desk - they want facts, not fluff. You've covered Broadcom since its Avago days and know the business cold.

Write your Investment Thesis for AVGO. Remember:
- Trading desk wants it fast - short sentences only
- No disclaimers, no hedging
- You're confident in your call
- Write like you're telling a portfolio manager why to buy NOW

Company Data:
${avgoContext}

Write ONLY the Investment Thesis (3-4 sentences).`;

// Approach 5: Minimalist
const prompt5 = `Write a Goldman Sachs investment thesis for Broadcom (AVGO). Be punchy and direct. Short sentences only. No filler. 3-4 sentences.

${avgoContext}`;

const approaches = [
  { name: "Few-shot Example", prompt: prompt1, description: "Includes the mockup thesis as a style example to follow" },
  { name: "Style Instructions", prompt: prompt2, description: "Detailed instructions about writing style (short sentences, no filler, punchy)" },
  { name: "Negative Examples", prompt: prompt3, description: "Shows what NOT to write alongside what TO write" },
  { name: "Role-play Persona", prompt: prompt4, description: "Senior GS analyst writing for trading desk" },
  { name: "Minimalist", prompt: prompt5, description: "Simple directive: 'Be punchy and direct'" }
];

async function runExperiment(approach, index) {
  console.log(`\nRunning Approach ${index + 1}: ${approach.name}...`);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "user", content: approach.prompt }
      ],
      temperature: 0.7,
      max_tokens: 300
    });

    const thesis = response.choices[0].message.content;

    const output = `APPROACH ${index + 1}: ${approach.name}
${'='.repeat(60)}

DESCRIPTION:
${approach.description}

PROMPT USED:
${'-'.repeat(40)}
${approach.prompt}
${'-'.repeat(40)}

GENERATED THESIS:
${'-'.repeat(40)}
${thesis}
${'-'.repeat(40)}

NOTES:
- Model: gpt-4o
- Temperature: 0.7
`;

    const filename = `/Users/jackcahn/retailbbg/experiments/approach_${index + 1}.txt`;
    fs.writeFileSync(filename, output);
    console.log(`Saved to ${filename}`);

    return { approach: approach.name, thesis, index: index + 1 };
  } catch (error) {
    console.error(`Error in approach ${index + 1}:`, error.message);
    return { approach: approach.name, thesis: `ERROR: ${error.message}`, index: index + 1 };
  }
}

async function main() {
  console.log("Starting Investment Thesis Prompt Experiments");
  console.log("=".repeat(60));

  const results = [];

  for (let i = 0; i < approaches.length; i++) {
    const result = await runExperiment(approaches[i], i);
    results.push(result);
  }

  // Create summary file
  const targetThesis = `"Dominant semiconductor franchise with unmatched FCF generation. VMware acquisition transforms the business into an infrastructure software powerhouse. AI networking tailwinds accelerating. Trading at discount to intrinsic value despite best-in-class capital allocation."`;

  let summary = `INVESTMENT THESIS PROMPT EXPERIMENTS - SUMMARY
${'='.repeat(80)}

TARGET STYLE (from mockup):
${targetThesis}

BAD STYLE (current v2 output):
"Broadcom commands a dominant position in semiconductors with industry-leading FCF generation, benefiting from secular trends in AI and 5G. Its acquisition of VMware positions the company as an infrastructure software leader, enhancing revenue diversification and synergies. Despite trading at 14x forward earnings, AVGO presents a compelling risk/reward proposition."

${'='.repeat(80)}
RESULTS COMPARISON
${'='.repeat(80)}

`;

  for (const result of results) {
    summary += `
APPROACH ${result.index}: ${result.approach}
${'-'.repeat(60)}
${result.thesis}

`;
  }

  summary += `
${'='.repeat(80)}
EVALUATION CRITERIA
${'='.repeat(80)}

When evaluating each approach, consider:
1. Sentence length - Are sentences short and punchy (under 12 words)?
2. Filler phrases - Does it avoid "positions the company", "compelling opportunity", etc.?
3. Confidence - Is it direct and assertive?
4. Specificity - Does it mention concrete details (VMware, AI networking, FCF)?
5. Tone - Does it sound like a Goldman analyst?

RECOMMENDATION: [Manual review needed - compare outputs above]
`;

  fs.writeFileSync('/Users/jackcahn/retailbbg/experiments/summary.txt', summary);
  console.log("\nSaved summary to /Users/jackcahn/retailbbg/experiments/summary.txt");
  console.log("\nDone!");
}

main();
