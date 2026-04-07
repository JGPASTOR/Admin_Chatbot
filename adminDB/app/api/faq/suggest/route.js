import { NextResponse } from 'next/server';
import pool from '../../../../lib/db';

/* ── POST — extract FAQ proposals from a general document ──
   Body: { doc_id: number }
   Fetches the document from the local DB, parses SECTION headers,
   and returns proposed Q&A pairs for the admin to review.
   Does NOT call the AI Engine — pure text processing.
*/
export async function POST(request) {
    try {
        const { doc_id } = await request.json();
        if (!doc_id) {
            return NextResponse.json({ success: false, error: 'doc_id is required.' }, { status: 400 });
        }

        // Fetch document from local DB
        const [rows] = await pool.query('SELECT * FROM general_documents WHERE id = ?', [doc_id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Document not found.' }, { status: 404 });
        }

        const doc = rows[0];
        let extracted = doc.extracted_data;
        if (typeof extracted === 'string') {
            try { extracted = JSON.parse(extracted); } catch { extracted = {}; }
        }

        const text = (extracted?.text || '').trim();
        if (!text) {
            return NextResponse.json({ success: false, error: 'This document has no extracted text. Only PDF, DOCX, and DOC files are supported.' }, { status: 400 });
        }

        // Split on SECTION headers
        const sectionPattern = /(?=\bSECTION\s+\d+\b)/gi;
        const rawSections = text.split(sectionPattern);

        const proposals = [];
        for (const raw of rawSections) {
            const trimmed = raw.trim();
            if (!trimmed) continue;

            const lines = trimmed.split('\n');
            const header = lines.find(l => l.trim())?.trim() || '';
            if (!header) continue;

            const bodyLines = lines.slice(lines.findIndex(l => l.trim()) + 1);
            const body = bodyLines.filter(l => l.trim()).join('\n').trim();
            if (!body && !header) continue;

            // Section label e.g. "Section 3"
            const numMatch = header.match(/section\s+(\d+)/i);
            const sectionLabel = numMatch ? `Section ${numMatch[1]}` : header.slice(0, 40);

            // Generate question from the topic part of the header
            const topic = header.replace(/^\s*SECTION\s+\d+\s*[—\-:.]*\s*/i, '').trim();
            const question = topic
                ? `What is ${topic}?`
                : `What is ${sectionLabel}?`;

            proposals.push({
                section: sectionLabel,
                question,
                answer: body.slice(0, 2000) || header,
                header,
            });
        }

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
