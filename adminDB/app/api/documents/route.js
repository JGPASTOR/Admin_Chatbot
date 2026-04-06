import pool from '../../../lib/db';
import { NextResponse } from 'next/server';

// GET /api/documents — list all
export async function GET() {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM documents ORDER BY created_timestamp DESC'
        );
        // Parse the JSON `details` column (MySQL returns it as a string)
        const docs = rows.map(r => ({
            ...r,
            details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
            document_completed_status: Boolean(r.document_completed_status),
            is_public: Boolean(r.is_public),
        }));
        return NextResponse.json(docs);
    } catch (err) {
        console.error('GET /api/documents error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// POST /api/documents — create new
export async function POST(req) {
    try {
        const body = await req.json();
        const {
            slug, title, agency, office, subject, file_type = 'n/a',
            is_public = 1, created_at, created_by, validated_at, validated_by,
            document_type = null, user_retention = null, office_retention = null,
            overall_days_onprocess = null, document_completed_status = 0,
            details = null,
        } = body;

        const [result] = await pool.query(
            `INSERT INTO documents
        (slug, title, agency, office, subject, file_type, is_public, created_at,
         created_by, validated_at, validated_by, document_type, user_retention,
         office_retention, overall_days_onprocess, document_completed_status, details)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [slug, title, agency, office, subject, file_type, is_public ? 1 : 0,
                created_at, created_by, validated_at, validated_by, document_type,
                user_retention, office_retention, overall_days_onprocess,
                document_completed_status ? 1 : 0,
                details ? JSON.stringify(details) : null]
        );

        const [rows] = await pool.query('SELECT * FROM documents WHERE id = ?', [result.insertId]);
        const doc = rows[0];
        return NextResponse.json({
            ...doc,
            details: typeof doc.details === 'string' ? JSON.parse(doc.details) : doc.details,
            document_completed_status: Boolean(doc.document_completed_status),
        }, { status: 201 });
    } catch (err) {
        console.error('POST /api/documents error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
