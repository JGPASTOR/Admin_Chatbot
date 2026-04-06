import { NextResponse } from 'next/server';

export async function POST() {
    try {
        const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
        
        console.log('[RAG Rebuild] Forwarding rebuild request to AI Engine...');
        const res = await fetch(`${aiEngineUrl}/api/rag/rebuild`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        const data = await res.json();
        
        if (!res.ok) {
            return NextResponse.json({ success: false, error: data.detail || 'Failed to rebuild RAG index' }, { status: res.status });
        }

        return NextResponse.json(data);
    } catch (err) {
        console.error('[RAG Rebuild] Error:', err.message);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
