import pool from '../../../lib/db';
import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

// Run once per process — guarantees the table exists regardless of restart order
let _tableReady = false;
async function ensureTable() {
    if (_tableReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS \`faq_entries\` (
            \`id\`         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
            \`question\`   TEXT         NOT NULL,
            \`answer\`     TEXT         NOT NULL,
            \`section\`    VARCHAR(100) DEFAULT NULL,
            \`created_at\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    _tableReady = true;
}

// Tell the AI Engine to hot-reload its FAQ cache (fire-and-forget)
async function notifyEngine(action, payload) {
    try {
        const url = `${AI_ENGINE}/api/faq${action}`;
        const method = payload?.method || 'POST';
        await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: payload?.body ? JSON.stringify(payload.body) : undefined,
            signal: AbortSignal.timeout(5000),
        });
    } catch {
        // AI Engine might be offline — cache will sync on next restart
    }
}

/* ── GET — list all FAQ entries ── */
export async function GET() {
    try {
        await ensureTable();
        const [rows] = await pool.query(
            'SELECT id, question, answer, section, created_at, updated_at FROM faq_entries ORDER BY created_at DESC'
        );
        return NextResponse.json({
            success: true,
            total: rows.length,
            entries: rows.map(r => ({
                ...r,
                created_at: r.created_at?.toISOString?.() ?? String(r.created_at),
                updated_at: r.updated_at?.toISOString?.() ?? String(r.updated_at),
            })),
        });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── POST — create a new FAQ entry ── */
export async function POST(request) {
    try {
        await ensureTable();
        const { question, answer, section } = await request.json();
        if (!question?.trim() || !answer?.trim()) {
            return NextResponse.json({ success: false, error: 'question and answer are required.' }, { status: 400 });
        }

        const [result] = await pool.query(
            'INSERT INTO faq_entries (question, answer, section) VALUES (?, ?, ?)',
            [question.trim(), answer.trim(), section?.trim() || null]
        );
        const id = result.insertId;

        // Hot-update AI Engine cache (non-blocking)
        notifyEngine('', { method: 'POST', body: { question: question.trim(), answer: answer.trim(), section: section?.trim() || null } });

        return NextResponse.json({ success: true, message: 'FAQ entry saved.', id, question, answer, section });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
