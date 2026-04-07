import { NextResponse } from 'next/server';
import pool from '../../../../lib/db';

/* PUT — approve or reject a single pending FAQ (with optional edits) */
export async function PUT(request, { params }) {
    try {
        const id = Number(params.id);
        const body = await request.json();
        const { action, question, answer, section } = body;
        // action: 'approve' | 'reject'

        const [rows] = await pool.query('SELECT * FROM pending_faqs WHERE id = ?', [id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });
        }
        const p = rows[0];

        if (action === 'approve') {
            const finalQ = (question || p.question).trim();
            const finalA = (answer || p.answer).trim();
            const finalS = (section !== undefined ? section : p.section)?.trim() || null;

            await pool.query(
                'INSERT INTO faq_entries (question, answer, section, doc_id, doc_name) VALUES (?, ?, ?, ?, ?)',
                [finalQ, finalA, finalS, p.doc_id ?? null, p.doc_name ?? null]
            );
            await pool.query("UPDATE pending_faqs SET status = 'approved' WHERE id = ?", [id]);

            // Push new entry into AI Engine's in-memory cache
            try {
                const aiUrl = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
                await fetch(`${aiUrl}/api/faq`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question: finalQ, answer: finalA, section: finalS }),
                    signal: AbortSignal.timeout(5000),
                });
            } catch { /* non-fatal — bot picks it up on next restart */ }

            return NextResponse.json({ success: true, action: 'approved' });
        }

        if (action === 'reject') {
            await pool.query("UPDATE pending_faqs SET status = 'rejected' WHERE id = ?", [id]);
            return NextResponse.json({ success: true, action: 'rejected' });
        }

        return NextResponse.json({ success: false, error: 'action must be approve or reject.' }, { status: 400 });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* DELETE — hard delete a pending FAQ entry */
export async function DELETE(request, { params }) {
    try {
        const id = Number(params.id);
        await pool.query('DELETE FROM pending_faqs WHERE id = ?', [id]);
        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
