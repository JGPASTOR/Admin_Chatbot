import { NextResponse } from 'next/server';
import pool from '../../../../lib/db';

/* ── POST — generate FAQ proposals from a general document via LLM ──
   Body: { doc_id: number }

   Delegates to the AI Engine's /api/faq/generate endpoint which uses the
   local LLM (Ollama) to produce real questions and accurate answers grounded
   in the document text — not dumb regex templates.
*/

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
            return NextResponse.json({
                success: false,
                error: 'No readable text found in this document.',
            }, { status: 400 });
        }

        // Delegate to AI Engine LLM-powered generator
        const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
        let pairs = [];

        try {
            const aiRes = await fetch(`${aiEngineUrl}/api/faq/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, filename: doc.original_name }),
                signal: AbortSignal.timeout(120_000), // LLM can be slow
            });

            if (aiRes.ok) {
                const aiData = await aiRes.json();
                pairs = Array.isArray(aiData.pairs) ? aiData.pairs : [];
            } else {
                const err = await aiRes.text();
                console.warn('[FAQ Suggest] AI Engine error:', err);
            }
        } catch (aiErr) {
            console.warn('[FAQ Suggest] Could not reach AI Engine:', aiErr.message);
        }

        if (pairs.length === 0) {
            return NextResponse.json({
                success: false,
                error: 'The LLM could not generate FAQ pairs for this document. Make sure the AI Engine and LLM service are running.',
            }, { status: 503 });
        }

        // Map AI Engine pairs → same shape the UI expects
        const proposals = pairs.map((p, idx) => ({
            index: idx,
            section: p.section || '',
            question: p.question,
            answer: p.answer,
            confidence: p.confidence ?? null,
            preview: p.answer.slice(0, 120) + (p.answer.length > 120 ? '…' : ''),
        }));

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
