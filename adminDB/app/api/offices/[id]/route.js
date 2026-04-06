import pool from '../../../../lib/db';
import { NextResponse } from 'next/server';

// PUT /api/offices/[id]
export async function PUT(req, { params }) {
    try {
        const { id } = await params;
        const { code, name, head } = await req.json();
        const [result] = await pool.query(
            'UPDATE offices SET code=?, name=?, head=? WHERE id=?',
            [code, name, head, id]
        );
        if (result.affectedRows === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        const [rows] = await pool.query('SELECT * FROM offices WHERE id = ?', [id]);
        return NextResponse.json(rows[0]);
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// DELETE /api/offices/[id]
export async function DELETE(req, { params }) {
    try {
        const { id } = await params;
        const [result] = await pool.query('DELETE FROM offices WHERE id=?', [id]);
        if (result.affectedRows === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
