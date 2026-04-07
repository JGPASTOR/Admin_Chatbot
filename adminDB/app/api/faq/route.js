import pool from '../../../lib/db';
import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

async function ensureTable() {
    const conn = await pool.getConnection();
    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`faq_entries\` (
                \`id\`         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
                \`question\`   TEXT         NOT NULL,
                \`answer\`     TEXT         NOT NULL,
                \`section\`    VARCHAR(100) DEFAULT NULL,
                \`doc_id\`     INT          DEFAULT NULL,
                \`doc_name\`   VARCHAR(255) DEFAULT NULL,
                \`created_at\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // Migrate existing installs
        try { await conn.query(`ALTER TABLE faq_entries ADD COLUMN \`doc_id\` INT DEFAULT NULL`); } catch { /* exists */ }
        try { await conn.query(`ALTER TABLE faq_entries ADD COLUMN \`doc_name\` VARCHAR(255) DEFAULT NULL`); } catch { /* exists */ }
    } finally {
        conn.release();
    }
}

async function notifyEngine(path, method, body) {
    try {
        await fetch(`${AI_ENGINE}/api/faq${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000),
        });
    } catch { /* AI Engine offline — syncs on restart */ }
}

/* ── GET ── */
export async function GET() {
    try {
        await ensureTable();
        const [rows] = await pool.query(
            'SELECT id, question, answer, section, doc_id, doc_name, created_at, updated_at FROM faq_entries ORDER BY created_at DESC'
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
        console.error('[FAQ GET]', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── DELETE (bulk) ── */
export async function DELETE(request) {
    try {
        const { ids } = await request.json();
        if (!Array.isArray(ids) || ids.length === 0) {
            return NextResponse.json({ success: false, error: 'ids array is required.' }, { status: 400 });
        }
        const placeholders = ids.map(() => '?').join(',');
        await pool.query(`DELETE FROM faq_entries WHERE id IN (${placeholders})`, ids);
        // Notify AI Engine for each deleted id (fire-and-forget)
        ids.forEach(id => notifyEngine(`/${id}`, 'DELETE'));
        return NextResponse.json({ success: true, deleted: ids.length });
    } catch (err) {
        console.error('[FAQ DELETE bulk]', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── POST ── */
export async function POST(request) {
    try {
        await ensureTable();

        const body = await request.json();
        const question = body?.question?.trim();
        const answer   = body?.answer?.trim();
        const section  = body?.section?.trim() || null;
        const doc_id   = body?.doc_id ?? null;
        const doc_name = body?.doc_name?.trim() || null;

        if (!question || !answer) {
            return NextResponse.json({ success: false, error: 'question and answer are required.' }, { status: 400 });
        }

        const conn = await pool.getConnection();
        let id;
        try {
            const [result] = await conn.query(
                'INSERT INTO `faq_entries` (`question`, `answer`, `section`, `doc_id`, `doc_name`) VALUES (?, ?, ?, ?, ?)',
                [question, answer, section, doc_id, doc_name]
            );
            id = result.insertId;
        } finally {
            conn.release();
        }

        notifyEngine('', 'POST', { question, answer, section });

        return NextResponse.json({ success: true, message: 'FAQ entry saved.', id });
    } catch (err) {
        console.error('[FAQ POST]', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
