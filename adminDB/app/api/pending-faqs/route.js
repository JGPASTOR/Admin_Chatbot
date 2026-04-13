import { NextResponse } from 'next/server';
import pool from '../../../lib/db';

/* GET — list pending FAQs with optional status filter */
export async function GET(request) {
    try {
        const { searchParams } = new URL(request.url);
        const status = searchParams.get('status') || 'pending';
        const doc_id = searchParams.get('doc_id');

        let sql = 'SELECT * FROM pending_faqs WHERE status = ?';
        const params = [status];

        if (doc_id) {
            sql += ' AND doc_id = ?';
            params.push(Number(doc_id));
        }

        sql += ' ORDER BY created_at DESC';

        const [rows] = await pool.query(sql, params);
        return NextResponse.json({ success: true, data: rows });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* POST — bulk approve selected IDs */
export async function POST(request) {
    try {
        const { ids, edits } = await request.json();
        // ids: number[]
        // edits: { [id]: { question?, answer?, section? } } — optional per-item overrides

        if (!Array.isArray(ids) || ids.length === 0) {
            return NextResponse.json({ success: false, error: 'ids array is required.' }, { status: 400 });
        }

        const aiUrl = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
        const conn = await pool.getConnection();
        try {
            let approved = 0;
            for (const id of ids) {
                const override = edits?.[id];
                const [rows] = await conn.query('SELECT * FROM pending_faqs WHERE id = ?', [id]);
                if (rows.length === 0) continue;
                const p = rows[0];

                const question = override?.question?.trim() || p.question;
                const answer = override?.answer?.trim() || p.answer;
                const section = override?.section?.trim() || p.section;

                // Skip insert if this question already exists in faq_entries (prevents duplicates)
                const [existingFaq] = await conn.query(
                    'SELECT id FROM faq_entries WHERE LOWER(TRIM(question)) = LOWER(TRIM(?)) LIMIT 1',
                    [question]
                );
                if (existingFaq.length === 0) {
                    await conn.query(
                        'INSERT INTO faq_entries (question, answer, section, doc_id, doc_name) VALUES (?, ?, ?, ?, ?)',
                        [question, answer, section, p.doc_id ?? null, p.doc_name ?? null]
                    );
                }

                // Mark as approved
                await conn.query("UPDATE pending_faqs SET status = 'approved' WHERE id = ?", [id]);
                approved++;

                // Push into AI Engine's in-memory cache immediately
                try {
                    await fetch(`${aiUrl}/api/faq`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ question, answer, section: section || null }),
                        signal: AbortSignal.timeout(5000),
                    });
                } catch { /* non-fatal */ }
            }

            return NextResponse.json({ success: true, approved });
        } finally {
            conn.release();
        }
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* DELETE — bulk reject / delete pending FAQs */
export async function DELETE(request) {
    try {
        const { ids } = await request.json();
        if (!Array.isArray(ids) || ids.length === 0) {
            return NextResponse.json({ success: false, error: 'ids array is required.' }, { status: 400 });
        }
        const placeholders = ids.map(() => '?').join(',');
        await pool.query(`UPDATE pending_faqs SET status = 'rejected' WHERE id IN (${placeholders})`, ids);
        return NextResponse.json({ success: true, rejected: ids.length });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
