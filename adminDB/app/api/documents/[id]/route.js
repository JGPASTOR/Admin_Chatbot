import pool from '../../../../lib/db';
import { NextResponse } from 'next/server';

function parseDoc(row) {
    if (!row) return null;
    return {
        ...row,
        details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
        document_completed_status: Boolean(row.document_completed_status),
        is_public: Boolean(row.is_public),
    };
}

export async function GET(req, { params }) {
    try {
        const { id } = await params;
        const [rows] = await pool.query('SELECT * FROM documents WHERE id = ? OR slug = ?', [id, id]);
        if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        return NextResponse.json(parseDoc(rows[0]));
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function PUT(req, { params }) {
    try {
        const { id } = await params;
        const body = await req.json();
        const {
            slug, title, agency, office, subject, file_type,
            is_public, created_at, created_by, validated_at, validated_by,
            document_type, user_retention, office_retention,
            overall_days_onprocess, document_completed_status, details,
        } = body;

        await pool.query(
            `UPDATE documents SET
        slug=?, title=?, agency=?, office=?, subject=?, file_type=?,
        is_public=?, created_at=?, created_by=?, validated_at=?,
        validated_by=?, document_type=?, user_retention=?, office_retention=?,
        overall_days_onprocess=?, document_completed_status=?, details=?
       WHERE id=? OR slug=?`,
            [slug, title, agency, office, subject, file_type,
                is_public ? 1 : 0, created_at, created_by, validated_at, validated_by,
                document_type, user_retention, office_retention, overall_days_onprocess,
                document_completed_status ? 1 : 0,
                details ? JSON.stringify(details) : null,
                id, id]
        );

        const [rows] = await pool.query('SELECT * FROM documents WHERE id = ? OR slug = ?', [id, id]);
        if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        return NextResponse.json(parseDoc(rows[0]));
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// DELETE /api/documents/[id]
export async function DELETE(req, { params }) {
    try {
        const { id } = await params;
        const [result] = await pool.query('DELETE FROM documents WHERE id = ? OR slug = ?', [id, id]);
        if (result.affectedRows === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
