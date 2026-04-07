import { NextResponse } from 'next/server';
import pool from '../../../../lib/db';

/* ── POST — generate FAQ proposals from a general document ──
   Body: { doc_id: number }

   Tries LLM-powered generation via the AI Engine first.
   Falls back to rule-based extraction if AI Engine is offline.
*/

// ── Text cleaner — strips decorative separator lines and junk before chunking ──
function cleanDocText(text) {
    return text
        .split('\n')
        .map(line => {
            const t = line.trim();
            // Drop lines that are 3+ repeated decorative characters (═══, ----, ====, etc.)
            if (/^([═=\-_*~─━▬•·\s])\1{2,}$/.test(t)) return '';
            // Drop lines that are mostly non-alphanumeric (likely table borders / art)
            if (t.length > 0 && (t.replace(/[^a-zA-Z0-9]/g, '').length / t.length) < 0.2) return '';
            return line;
        })
        .join('\n')
        // Collapse 3+ blank lines into 2
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── Rule-based fallback ──
const MIN_CHUNK = 150;
const MAX_CHUNK = 800;

function chunkText(text) {
    const sections = text.split(/(?=\bSECTION\s+\d+\b)/gi);
    const chunks = [];
    for (const section of sections) {
        const s = section.trim();
        if (!s) continue;
        const paragraphs = s.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length >= 30);
        let current = '';
        for (const para of paragraphs) {
            if ((current + '\n\n' + para).trim().length <= MAX_CHUNK) {
                current = current ? current + '\n\n' + para : para;
            } else {
                if (current.length >= MIN_CHUNK) chunks.push(current.trim());
                if (para.length > MAX_CHUNK) {
                    const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
                    let sub = '';
                    for (const sent of sentences) {
                        if ((sub + ' ' + sent).trim().length <= MAX_CHUNK) {
                            sub = sub ? sub + ' ' + sent : sent;
                        } else {
                            if (sub.length >= MIN_CHUNK) chunks.push(sub.trim());
                            sub = sent;
                        }
                    }
                    if (sub.length >= MIN_CHUNK) chunks.push(sub.trim());
                    current = '';
                } else {
                    current = para;
                }
            }
        }
        if (current.length >= MIN_CHUNK) chunks.push(current.trim());
    }
    return chunks;
}

function inferLabel(chunk) {
    const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';
    const secMatch = firstLine.match(/^SECTION\s+(\d+)\s*[—\-:.]?\s*(.*)/i);
    if (secMatch) {
        const num = secMatch[1];
        const topic = secMatch[2].trim();
        return { label: `Section ${num}`, topic: topic || `Section ${num}` };
    }
    if (firstLine === firstLine.toUpperCase() && firstLine.length > 3 && firstLine.length < 100)
        return { label: firstLine.slice(0, 60), topic: firstLine };
    if (firstLine.length < 80 && !firstLine.endsWith('.') && lines.length > 1)
        return { label: firstLine.slice(0, 60), topic: firstLine };
    return { label: firstLine.slice(0, 60), topic: firstLine };
}

function makeQuestion(topic, chunkBody) {
    const t = topic.trim();
    if (!t) return 'What does this section cover?';
    if (t.endsWith('?')) return t;
    const stripped = t.replace(/^SECTION\s+\d+\s*[—\-:.]?\s*/i, '').trim();
    if (!stripped) return `What is Section ${t}?`;
    const lower = stripped.toLowerCase();
    const body = (chunkBody || '').toLowerCase();
    if (/^(what|how|why|when|where|who|which|can|is|are|does|do)\b/.test(lower))
        return stripped.endsWith('?') ? stripped : stripped + '?';
    if (/\b(means|refers to|is defined as|is described as)\b/.test(body)) return `What is ${stripped}?`;
    if (/\b(must|shall|required|requirement|comply|compliance)\b/.test(body)) return `What are the requirements for ${stripped}?`;
    if (/\b(steps|procedure|process|how to|follow|submit|apply|accomplish)\b/.test(body)) return `How do you ${stripped.toLowerCase()}?`;
    if (/\b(purpose|objective|goal|aim|intend|ensure)\b/.test(body)) return `What is the purpose of ${stripped}?`;
    if (/\b(eligible|eligibility|qualify|qualified|who can)\b/.test(body)) return `Who is eligible for ${stripped}?`;
    return `What is ${stripped}?`;
}

function ruleBasedProposals(text) {
    return chunkText(text).map((chunk, idx) => {
        const { label, topic } = inferLabel(chunk);
        return {
            index: idx,
            section: label,
            question: makeQuestion(topic, chunk),
            answer: chunk,
            confidence: null,
            preview: chunk.slice(0, 120) + (chunk.length > 120 ? '…' : ''),
        };
    });
}

export async function POST(request) {
    try {
        const { doc_id } = await request.json();
        if (!doc_id) {
            return NextResponse.json({ success: false, error: 'doc_id is required.' }, { status: 400 });
        }

        const [rows] = await pool.query('SELECT * FROM general_documents WHERE id = ?', [doc_id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Document not found.' }, { status: 404 });
        }

        const doc = rows[0];
        let extracted = doc.extracted_data;
        if (typeof extracted === 'string') {
            try { extracted = JSON.parse(extracted); } catch { extracted = {}; }
        }

        let text = '';
        if (extracted?.text) {
            text = extracted.text.trim();
        } else if (extracted?.sheets) {
            text = Object.entries(extracted.sheets)
                .map(([name, sheetRows]) => `${name}:\n${sheetRows.map(r => r.join('\t')).join('\n')}`)
                .join('\n\n')
                .trim();
        }

        if (!text) {
            return NextResponse.json({ success: false, error: 'No readable text found in this document.' }, { status: 400 });
        }

        // Strip decorative lines before any processing
        text = cleanDocText(text);

        // ── Try LLM-powered generation first ──
        const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
        let proposals = [];
        let usedLLM = false;

        try {
            const aiRes = await fetch(`${aiEngineUrl}/api/faq/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, filename: doc.original_name }),
                signal: AbortSignal.timeout(120_000),
            });

            if (aiRes.ok) {
                const aiData = await aiRes.json();
                const pairs = Array.isArray(aiData.pairs) ? aiData.pairs : [];
                if (pairs.length > 0) {
                    proposals = pairs.map((p, idx) => ({
                        index: idx,
                        section: p.section || '',
                        question: p.question,
                        answer: p.answer,
                        confidence: p.confidence ?? null,
                        preview: p.answer.slice(0, 120) + (p.answer.length > 120 ? '…' : ''),
                    }));
                    usedLLM = true;
                }
            } else {
                console.warn('[FAQ Suggest] AI Engine returned', aiRes.status);
            }
        } catch (aiErr) {
            console.warn('[FAQ Suggest] AI Engine unreachable, using fallback:', aiErr.message);
        }

        // ── Fall back to rule-based if LLM failed ──
        if (proposals.length === 0) {
            proposals = ruleBasedProposals(text);
        }

        return NextResponse.json({
            success: true,
            filename: doc.original_name,
            total: proposals.length,
            proposals,
            llm: usedLLM,
        });
    } catch (err) {
        console.error('[FAQ Suggest]', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
