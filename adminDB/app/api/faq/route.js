import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

/* ── GET — list all FAQ entries ── */
export async function GET() {
    try {
        const res = await fetch(`${AI_ENGINE}/api/faq`, {
            signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── POST — create a new FAQ entry ── */
export async function POST(request) {
    try {
        const body = await request.json();
        const res = await fetch(`${AI_ENGINE}/api/faq`, {
            method: 'POST',
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
