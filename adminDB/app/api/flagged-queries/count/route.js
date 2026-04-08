import { NextResponse } from 'next/server';

const AI_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

export async function GET() {
    try {
        const res = await fetch(`${AI_URL}/api/flagged-queries/count`, {
            signal: AbortSignal.timeout(4000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch {
        // Non-fatal — return 0 if AI Engine is offline
        return NextResponse.json({ success: true, pending: 0 });
    }
}
