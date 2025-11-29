'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import Map, { Source, Layer, Popup } from 'react-map-gl/maplibre';
import type { MapLayerMouseEvent, ViewStateChangeEvent, LayerProps } from 'react-map-gl/maplibre';
import { api, Territory } from '@/lib/api';
import SimpleRentModal from './SimpleRentModal';
import 'maplibre-gl/dist/maplibre-gl.css';
import { motion } from 'framer-motion';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || 'pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.example';

interface MapComponentProps {
    onDesignClick?: (territory: Territory) => void;
    focusTerritory?: Territory | null;
    openModalOnFocus?: boolean;
}

export default function MapComponent({ onDesignClick, focusTerritory, openModalOnFocus = false }: MapComponentProps) {
    const [territories, setTerritories] = useState<Territory[]>([]);
    const [selectedTerritory, setSelectedTerritory] = useState<Territory | null>(null);
    const [showRentModal, setShowRentModal] = useState(false);
    const [viewState, setViewState] = useState({
        latitude: 40.7128,
        longitude: -74.0060,
        zoom: 12,
        pitch: 45,
        bearing: 0
    });
    const [previewImage, setPreviewImage] = useState<{ url: string, coordinates: number[][] } | null>(null);

    // Ad Placement Controls
    const [baseCoordinates, setBaseCoordinates] = useState<number[][] | null>(null);
    const [rotation, setRotation] = useState(0);
    const [scale, setScale] = useState(1);
    const [stretchX, setStretchX] = useState(1);
    const [stretchY, setStretchY] = useState(1);

    // Handle focusTerritory changes
    useEffect(() => {
        if (focusTerritory) {
            console.log('Focusing on territory:', focusTerritory);
            setViewState(prev => ({
                ...prev,
                latitude: focusTerritory.center.lat,
                longitude: focusTerritory.center.lng,
                zoom: 16,
                pitch: 60,
                bearing: 0
            }));
            // Also select it to show popup
            setSelectedTerritory(focusTerritory);
            if (openModalOnFocus) {
                setShowRentModal(true);
            }
        }
    }, [focusTerritory]);

    const loadTerritories = async () => {
        try {
            const data = await api.getTerritories();
            setTerritories(data);
        } catch (error) {
            console.error('Failed to fetch territories:', error);
        }
    };

    const previewCoordinates = useMemo(() => {
        if (!baseCoordinates) return null;
        const centerLng = (baseCoordinates[0][0] + baseCoordinates[2][0]) / 2;
        const centerLat = (baseCoordinates[0][1] + baseCoordinates[2][1]) / 2;

        return baseCoordinates.map((coord: number[]) => {
            let lng = coord[0];
            let lat = coord[1];
            let x = (lng - centerLng);
            let y = (lat - centerLat);
            x *= stretchX;
            y *= stretchY;
            x *= scale;
            y *= scale;
            const rad = rotation * Math.PI / 180;
            const xRot = x * Math.cos(rad) - y * Math.sin(rad);
            const yRot = x * Math.sin(rad) + y * Math.cos(rad);
            return [centerLng + xRot, centerLat + yRot];
        });
    }, [baseCoordinates, rotation, scale, stretchX, stretchY]);

    const handleTerritoryClick = useCallback((territory: Territory) => {
        setSelectedTerritory(territory);
    }, []);

    useEffect(() => {
        if (navigator.geolocation && !focusTerritory) { // Only use geolocation if not focusing
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    setViewState(prev => ({
                        ...prev,
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude
                    }));
                },
                (error) => console.warn('Geolocation error:', error)
            );
        }
    }, [focusTerritory]);

    useEffect(() => {
        const loadTerritories = async () => {
            try {
                const data = await api.getTerritories();
                setTerritories(data);
                if (data.length > 0 && !focusTerritory) { // Only auto-center if not focusing
                    let minLat = Infinity, maxLat = -Infinity;
                    let minLng = Infinity, maxLng = -Infinity;
                    data.forEach(t => {
                        if (t.center.lat < minLat) minLat = t.center.lat;
                        if (t.center.lat > maxLat) maxLat = t.center.lat;
                        if (t.center.lng < minLng) minLng = t.center.lng;
                        if (t.center.lng > maxLng) maxLng = t.center.lng;
                    });
                    const centerLat = (minLat + maxLat) / 2;
                    const centerLng = (minLng + maxLng) / 2;
                    setViewState(prev => ({
                        ...prev,
                        latitude: centerLat,
                        longitude: centerLng,
                        zoom: 14
                    }));
                }
            } catch (err) {
                console.error('Failed to load territories', err);
            }
        };
        loadTerritories();
    }, [focusTerritory]);

    const geoJsonData = useMemo(() => {
        return {
            type: 'FeatureCollection' as const,
            features: territories.map(t => ({
                type: 'Feature' as const,
                geometry: t.geometry,
                properties: {
                    id: t.id,
                    name: t.name || '',
                    price: t.rentPrice || 0,
                    // Check if rented (has activeAd) -> RED, else GREEN
                    color: (t as any).activeAd ? '#FF0000' : '#00FF00',
                    isRented: !!(t as any).activeAd,
                    ownerName: t.ownerName || '',
                    ownerImage: (t as any).ownerImage || ''
                }
            }))
        };
    }, [territories]);

    const fillLayer: LayerProps = {
        id: 'territory-fill',
        type: 'fill',
        paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': 0.4,
            'fill-outline-color': '#FFFFFF'
        }
    };

    const lineLayer: LayerProps = {
        id: 'territory-outline',
        type: 'line',
        paint: {
            'line-color': ['get', 'color'],
            'line-width': 4,
            'line-blur': 2
        }
    };

    const darkMapStyle = {
        version: 8,
        sources: {
            'osm-tiles': {
                type: 'raster',
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution: '© OpenStreetMap contributors'
            }
        },
        layers: [{
            id: 'osm-layer',
            type: 'raster',
            source: 'osm-tiles',
            minzoom: 0,
            maxzoom: 22
        }],
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
    };

    return (
        <>
            <Map
                {...viewState}
                onMove={(evt: ViewStateChangeEvent) => setViewState(evt.viewState)}
                style={{ width: '100%', height: '100%', filter: 'invert(1) hue-rotate(180deg) brightness(0.7) contrast(1.2)' }}
                mapStyle={darkMapStyle as any}
                interactiveLayerIds={['territory-fill']}
                cursor="pointer"
                onClick={(evt: MapLayerMouseEvent) => {
                    console.log('Map clicked!', evt);

                    let features = evt.features;

                    // Manual query to debug if automatic features are missing
                    if (!features || features.length === 0) {
                        try {
                            const manualFeatures = evt.target.queryRenderedFeatures(evt.point, {
                                layers: ['territory-fill']
                            });
                            console.log('Manual query features:', manualFeatures);
                            features = manualFeatures;
                        } catch (e) {
                            console.warn('Manual query failed:', e);
                        }
                    }

                    if (previewImage) return;

                    const feature = features?.[0];
                    if (feature) {
                        console.log('Feature properties:', feature.properties);
                        const id = feature.properties?.id;
                        const territory = territories.find(t => t.id === id);
                        console.log('Found territory:', territory);
                        if (territory) {
                            setSelectedTerritory(territory);
                            setShowRentModal(true);
                        }
                    } else {
                        console.log('No features found at click location');
                    }
                }}
            >
                <Source id="territories" type="geojson" data={geoJsonData}>
                    <Layer {...fillLayer} />
                    <Layer {...lineLayer} />
                </Source>

                {previewImage && previewCoordinates && (
                    <Source id="ad-preview" type="image" url={previewImage.url} coordinates={previewCoordinates as any}>
                        <Layer id="ad-preview-layer" type="raster" paint={{ 'raster-opacity': 0.9, 'raster-fade-duration': 0 }} />
                    </Source>
                )}

                {selectedTerritory && !previewImage && (
                    <Popup
                        latitude={selectedTerritory.center.lat}
                        longitude={selectedTerritory.center.lng}
                        closeButton={false}
                        closeOnClick={false}
                        anchor="bottom"
                        offset={20}
                        className="z-50"
                    >
                        <div className="glass-panel p-4 rounded-xl border border-white/10 min-w-[200px]">
                            <div className="flex justify-between items-start mb-2">
                                <h3 className="font-bold text-white">{selectedTerritory.name}</h3>
                                <button onClick={() => setSelectedTerritory(null)} className="text-slate-400 hover:text-white">×</button>
                            </div>
                            {/* PFP X Brand Logic Display */}
                            {(selectedTerritory as any).activeAd ? (
                                <div className="mb-3 p-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                                    <p className="text-xs text-red-400 font-bold uppercase mb-1">Rented By You</p>
                                    <div className="flex items-center gap-2">
                                        <div className="w-6 h-6 rounded-full bg-slate-700 overflow-hidden border border-white/20">
                                            <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${selectedTerritory.ownerName}`} alt="Owner" />
                                        </div>
                                        <span className="text-xs text-slate-400">X</span>
                                        <div className="w-6 h-6 rounded-full bg-white overflow-hidden border border-white/20 p-0.5">
                                            <img
                                                src={localStorage.getItem('brandProfile') ? JSON.parse(localStorage.getItem('brandProfile')!).logo : "/nike-logo.png"}
                                                alt="Brand"
                                                className="w-full h-full object-contain"
                                            />
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="mb-3">
                                    <p className="text-xs text-green-400 font-bold uppercase">Available</p>
                                    <p className="text-lg font-bold text-white">₹{(selectedTerritory.rentPrice || 0).toLocaleString()}<span className="text-xs text-slate-400 font-normal">/hr</span></p>
                                </div>
                            )}

                            <button
                                onClick={() => {
                                    if ((selectedTerritory as any).activeAd) {
                                        // Manage Ad logic
                                    } else {
                                        setShowRentModal(true);
                                    }
                                }}
                                className="w-full bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-500 hover:to-purple-500 text-white font-bold py-2 rounded-lg shadow-lg shadow-cyan-500/20 text-sm transition-all"
                            >
                                {(selectedTerritory as any).activeAd ? 'Manage Ad' : 'Rent Territory'}
                            </button>
                        </div>
                    </Popup>
                )}
            </Map>

            {previewImage && (
                <motion.div
                    initial={{ y: 100, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 glass-panel p-6 rounded-2xl border border-white/10 flex flex-col gap-4 min-w-[320px]"
                >
                    <h3 className="text-white font-bold text-sm uppercase tracking-wider mb-2">Adjust Ad Placement</h3>

                    <ControlSlider label="Rotate" value={rotation} min={-180} max={180} onChange={setRotation} unit="°" />
                    <ControlSlider label="Scale" value={scale} min={0.5} max={2} step={0.05} onChange={setScale} unit="x" />
                    <ControlSlider label="Stretch X" value={stretchX} min={0.5} max={2} step={0.05} onChange={setStretchX} unit="x" />
                    <ControlSlider label="Stretch Y" value={stretchY} min={0.5} max={2} step={0.05} onChange={setStretchY} unit="x" />

                    <div className="flex gap-3 mt-2">
                        <button
                            onClick={() => { setRotation(0); setScale(1); setStretchX(1); setStretchY(1); }}
                            className="flex-1 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-medium transition-colors"
                        >
                            Reset
                        </button>
                        <button
                            onClick={() => {
                                setPreviewImage(null);
                                setBaseCoordinates(null);
                                setRotation(0);
                                setScale(1);
                                setStretchX(1);
                                setStretchY(1);
                            }}
                            className="flex-1 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-bold transition-colors shadow-lg shadow-cyan-500/20"
                        >
                            Apply Changes
                        </button>
                    </div>
                </motion.div>
            )}

            {/* Rent Modal */}
            {showRentModal && selectedTerritory && (
                <SimpleRentModal
                    territory={selectedTerritory}
                    onClose={() => setShowRentModal(false)}
                    onPreview={(imageUrl, coordinates) => {
                        setPreviewImage({ url: imageUrl, coordinates });
                        setShowRentModal(false);
                    }}
                    onRentSuccess={() => {
                        loadTerritories(); // Refresh map data
                    }}
                />
            )}
        </>
    );
}

function ControlSlider({ label, value, min, max, step = 1, onChange, unit }: any) {
    return (
        <div className="flex items-center gap-3">
            <label className="text-slate-400 text-xs w-16">{label}</label>
            <input
                type="range" min={min} max={max} step={step} value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="flex-1 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-cyan-500"
            />
            <span className="text-white text-xs w-8 text-right font-mono">{value}{unit}</span>
        </div>
    );
}
