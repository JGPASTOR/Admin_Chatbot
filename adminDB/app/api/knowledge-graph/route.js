import { NextResponse } from 'next/server';

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

export async function GET() {
    try {
        const res = await fetch(`${AI_ENGINE_URL}/api/knowledge-graph`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return NextResponse.json(data);
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message, nodes: [], edges: [] }, { status: 500 });
    }
}
