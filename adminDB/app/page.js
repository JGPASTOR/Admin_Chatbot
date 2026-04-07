'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
    const router = useRouter();

    useEffect(() => {
        const done = localStorage.getItem('onboarding_done');
        if (done) {
            router.replace('/dashboard');
        } else {
            router.replace('/onboarding');
        }
    }, [router]);

    return null;
}
