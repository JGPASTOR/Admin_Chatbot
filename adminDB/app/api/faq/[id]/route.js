import pool from '../../../../lib/db';
import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

async function notifyEngine(path, method, body) {
    try {
        await fetch(`${AI_ENGINE}/api/faq${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000),
        });
    } catch { /* AI Engine offline */ }
}

/* ── PUT ── */
export async function PUT(request, { params }) {
    try {
        const { id } = await params;
        const body = await request.json();
        const question = body?.question?.trim();
        const answer = body?.answer?.trim();
        const section = body?.section?.trim() || null;

        const conn = await pool.getConnection();
        try {
            const [rows] = await conn.query('SELECT id FROM `faq_entries` WHERE id = ?', [id]);
            if (rows.length === 0) {
                return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });
            }
            await conn.query(
                'UPDATE `faq_entries` SET `question`=?, `answer`=?, `section`=?, `updated_at`=NOW() WHERE id=?',
                [question, answer, section, id]
            );
        } finally {
            conn.release();
        }

        notifyEngine(`/${id}`, 'PUT', { question, answer, section });
        return NextResponse.json({ success: true, message: 'Updated.', id: Number(id) });
    } catch (err) {
        console.error('[FAQ PUT]', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── DELETE ── */
export async function DELETE(request, { params }) {
    try {
        const { id } = await params;

        const conn = await pool.getConnection();
        try {
            const [rows] = await conn.query('SELECT id FROM `faq_entries` WHERE id = ?', [id]);
            if (rows.length === 0) {
                return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });
            }
            await conn.query('DELETE FROM `faq_entries` WHERE id = ?', [id]);
        } finally {
            conn.release();
        }

        notifyEngine(`/${id}`, 'DELETE');
        return NextResponse.json({ success: true, message: `FAQ entry ${id} deleted.` });
    } catch (err) {
        console.error('[FAQ DELETE]', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
