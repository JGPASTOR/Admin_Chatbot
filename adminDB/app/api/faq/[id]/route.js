import pool from '../../../../lib/db';
import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

async function notifyEngine(path, method, body) {
    try {
        await fetch(`${AI_ENGINE}/api/faq${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000),
        });
    } catch {
        // AI Engine offline — cache syncs on next restart
    }
}

/* ── PUT — update a FAQ entry ── */
export async function PUT(request, { params }) {
    try {
        const { id } = await params;
        const { question, answer, section } = await request.json();

        const [rows] = await pool.query('SELECT id FROM faq_entries WHERE id = ?', [id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });
        }

        await pool.query(
            'UPDATE faq_entries SET question = ?, answer = ?, section = ?, updated_at = NOW() WHERE id = ?',
            [question?.trim(), answer?.trim(), section?.trim() || null, id]
        );

        // Sync AI Engine cache
        notifyEngine(`/${id}`, 'PUT', { question: question?.trim(), answer: answer?.trim(), section: section?.trim() || null });

        return NextResponse.json({ success: true, message: 'FAQ entry updated.', id: Number(id) });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── DELETE — remove a FAQ entry ── */
export async function DELETE(request, { params }) {
    try {
        const { id } = await params;

        const [rows] = await pool.query('SELECT id FROM faq_entries WHERE id = ?', [id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });
        }

        await pool.query('DELETE FROM faq_entries WHERE id = ?', [id]);

        // Sync AI Engine cache
        notifyEngine(`/${id}`, 'DELETE');

        return NextResponse.json({ success: true, message: `FAQ entry ${id} deleted.` });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
