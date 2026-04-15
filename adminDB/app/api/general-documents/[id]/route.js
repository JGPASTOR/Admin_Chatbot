import pool from '../../../../lib/db';
import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

/* ── GET — single document with extracted data ── */
export async function GET(request, { params }) {
    try {
        const { id } = await params;
        const [rows] = await pool.query('SELECT * FROM general_documents WHERE id = ?', [id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
        }

        const doc = rows[0];
        // Parse extracted_data if it's a string
        if (typeof doc.extracted_data === 'string') {
            try { doc.extracted_data = JSON.parse(doc.extracted_data); } catch { }
        }

        return NextResponse.json({ success: true, data: doc });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── DELETE — remove document + file ── */
export async function DELETE(request, { params }) {
    try {
        const { id } = await params;
        const [rows] = await pool.query('SELECT file_path, original_name FROM general_documents WHERE id = ?', [id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
        }

        const { file_path, original_name } = rows[0];

        const filePath = path.join(process.cwd(), 'public', file_path);
        try { await fs.unlink(filePath); } catch { }

        const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';
        try {
            const ragRes = await fetch(`${aiEngineUrl}/api/rag/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: original_name }),
                signal: AbortSignal.timeout(5000),
            });
            if (!ragRes.ok) {
                console.warn('[RAG Delete] Warning: API returned', ragRes.status);
            } else {
                const ragData = await ragRes.json();
                console.log(`[RAG Delete] OK — ${ragData.chunks_removed ?? 0} chunks removed for '${original_name}'.`);
            }
        } catch (ragErr) {
            console.warn('[RAG Delete] Warning: Could not reach AI Engine:', ragErr.message);
        }

        await pool.query('DELETE FROM general_documents WHERE id = ?', [id]);
        return NextResponse.json({ success: true, message: 'Document deleted.' });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
