import pool from '../../../lib/db';
import { NextResponse } from 'next/server';

// GET /api/offices — list all
export async function GET() {
    try {
        const [rows] = await pool.query('SELECT * FROM offices ORDER BY id ASC');
        return NextResponse.json(rows);
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// POST /api/offices — create
export async function POST(req) {
    try {
        const { code, name, head } = await req.json();
        const [result] = await pool.query(
            'INSERT INTO offices (code, name, head) VALUES (?, ?, ?)',
            [code, name, head]
        );
        const [rows] = await pool.query('SELECT * FROM offices WHERE id = ?', [result.insertId]);
        return NextResponse.json(rows[0], { status: 201 });
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
