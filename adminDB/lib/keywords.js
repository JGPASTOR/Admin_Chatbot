// Simple keyword extraction using TF-IDF-like scoring

const STOP_WORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
    'from','is','are','was','were','be','been','being','have','has','had','do',
    'does','did','will','would','could','should','may','might','shall','can',
    'this','that','these','those','it','its','he','she','they','we','you','i',
    'not','no','nor','so','yet','both','either','neither','each','few','more',
    'most','other','some','such','than','too','very','just','also','as','if',
    'all','any','both','each','how','what','which','who','whom','when','where',
    'why','there','here','then','now','up','out','about','into','through','during',
    'before','after','above','below','between','own','same','than','further',
    'once','per','via','within','without','while','because','since','until',
    'although','though','even','whether','unless','however','therefore','thus',
    'hence','moreover','furthermore','meanwhile','indeed','instead','otherwise',
    'nevertheless','nonetheless','accordingly','consequently','subsequently',
    'shall','upon','pursuant','provided','thereof','therein','thereto','hereby',
    'herein','heretofore','hereunder','whereas','whereby','wherein',
    'section','article','rule','said','such','set','forth',
]);

/**
 * Extract top keywords from document text.
 * @param {string} text - The document text
 * @param {number} topN - Number of keywords to return (default 20)
 * @returns {string[]} - Array of keywords sorted by relevance
 */
export function extractKeywords(text, topN = 20) {
    if (!text || typeof text !== 'string') return [];

    // Normalize: lowercase, remove special chars but keep hyphens
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s\-]/g, ' ');

    // Tokenize
    const tokens = normalized.split(/\s+/).filter(t => t.length > 2 && !t.match(/^\d+$/));

    // Filter stop words and short tokens
    const words = tokens.filter(t => !STOP_WORDS.has(t) && t.length >= 3);

    // Count term frequencies
    const freq = {};
    for (const w of words) {
        freq[w] = (freq[w] || 0) + 1;
    }

    // Also extract meaningful bigrams
    const bigrams = {};
    for (let i = 0; i < tokens.length - 1; i++) {
        const a = tokens[i], b = tokens[i + 1];
        if (!STOP_WORDS.has(a) && !STOP_WORDS.has(b) && a.length >= 3 && b.length >= 3) {
            const bg = `${a} ${b}`;
            bigrams[bg] = (bigrams[bg] || 0) + 1;
        }
    }

    // Score unigrams: tf * log(1 + length) bonus for longer meaningful words
    const totalTokens = words.length || 1;
    const scored = Object.entries(freq)
        .filter(([, count]) => count >= 2)
        .map(([word, count]) => ({
            term: word,
            score: (count / totalTokens) * Math.log(1 + word.length),
        }));

    // Score bigrams (higher weight for repeated bigrams)
    const scoredBigrams = Object.entries(bigrams)
        .filter(([, count]) => count >= 2)
        .map(([bigram, count]) => ({
            term: bigram,
            score: (count / totalTokens) * 2.5,
        }));

    // Merge and sort
    const allTerms = [...scored, ...scoredBigrams]
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);

    return allTerms.map(t => t.term);
}

/**
 * Extract keywords from document extracted_data object.
 * Handles PDF/DOCX (text field) and spreadsheets (sheets field).
 */
export function extractKeywordsFromDoc(extractedData) {
    let text = '';
    if (extractedData?.text) {
        text = extractedData.text;
    } else if (extractedData?.sheets) {
        text = Object.entries(extractedData.sheets)
            .map(([name, rows]) => `${name} ${rows.map(r => r.join(' ')).join(' ')}`)
            .join(' ');
    }
    return extractKeywords(text, 25);
}
