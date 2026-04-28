import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

export async function POST() {
    try {
        console.log(`[sync-locations] Forwarding to ${AI_ENGINE}/api/rag/sync-locations`);
        const res = await fetch(`${AI_ENGINE}/api/rag/sync-locations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(60000),
        });

        const text = await res.text();
        console.log(`[sync-locations] AI Engine responded ${res.status}: ${text.substring(0, 500)}`);

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            return NextResponse.json(
                { success: false, message: `AI Engine returned non-JSON (${res.status}): ${text.substring(0, 200)}` },
                { status: 502 }
            );
        }

        if (!res.ok) {
            return NextResponse.json(
                { success: false, message: data.detail || data.message || `AI Engine error (${res.status})` },
                { status: res.status }
            );
        }

        return NextResponse.json(data, { status: 200 });
    } catch (err) {
        console.error('[sync-locations] Proxy error:', err);
        return NextResponse.json(
            { success: false, message: `Proxy error: ${err.message}` },
            { status: 503 }
        );
    }
}

