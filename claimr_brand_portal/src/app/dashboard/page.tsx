'use client';

import React, { Suspense } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import {
    LayoutDashboard,
    Map as MapIcon,
    CreditCard,
    Settings,
    LogOut,
    Plus,
    TrendingUp,
    Eye,
    Clock,
    Store
} from 'lucide-react';

import dynamic from 'next/dynamic';
import MapComponent from '@/components/Map';
import { api, Territory } from '@/lib/api';

// Dynamically import DesignEditor to avoid SSR issues
const DesignEditor = dynamic(() => import('@/components/DesignEditor'), {
    ssr: false,
    loading: () => <div className="flex items-center justify-center h-full text-slate-400">Loading Studio...</div>
});

function DashboardContent() {
    const [brandProfile, setBrandProfile] = React.useState<any>(null);
    const [stats, setStats] = React.useState({ activeAds: 0, totalViews: 0, totalSpend: 0 });
    const [campaigns, setCampaigns] = React.useState<any[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);

    // SPA State
    const [currentView, setCurrentView] = React.useState<'overview' | 'map' | 'design' | 'marketplace'>('overview');
    const [selectedTerritory, setSelectedTerritory] = React.useState<Territory | null>(null);
    const [focusTerritory, setFocusTerritory] = React.useState<Territory | null>(null);
    const [openModalOnFocus, setOpenModalOnFocus] = React.useState(false);

    const searchParams = useSearchParams();
    const router = useRouter();

    React.useEffect(() => {
        const savedProfile = localStorage.getItem('brandProfile');
        if (savedProfile) {
            const profile = JSON.parse(savedProfile);
            setBrandProfile(profile);
            fetchStats(profile.name);
        } else {
            setIsLoading(false);
        }
    }, []);

    // Handle return from Design Studio
    React.useEffect(() => {
        const designSaved = searchParams.get('designSaved');
        const territoryId = searchParams.get('territoryId');

        if (designSaved === 'true' && territoryId) {
            const loadTerritory = async () => {
                try {
                    const territories = await api.getTerritories();
                    const found = territories.find(t => t.id === Number(territoryId));
                    if (found) {
                        setFocusTerritory(found);
                        setCurrentView('map');
                        setOpenModalOnFocus(true);
                        // Clean URL
                        router.replace('/dashboard');
                    }
                } catch (err) {
                    console.error('Failed to load territory from params', err);
                }
            };
            loadTerritory();
        }
    }, [searchParams, router]);

    const fetchStats = async (brandName: string) => {
        try {
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:10000';
            const res = await fetch(`${apiUrl}/api/brands/dashboard-stats?brandName=${encodeURIComponent(brandName)}`);
            if (res.ok) {
                const data = await res.json();
                console.log('Dashboard stats response:', data);
                setStats(data.stats);
                setCampaigns(data.campaigns);
            }
        } catch (error) {
            console.error('Failed to fetch stats:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleDesignSave = (data: { fullImage: string, overlayImage: string, backgroundColor: string }) => {
        if (selectedTerritory) {
            // Save design data to localStorage (one design per territory to avoid quota issues)
            localStorage.setItem(`design_${selectedTerritory.id}`, data.fullImage);
            localStorage.setItem(`design_${selectedTerritory.id}_overlay`, data.overlayImage);
            localStorage.setItem(`design_${selectedTerritory.id}_bg`, data.backgroundColor);

            // Return to map view
            setCurrentView('map');
            setOpenModalOnFocus(true);
            setFocusTerritory(selectedTerritory);
        }
    };

    const handleDeleteCampaign = async (id: string) => {
        // Confirmation is handled in the UI component
        try {
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:10000';
            const res = await fetch(`${apiUrl}/api/brands/ads/${id}`, { method: 'DELETE' });
            if (res.ok) {
                // Refresh stats
                if (brandProfile) fetchStats(brandProfile.name);
            } else {
                alert('Failed to delete campaign');
            }
        } catch (error) {
            console.error('Error deleting campaign:', error);
        }
    };

    const handleViewCampaign = (campaign: any) => {
        // Construct territory object from campaign data to focus on map
        if (campaign.geojson) {
            const territory: Territory = {
                id: campaign.territoryId,
                name: campaign.name,
                center: { lat: 0, lng: 0 }, // MapComponent will calculate or fly to geometry center
                geometry: JSON.parse(campaign.geojson),
                areaSqFt: 0, // Not needed for focus
                laps: 0,
                ownerName: '',
                identityColor: '#000000',
                rentPrice: 0
            };
            // Calculate center roughly for focus if needed, but MapComponent handles geometry focus
            // Actually MapComponent expects center.lat/lng for flyTo
            // Let's try to parse it from geojson if possible or let MapComponent handle it
            // For now, let's just pass what we have. MapComponent might need updating if it strictly relies on center.

            // Better approach: Fetch the full territory details or calculate center here
            // Since we have geojson, we can calculate centroid
            const geojson = JSON.parse(campaign.geojson);
            if (geojson.type === 'Polygon') {
                const coords = geojson.coordinates[0];
                let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
                coords.forEach((c: number[]) => {
                    if (c[1] < minLat) minLat = c[1];
                    if (c[1] > maxLat) maxLat = c[1];
                    if (c[0] < minLng) minLng = c[0];
                    if (c[0] > maxLng) maxLng = c[0];
                });
                territory.center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
            }

            setFocusTerritory(territory);
            setCurrentView('map');
        } else {
            setCurrentView('map');
        }
    };

    const handleEditCampaign = (campaign: any) => {
        if (campaign.geojson) {
            const territory: Territory = {
                id: campaign.territoryId,
                name: campaign.name,
                center: { lat: 0, lng: 0 }, // Placeholder, DesignEditor calculates center from geometry if needed
                geometry: JSON.parse(campaign.geojson),
                // Use area_sqm if available, otherwise estimate from views (views ≈ area * 0.5)
                areaSqFt: campaign.area_sqm ? parseFloat(campaign.area_sqm) : (typeof campaign.views === 'number' ? campaign.views * 2 : 0),
                laps: 0,
                ownerName: brandProfile?.name || '',
                identityColor: '#000000',
                rentPrice: 0
            };
            setSelectedTerritory(territory);
            setCurrentView('design');
        } else {
            alert("Territory data incomplete. Please view on map.");
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 text-white flex">
            {/* Sidebar */}
            <aside className="w-64 border-r border-white/10 bg-slate-900/50 backdrop-blur-xl hidden md:flex flex-col">
                <div className="p-6 flex items-center gap-3">
                    {brandProfile?.logo && (
                        <div className="w-10 h-10 rounded-full overflow-hidden border border-white/20 bg-white p-1">
                            <img src={brandProfile.logo} alt="Brand Logo" className="w-full h-full object-contain" />
                        </div>
                    )}
                    <div>
                        <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-purple-500">
                            RunerrX
                        </h1>
                        {brandProfile && <p className="text-xs text-slate-400">{brandProfile.name}</p>}
                    </div>
                </div>

                <nav className="flex-1 px-4 space-y-2">
                    <NavItem
                        icon={<LayoutDashboard size={20} />}
                        label="Overview"
                        active={currentView === 'overview'}
                        onClick={() => setCurrentView('overview')}
                    />
                    <NavItem
                        icon={<MapIcon size={20} />}
                        label="Map View"
                        active={currentView === 'map'}
                        onClick={() => setCurrentView('map')}
                    />
                    <NavItem
                        icon={<Store size={20} />}
                        label="Marketplace"
                        active={currentView === 'marketplace'}
                        onClick={() => setCurrentView('marketplace')}
                    />
                    <NavItem icon={<CreditCard size={20} />} label="Billing" />
                    <NavItem icon={<Settings size={20} />} label="Settings" />
                </nav>

                <div className="p-4 border-t border-white/10">
                    <button
                        onClick={() => {
                            if (confirm('Are you sure you want to log out?')) {
                                localStorage.removeItem('brandProfile');
                                router.push('/login');
                            }
                        }}
                        className="flex items-center gap-3 px-4 py-3 text-slate-400 hover:text-white transition-colors w-full rounded-lg hover:bg-white/5"
                    >
                        <LogOut size={20} />
                        <span>Log Out</span>
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 h-screen overflow-hidden flex flex-col">
                {currentView === 'overview' && (
                    <div className="p-8 overflow-y-auto h-full">
                        <header className="flex justify-between items-center mb-8">
                            <div>
                                <h2 className="text-3xl font-bold">Welcome back, {brandProfile?.name || 'Brand'}</h2>
                                <p className="text-slate-400">Here's what's happening with your campaigns.</p>
                            </div>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => setCurrentView('map')}
                                className="bg-cyan-500 hover:bg-cyan-400 text-black font-bold py-2 px-4 rounded-full flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition-colors"
                            >
                                <Plus size={18} /> New Campaign
                            </motion.button>
                        </header>

                        {/* Stats Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                            <StatCard
                                title="Active Ads"
                                value={stats.activeAds.toString()}
                                change="+0"
                                icon={<MapIcon className="text-cyan-400" />}
                                delay={0}
                            />
                            <StatCard
                                title="Total Views"
                                value={stats.totalViews.toLocaleString()}
                                change="+0%"
                                icon={<Eye className="text-purple-400" />}
                                delay={0.1}
                            />
                            <StatCard
                                title="Total Spend"
                                value={`₹${stats.totalSpend.toLocaleString()}`}
                                change="+0%"
                                icon={<TrendingUp className="text-green-400" />}
                                delay={0.2}
                            />
                        </div>

                        {/* Active Campaigns */}
                        <section>
                            <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                                <Clock size={20} className="text-cyan-400" /> Active Campaigns
                            </h3>

                            <div className="glass-panel rounded-xl overflow-hidden">
                                {isLoading ? (
                                    <div className="p-8 text-center text-slate-400">Loading campaigns...</div>
                                ) : campaigns.length > 0 ? (
                                    <table className="w-full text-left">
                                        <thead className="bg-white/5 text-slate-400 text-xs uppercase tracking-wider">
                                            <tr>
                                                <th className="p-4">Territory</th>
                                                <th className="p-4">Status</th>
                                                <th className="p-4">Views</th>
                                                <th className="p-4">Expires In</th>
                                                <th className="p-4 text-right">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-white/5">
                                            {campaigns.map((campaign) => (
                                                <CampaignRow
                                                    key={campaign.id}
                                                    campaign={campaign}
                                                    onDelete={handleDeleteCampaign}
                                                    onView={handleViewCampaign}
                                                    onEdit={handleEditCampaign}
                                                />
                                            ))}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div className="p-8 text-center text-slate-400">
                                        <p className="mb-4">No active campaigns found.</p>
                                        <button
                                            onClick={() => setCurrentView('map')}
                                            className="text-cyan-400 hover:text-cyan-300 font-bold"
                                        >
                                            Start your first campaign →
                                        </button>
                                    </div>
                                )}
                            </div>
                        </section>
                    </div>
                )}

                {currentView === 'map' && (
                    <div className="h-full w-full relative">
                        <MapComponent
                            onDesignClick={(territory) => {
                                setSelectedTerritory(territory);
                                setCurrentView('design');
                            }}
                            focusTerritory={focusTerritory}
                            openModalOnFocus={openModalOnFocus}
                        />
                        {/* Back to Dashboard Button */}
                        <button
                            onClick={() => setCurrentView('overview')}
                            className="absolute top-4 left-4 z-50 bg-slate-900/80 backdrop-blur text-white p-2 rounded-lg border border-white/10 hover:bg-white/10 transition-colors flex items-center gap-2"
                        >
                            <LayoutDashboard size={18} /> Back to Dashboard
                        </button>
                    </div>
                )}

                {currentView === 'design' && selectedTerritory && (
                    <div className="h-full w-full bg-slate-900">
                        <DesignEditor
                            territory={selectedTerritory}
                            onSave={handleDesignSave}
                            onCancel={() => setCurrentView('map')}
                        />
                    </div>
                )}

                {currentView === 'marketplace' && (
                    <MarketplaceView onViewOnMap={(territory) => {
                        setFocusTerritory(territory);
                        setCurrentView('map');
                    }} />
                )}
            </main>
        </div>
    );
}

function MarketplaceView({ onViewOnMap }: { onViewOnMap: (t: any) => void }) {
    const [territories, setTerritories] = React.useState<any[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [search, setSearch] = React.useState('');

    React.useEffect(() => {
        const fetchTerritories = async () => {
            try {
                const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:10000';
                const res = await fetch(`${apiUrl}/api/brands/available-territories`);
                if (res.ok) {
                    const data = await res.json();
                    setTerritories(data);
                }
            } catch (err) {
                console.error('Failed to fetch marketplace:', err);
            } finally {
                setLoading(false);
            }
        };
        fetchTerritories();
    }, []);

    const filtered = territories.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        (t.areaSqFt && t.areaSqFt.toString().includes(search))
    );

    return (
        <div className="p-8 h-full overflow-y-auto">
            <header className="mb-8">
                <h2 className="text-3xl font-bold mb-2">Marketplace</h2>
                <p className="text-slate-400">Discover available territories to rent.</p>
            </header>

            <div className="mb-6">
                <input
                    type="text"
                    placeholder="Search by name or area..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full max-w-md bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-cyan-500 transition-colors"
                />
            </div>

            {loading ? (
                <div className="text-center text-slate-400 py-12">Loading territories...</div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filtered.map((t) => (
                        <div key={t.id} className="glass-panel p-6 rounded-xl hover:bg-white/5 transition-colors group">
                            <div className="flex justify-between items-start mb-4">
                                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-xl font-bold">
                                    {t.name.charAt(0).toUpperCase()}
                                </div>
                                <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-full border border-green-500/20">
                                    Available
                                </span>
                            </div>
                            <h3 className="text-xl font-bold mb-1">{t.name}</h3>
                            <p className="text-slate-400 text-sm mb-2">
                                {parseFloat(t.areaSqFt).toLocaleString()} sq ft
                            </p>
                            {t.city && t.country && (
                                <p className="text-slate-500 text-xs mb-4 flex items-center gap-1">
                                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                                    </svg>
                                    {t.city}, {t.country}
                                </p>
                            )}

                            <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/10">
                                <div>
                                    <p className="text-xs text-slate-500">Est. Price</p>
                                    <p className="font-bold text-cyan-400">₹{t.price.toLocaleString()}</p>
                                </div>
                                <button
                                    onClick={() => onViewOnMap(t)}
                                    className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-medium transition-colors"
                                >
                                    View on Map
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function NavItem({ icon, label, active = false, href, onClick }: { icon: React.ReactNode, label: string, active?: boolean, href?: string, onClick?: () => void }) {
    if (href) {
        return (
            <Link href={href}>
                <div className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-all ${active ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
                    {icon}
                    <span className="font-medium">{label}</span>
                </div>
            </Link>
        );
    }

    return (
        <div
            onClick={onClick}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-all ${active ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}
        >
            {icon}
            <span className="font-medium">{label}</span>
        </div>
    );
}

function StatCard({ title, value, change, icon, delay }: { title: string, value: string, change: string, icon: React.ReactNode, delay: number }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay, duration: 0.5 }}
            className="glass-panel p-6 rounded-xl"
        >
            <div className="flex justify-between items-start mb-4">
                <div>
                    <p className="text-slate-400 text-sm">{title}</p>
                    <h3 className="text-3xl font-bold mt-1">{value}</h3>
                </div>
                <div className="p-2 bg-white/5 rounded-lg">
                    {icon}
                </div>
            </div>
            <div className="flex items-center text-sm">
                <span className="text-green-400 font-medium">{change}</span>
                <span className="text-slate-500 ml-2">from last week</span>
            </div>
        </motion.div>
    );
}

function CampaignRow({ campaign, onDelete, onView, onEdit }: { campaign: any, onDelete: (id: string) => void, onView: (c: any) => void, onEdit: (c: any) => void }) {
    const getStatusColor = (status: string) => {
        switch (status) {
            case 'Active': return 'bg-green-500/20 text-green-400 border border-green-500/20';
            case 'Pending Approval': return 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/20';
            case 'Rejected': return 'bg-red-500/20 text-red-400 border border-red-500/20';
            case 'Expired': return 'bg-slate-500/20 text-slate-400 border border-slate-500/20';
            default: return 'bg-slate-500/20 text-slate-400 border border-slate-500/20';
        }
    };

    return (
        <tr className="hover:bg-white/5 transition-colors">
            <td className="p-4 font-medium">{campaign.name}</td>
            <td className="p-4">
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(campaign.status)}`}>
                    {campaign.status}
                </span>
            </td>
            <td className="p-4 text-slate-300">{campaign.views.toLocaleString()}</td>
            <td className="p-4 text-slate-300">{campaign.expires}</td>
            <td className="p-4 text-right space-x-2">
                <button onClick={() => onView(campaign)} className="text-slate-300 hover:text-white text-sm font-medium">View</button>
                <button onClick={() => onEdit(campaign)} className="text-cyan-400 hover:text-cyan-300 text-sm font-medium">Edit</button>
                <button
                    onClick={() => {
                        if (confirm('Are you sure you want to delete this campaign? This action cannot be undone.')) {
                            onDelete(campaign.id);
                        }
                    }}
                    className="text-red-400 hover:text-red-300 text-sm font-medium"
                >
                    Delete
                </button>
            </td>
        </tr>
    );
}

export default function DashboardPage() {
    return (
        <Suspense fallback={<div className="flex items-center justify-center min-h-screen bg-black text-white">Loading Dashboard...</div>}>
            <DashboardContent />
        </Suspense>
    );
}
