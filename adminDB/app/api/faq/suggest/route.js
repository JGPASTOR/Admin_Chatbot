import { NextResponse } from 'next/server';
import pool from '../../../../lib/db';

/* ── POST — extract FAQ proposals from a general document ──
   Body: { doc_id: number }

   Strategy: chunk the full document text using the same sliding-window
   approach as the AI Engine RAG. Every chunk becomes a proposed FAQ entry.
   The "question" is auto-generated from the first meaningful line of the chunk.
   This covers ALL content — sections, paragraphs, lists, tables, etc.
*/

const CHUNK_SIZE = 500;
const OVERLAP = 100;

function chunkText(text) {
    // First split on SECTION headers so sections are never merged across chunks
    const sectionPattern = /(?=\bSECTION\s+\d+\b)/gi;
    const sections = text.split(sectionPattern);
    const chunks = [];

    for (const section of sections) {
        const s = section.trim();
        if (!s) continue;

        if (s.length <= CHUNK_SIZE) {
            chunks.push(s);
        } else {
            // Sliding window within the section
            let start = 0;
            while (start < s.length) {
                const chunk = s.slice(start, start + CHUNK_SIZE).trim();
                if (chunk) chunks.push(chunk);
                start += CHUNK_SIZE - OVERLAP;
            }
        }
    }

    return chunks;
}

function inferLabel(chunkText) {
    const lines = chunkText.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';

    // SECTION N — TOPIC
    const secMatch = firstLine.match(/^SECTION\s+(\d+)\s*[—\-:.]?\s*(.*)/i);
    if (secMatch) {
        const num = secMatch[1];
        const topic = secMatch[2].trim();
        return { label: `Section ${num}`, topic: topic || `Section ${num}` };
    }

    // ALL-CAPS header line (e.g. "LGU VISION", "CITY DEVELOPMENT GOALS")
    if (firstLine === firstLine.toUpperCase() && firstLine.length > 3 && firstLine.length < 80) {
        return { label: firstLine.slice(0, 40), topic: firstLine };
    }

    // Title-Case header or short line (< 80 chars, no period at end)
    if (firstLine.length < 80 && !firstLine.endsWith('.') && lines.length > 1) {
        return { label: firstLine.slice(0, 40), topic: firstLine };
    }

    // Generic fallback — use first 40 chars
    return { label: firstLine.slice(0, 40), topic: firstLine.slice(0, 60) };
}

function makeQuestion(topic) {
    const t = topic.trim();
    if (!t) return 'Tell me more about this.';

    // Already a question
    if (t.endsWith('?')) return t;

    // Remove leading "SECTION N —" if present
    const stripped = t.replace(/^SECTION\s+\d+\s*[—\-:.]?\s*/i, '').trim();

    if (!stripped) return `What is ${t}?`;

    const lower = stripped.toLowerCase();
    if (lower.startsWith('what') || lower.startsWith('how') || lower.startsWith('why') ||
        lower.startsWith('when') || lower.startsWith('where') || lower.startsWith('who')) {
        return stripped;
    }
    return `What is ${stripped}?`;
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

        // Support PDF/DOCX (text) and spreadsheets (sheets → flattened text)
        let text = '';
        if (extracted?.text) {
            text = extracted.text.trim();
        } else if (extracted?.sheets) {
            // Flatten spreadsheet rows into readable text
            text = Object.entries(extracted.sheets)
                .map(([name, rows]) => `${name}:\n${rows.map(r => r.join('\t')).join('\n')}`)
                .join('\n\n')
                .trim();
        }

        if (!text) {
            return NextResponse.json({
                success: false,
                error: 'No readable text found in this document.',
            }, { status: 400 });
        }

        const chunks = chunkText(text);
        const proposals = chunks.map((chunk, idx) => {
            const { label, topic } = inferLabel(chunk);
            return {
                index: idx,
                section: label,
                question: makeQuestion(topic),
                answer: chunk,
                preview: chunk.slice(0, 120) + (chunk.length > 120 ? '…' : ''),
            };
        });

        return NextResponse.json({
            success: true,
            filename: doc.original_name,
            total: proposals.length,
            proposals,
        });
    } catch (err) {
        console.error('[FAQ Suggest]', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
