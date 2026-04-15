import { NextResponse } from 'next/server';

const AI_URL = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

/* GET — list flagged queries (proxies to AI Engine) */
export async function GET(request) {
    try {
        const { searchParams } = new URL(request.url);
        const status = searchParams.get('status') || 'pending';

        const res = await fetch(`${AI_URL}/api/flagged-queries?status=${status}`, {
            signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
