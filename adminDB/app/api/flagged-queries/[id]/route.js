import { NextResponse } from 'next/server';

const AI_URL = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

export async function PATCH(request, { params }) {
    try {
        const { id } = await params;
        const body = await request.json();

        const res = await fetch(`${AI_URL}/api/flagged-queries/${id}/resolve`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

export async function DELETE(request, { params }) {
    try {
        const { id } = await params;

        const res = await fetch(`${AI_URL}/api/flagged-queries/${id}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
