import pool from '../../../../lib/db';
import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

/** Trigger a lightweight locations sync on the AI-Engine after any add/edit/delete */
async function syncLocationsToRAG() {
    try {
        const res = await fetch(`${AI_ENGINE}/api/rag/sync-locations`, {
            method: 'POST',
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.warn(`[Locations RAG] Sync returned ${res.status}: ${body}`);
        } else {
            const data = await res.json();
            console.log(`[Locations RAG] Sync OK — ${data.total_chunks ?? 0} new chunk(s)`);
        }
    } catch (e) {
        console.warn('[Locations RAG] Sync failed (AI-Engine unreachable?):', e.message);
    }
}

/* ── DELETE /api/locations/[id] ── */
export async function DELETE(request, { params }) {
    try {
        const { id } = await params;

        const [rows] = await pool.query('SELECT * FROM locations WHERE id = ?', [id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });
        }

        const loc = rows[0];
        const filename = `location_${loc.id}_${loc.name.replace(/\s+/g, '_')}`;

        // Remove chunk from RAG index (non-fatal)
        fetch(`${AI_ENGINE}/api/rag/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
            signal: AbortSignal.timeout(5000),
        }).catch(e => console.warn('[Locations RAG] Delete warning:', e.message));

        await pool.query('DELETE FROM locations WHERE id = ?', [id]);
        return NextResponse.json({ success: true, message: 'Location deleted.' });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── PUT /api/locations/[id] ── */
export async function PUT(request, { params }) {
    try {
        const { id } = await params;
        const body = await request.json();
        const {
            name, category, description, address,
            latitude, longitude, contact, operating_hours, google_maps_url,
        } = body;

        if (!name?.trim()) {
            return NextResponse.json({ success: false, error: 'Name is required.' }, { status: 400 });
        }

        await pool.query(
            `UPDATE locations SET
               name=?, category=?, description=?, address=?,
               latitude=?, longitude=?, contact=?, operating_hours=?, google_maps_url=?
             WHERE id=?`,
            [
                name.trim(), category, description || null, address || null,
                latitude || null, longitude || null,
                contact || null, operating_hours || null, google_maps_url || null,
                id,
            ]
        );

        const [rows] = await pool.query('SELECT * FROM locations WHERE id = ?', [id]);
        if (rows.length === 0)
            return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });

        const loc = rows[0];

        // Re-sync all locations so the updated entry reflects in RAG (fire-and-forget)
        syncLocationsToRAG().catch(() => {});

        return NextResponse.json({ success: true, data: loc });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
