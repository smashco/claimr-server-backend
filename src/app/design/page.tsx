'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, Territory } from '@/lib/api';
import dynamic from 'next/dynamic';

// Dynamically import DesignEditor to avoid SSR issues with Fabric.js (canvas)
const DesignEditor = dynamic(() => import('@/components/DesignEditor'), {
    ssr: false,
    loading: () => <div className="flex items-center justify-center h-screen bg-gray-900 text-white">Loading Studio...</div>
});

function DesignPageContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const territoryId = searchParams.get('territoryId');

    const [territory, setTerritory] = useState<Territory | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!territoryId) {
            router.push('/');
            return;
        }

        const loadTerritory = async () => {
            try {
                const territories = await api.getTerritories();
                const found = territories.find(t => t.id === Number(territoryId));
                if (found) {
                    setTerritory(found);
                } else {
                    console.error('Territory not found');
                    router.push('/');
                }
            } catch (err) {
                console.error('Failed to load territory', err);
            } finally {
                setLoading(false);
            }
        };

        loadTerritory();
    }, [territoryId, router]);

    const handleSave = (data: { fullImage: string, overlayImage: string, backgroundColor: string }) => {
        // Note: Removed localStorage caching to prevent QuotaExceededError
        // Designs are uploaded to S3 via the API instead

        if (territoryId) {
            // Navigate back to dashboard with success param
            router.push('/dashboard?designSaved=true&territoryId=' + territoryId);
        }
    };

    if (loading) return <div className="flex items-center justify-center h-screen bg-gray-900 text-white">Loading...</div>;
    if (!territory) return null;

    return (
        <DesignEditor
            territory={territory}
            onSave={handleSave}
            onCancel={() => router.push('/')}
        />
    );
}

export default function DesignPage() {
    return (
        <Suspense fallback={<div className="flex items-center justify-center h-screen bg-gray-900 text-white">Loading...</div>}>
            <DesignPageContent />
        </Suspense>
    );
}
