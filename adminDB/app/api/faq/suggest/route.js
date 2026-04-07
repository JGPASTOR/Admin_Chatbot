import { NextResponse } from 'next/server';
import pool from '../../../../lib/db';

/* ── POST — extract FAQ proposals from a general document ──
   Body: { doc_id: number }
*/

const MIN_CHUNK = 150;
const MAX_CHUNK = 800;

function chunkText(text) {
    const sectionPattern = /(?=\bSECTION\s+\d+\b)/gi;
    const sections = text.split(sectionPattern);
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
    return { label: firstLine.slice(0, 60), topic: firstLine.slice(0, 80) };
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

    if (/\b(means|refers to|is defined as|is described as)\b/.test(body))
        return `What is ${stripped}?`;

    if (/\b(must|shall|required|requirement|comply|compliance)\b/.test(body))
        return `What are the requirements for ${stripped}?`;

    if (/\b(steps|procedure|process|how to|follow|submit|apply|accomplish)\b/.test(body))
        return `How do you ${stripped.toLowerCase()}?`;

    if (/\b(purpose|objective|goal|aim|intend|ensure)\b/.test(body))
        return `What is the purpose of ${stripped}?`;

    if (/\b(eligible|eligibility|qualify|qualified|who can)\b/.test(body))
        return `Who is eligible for ${stripped}?`;

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

        let text = '';
        if (extracted?.text) {
            text = extracted.text.trim();
        } else if (extracted?.sheets) {
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
                question: makeQuestion(topic, chunk),
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
