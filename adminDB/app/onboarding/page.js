'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const STEPS = ['welcome', 'office', 'done'];

export default function OnboardingPage() {
    const router = useRouter();
    const [step, setStep] = useState(0);
    const [form, setForm] = useState({ code: '', name: '', head: '' });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const finish = () => {
        localStorage.setItem('onboarding_done', '1');
        router.replace('/dashboard');
    };

    const handleAddOffice = async () => {
        if (!form.code.trim() || !form.name.trim()) {
            setError('Office code and name are required.');
            return;
        }
        setSaving(true);
        setError('');
        try {
            const res = await fetch('/api/offices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            if (!res.ok) throw new Error('Failed to save office.');
            setStep(2);
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div style={{
            width: '100%', maxWidth: 480,
            background: '#fff', borderRadius: 16,
            boxShadow: '0 8px 40px rgba(0,0,0,0.10)',
            padding: '48px 40px',
            margin: '40px auto',
        }}>
            {/* Progress dots */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 36 }}>
                {STEPS.map((_, i) => (
                    <div key={i} style={{
                        width: i === step ? 24 : 8, height: 8,
                        borderRadius: 4,
                        background: i <= step ? 'var(--primary)' : '#e5e7eb',
                        transition: 'all 0.3s ease',
                    }} />
                ))}
            </div>

            {/* Step: Welcome */}
            {step === 0 && (
                <div style={{ textAlign: 'center' }}>
                    <div style={{
                        width: 64, height: 64, borderRadius: 16,
                        background: 'var(--primary)', margin: '0 auto 20px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <svg width="32" height="32" fill="none" stroke="white" strokeWidth="2" viewBox="0 0 24 24">
                            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                    </div>
                    <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', marginBottom: 10 }}>
                        Welcome to DocTrack
                    </h1>
                    <p style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 32 }}>
                        Let's get your admin portal set up in just a couple of steps.
                        This will only take a minute.
                    </p>
                    <button className="btn btn-primary" style={{ width: '100%', padding: '12px 0', fontSize: 15 }}
                        onClick={() => setStep(1)}>
                        Get Started →
                    </button>
                </div>
            )}

            {/* Step: Add first office */}
            {step === 1 && (
                <div>
                    <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>
                        Add your first office
                    </h2>
                    <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 24, lineHeight: 1.5 }}>
                        Offices are used to track document routing and accountability.
                        You can add more later.
                    </p>

                    <div className="form-group">
                        <label>Office Code <span style={{ color: '#ef4444' }}>*</span></label>
                        <input className="form-control" placeholder="e.g. CMO"
                            value={form.code}
                            onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} />
                    </div>
                    <div className="form-group">
                        <label>Office Name <span style={{ color: '#ef4444' }}>*</span></label>
                        <input className="form-control" placeholder="e.g. City Mayor's Office"
                            value={form.name}
                            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                    </div>
                    <div className="form-group">
                        <label>Office Head <span style={{ color: 'var(--text-3)' }}>(optional)</span></label>
                        <input className="form-control" placeholder="e.g. Mayor Jose Santos"
                            value={form.head}
                            onChange={e => setForm(f => ({ ...f, head: e.target.value }))} />
                    </div>

                    {error && (
                        <div style={{ fontSize: 13, color: '#ef4444', marginBottom: 12 }}>{error}</div>
                    )}

                    <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                        <button className="btn btn-ghost" style={{ flex: 1 }}
                            onClick={() => { setStep(2); }}
                            disabled={saving}>
                            Skip for now
                        </button>
                        <button className="btn btn-primary" style={{ flex: 2 }}
                            onClick={handleAddOffice}
                            disabled={saving}>
                            {saving ? 'Saving…' : 'Add Office & Continue'}
                        </button>
                    </div>
                </div>
            )}

            {/* Step: Done */}
            {step === 2 && (
                <div style={{ textAlign: 'center' }}>
                    <div style={{
                        width: 64, height: 64, borderRadius: '50%',
                        background: '#dcfce7', margin: '0 auto 20px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <svg width="32" height="32" fill="none" stroke="#16a34a" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                    </div>
                    <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 10 }}>
                        You're all set!
                    </h2>
                    <p style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 32 }}>
                        Your DocTrack portal is ready to use. Head to the dashboard
                        to start tracking documents.
                    </p>
                    <button className="btn btn-primary" style={{ width: '100%', padding: '12px 0', fontSize: 15 }}
                        onClick={finish}>
                        Go to Dashboard →
                    </button>
                </div>
            )}
        </div>
    );
}
