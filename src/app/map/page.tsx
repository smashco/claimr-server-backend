'use client';

import Map from '@/components/Map';

export default function MapPage() {
    return (
        <main className="h-screen w-screen bg-black relative">
            <div className="absolute top-4 left-4 z-10 bg-black/50 backdrop-blur-md p-4 rounded-xl border border-white/10">
                <h1 className="text-2xl font-bold text-white">Territory Map</h1>
                <p className="text-gray-400 text-sm">Select a zone to rent.</p>
            </div>
            <Map />
        </main>
    );
}
