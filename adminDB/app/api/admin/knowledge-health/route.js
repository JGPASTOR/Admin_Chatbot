import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

export async function GET(request) {
    try {
        const { searchParams } = new URL(request.url);
        const days = searchParams.get('days') || '7';

        const res = await fetch(`${AI_ENGINE}/api/admin/knowledge-health?days=${days}`, {
            signal: AbortSignal.timeout(15000),
        });

        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err.message },
            { status: 503 }
        );
    }
}
