import { NextResponse } from 'next/server';
import pool from '../../../../lib/db';

export async function POST() {
    const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

    // ── Step 1: Rebuild the RAG index from all documents ──
    let ragResult = { total_chunks: 0 };
    try {
        console.log('[Rebuild] Triggering RAG rebuild...');
        const res = await fetch(`${aiEngineUrl}/api/rag/rebuild`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!res.ok) {
            return NextResponse.json(
                { success: false, error: data.detail || 'RAG rebuild failed' },
                { status: res.status }
            );
        }
        ragResult = data;
        console.log(`[Rebuild] RAG rebuilt — ${data.total_chunks} chunks indexed.`);
    } catch (err) {
        return NextResponse.json({ success: false, error: `Could not reach AI Engine: ${err.message}` }, { status: 503 });
    }

    // ── Step 2: Find documents with no FAQ proposals at all ──
    let faqGenerated = 0;
    let faqFailed = 0;
    try {
        // Docs that have zero rows in pending_faqs (never processed)
        const [unprocessed] = await pool.query(`
            SELECT gd.id, gd.original_name, gd.extracted_data
            FROM general_documents gd
            LEFT JOIN pending_faqs pf ON pf.doc_id = gd.id
            WHERE pf.id IS NULL
        `);

        if (unprocessed.length > 0) {
            console.log(`[Rebuild] ${unprocessed.length} documents have no FAQ proposals — generating now...`);

            const conn = await pool.getConnection();
            try {
                for (const doc of unprocessed) {
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
                            .join('\n\n').trim();
                    }

                    if (!text) continue;

                    // Call LLM-powered FAQ generator
                    let pairs = [];
                    try {
                        const faqRes = await fetch(`${aiEngineUrl}/api/faq/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ text, filename: doc.original_name }),
                            signal: AbortSignal.timeout(120_000),
                        });
                        if (faqRes.ok) {
                            const faqData = await faqRes.json();
                            if (faqData.success && Array.isArray(faqData.pairs)) {
                                pairs = faqData.pairs;
                            }
                        }
                    } catch (e) {
                        console.warn(`[Rebuild] FAQ generation failed for "${doc.original_name}":`, e.message);
                        faqFailed++;
                        continue;
                    }

                    if (pairs.length === 0) continue;

                    let autoApproved = 0;
                    for (const pair of pairs) {
                        const confidence = Number(pair.confidence ?? 5);
                        const status = confidence >= 8 ? 'approved' : 'pending';

                        await conn.query(
                            `INSERT INTO pending_faqs (doc_id, doc_name, section, question, answer, status, confidence_score)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [doc.id, doc.original_name, pair.section || '', pair.question, pair.answer, status, confidence]
                        );

                        if (status === 'approved') {
                            await conn.query(
                                'INSERT INTO faq_entries (question, answer, section, doc_id, doc_name) VALUES (?, ?, ?, ?, ?)',
                                [pair.question, pair.answer, pair.section || '', doc.id, doc.original_name]
                            );
                            autoApproved++;
                        }
                    }

                    faqGenerated += pairs.length;
                    console.log(`[Rebuild] "${doc.original_name}": ${pairs.length} FAQ pairs generated (${autoApproved} auto-approved).`);
                }
            } finally {
                conn.release();
            }

            // Reload FAQ cache in AI Engine if new entries were approved
            if (faqGenerated > 0) {
                try {
                    await fetch(`${aiEngineUrl}/api/faq`, { signal: AbortSignal.timeout(5000) });
                } catch { /* non-fatal */ }
            }
        }
    } catch (faqErr) {
        console.warn('[Rebuild] FAQ catch-up step error:', faqErr.message);
    }

    return NextResponse.json({
        success: true,
        total_chunks: ragResult.total_chunks,
        faq_pairs_generated: faqGenerated,
        faq_docs_failed: faqFailed,
        message: ragResult.message || 'Rebuild complete.',
    });
}
