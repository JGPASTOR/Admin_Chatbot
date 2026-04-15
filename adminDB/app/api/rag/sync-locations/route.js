import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

export async function POST() {
    try {
        const res = await fetch(`${AI_ENGINE}/api/rag/sync-locations`, {
            method: 'POST',
            signal: AbortSignal.timeout(30000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json(
            { success: false, message: err.message },
            { status: 503 }
        );
    }
}
