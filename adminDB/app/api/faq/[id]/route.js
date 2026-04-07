import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

/* ── PUT — update a FAQ entry ── */
export async function PUT(request, { params }) {
    try {
        const { id } = await params;
        const body = await request.json();
        const res = await fetch(`${AI_ENGINE}/api/faq/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── DELETE — remove a FAQ entry ── */
export async function DELETE(request, { params }) {
    try {
        const { id } = await params;
        const res = await fetch(`${AI_ENGINE}/api/faq/${id}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
