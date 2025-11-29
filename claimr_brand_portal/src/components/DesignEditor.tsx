'use client';

import { useEffect, useRef, useState } from 'react';
import * as fabric from 'fabric';
import { Territory } from '@/lib/api';
import {
    Image as ImageIcon,
    Type as TypeIcon,
    Trash2,
    Download,
    X,
    Undo,
    Redo,
    Layers,
    Palette,
    MousePointer2
} from 'lucide-react';

interface DesignEditorProps {
    territory: Territory;
    onSave: (data: { fullImage: string, overlayImage: string, backgroundColor: string }) => void;
    onCancel: () => void;
}

export default function DesignEditor({ territory, onSave, onCancel }: DesignEditorProps) {
    // Ref for the canvas element
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [fabricCanvas, setFabricCanvas] = useState<fabric.Canvas | null>(null);
    const [selectedObject, setSelectedObject] = useState<fabric.Object | null>(null);
    const [backgroundColor, setBackgroundColor] = useState('#ffffff');
    const [isSaving, setIsSaving] = useState(false);

    // Initialize Canvas
    useEffect(() => {
        if (!canvasRef.current) return;

        console.log('[DesignEditor] Territory data:', territory);
        console.log('[DesignEditor] Geometry:', territory.geometry);
        // Calculate bounds and dimensions
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;

        if (territory.geometry && territory.geometry.coordinates) {
            const coords = territory.geometry.coordinates[0];
            coords.forEach((p: any) => {
                const lng = p[0];
                const lat = p[1];
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
            });
        } else {
            console.error('[DesignEditor] ERROR: No geometry data found for territory!', territory);
        }

        const geoWidth = maxLng - minLng;
        const geoHeight = maxLat - minLat;
        const centerLat = (minLat + maxLat) / 2;

        console.log('[DesignEditor] Bounds:', { minLat, maxLat, minLng, maxLng, geoWidth, geoHeight });

        // Calculate visual aspect ratio
        const latRad = centerLat * Math.PI / 180;
        const metersPerDegreeLat = 111320;
        const metersPerDegreeLng = 111320 * Math.cos(latRad);

        const widthMeters = geoWidth * metersPerDegreeLng;
        const heightMeters = geoHeight * metersPerDegreeLat;

        const aspectRatio = widthMeters / heightMeters;

        // Set canvas dimensions - Fit within the container
        if (!containerRef.current) return;

        const canvasWidth = containerRef.current.clientWidth;
        const canvasHeight = containerRef.current.clientHeight;

        // Use container dimensions for canvas
        const canvas = new fabric.Canvas(canvasRef.current, {
            width: canvasWidth,
            height: canvasHeight,
            backgroundColor: '#111827', // Set default background
            selection: false, // Disable selection by default
            preserveObjectStacking: true
        });

        setFabricCanvas(canvas);

        // Handle selection
        canvas.on('selection:created', (e) => setSelectedObject(e.selected?.[0] || null));
        canvas.on('selection:updated', (e) => setSelectedObject(e.selected?.[0] || null));
        canvas.on('selection:cleared', () => setSelectedObject(null));

        // Create Stencil
        if (territory.geometry && territory.geometry.coordinates) {
            const coords = territory.geometry.coordinates[0];

            const points = coords.map((p: any) => {
                const lng = p[0];
                const lat = p[1];
                const xNorm = (lng - minLng) / geoWidth;
                const yNorm = (maxLat - lat) / geoHeight;
                return {
                    x: xNorm * canvasWidth,
                    y: yNorm * canvasHeight
                };
            });



            const polygon = new fabric.Polygon(points, {
                left: 0,
                top: 0,
                originX: 'left',
                originY: 'top',
                absolutePositioned: true
            });

            canvas.clipPath = polygon;

            // Visual border
            const border = new fabric.Polygon(points, {
                left: 0,
                top: 0,
                fill: 'transparent',
                stroke: '#3b82f6',
                strokeWidth: 2,
                strokeDashArray: [10, 10],
                selectable: false,
                evented: false,
                absolutePositioned: true,
                opacity: 0.5
            });
            canvas.add(border);
            canvas.renderAll();
        }

        return () => {
            canvas.dispose();
        };
    }, [territory]);

    // Tools
    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !fabricCanvas) return;

        const reader = new FileReader();
        reader.onload = (f) => {
            const data = f.target?.result as string;
            fabric.Image.fromURL(data).then((img) => {
                if (img.width && img.width > 400) {
                    img.scaleToWidth(400);
                }
                fabricCanvas.add(img);
                fabricCanvas.centerObject(img);
                fabricCanvas.setActiveObject(img);
                fabricCanvas.renderAll();
            });
        };
        reader.readAsDataURL(file);
    };

    const addText = () => {
        if (!fabricCanvas) return;
        const text = new fabric.IText('Your Brand', {
            left: 100,
            top: 100,
            fontFamily: 'Inter, sans-serif',
            fill: '#000000',
            fontSize: 40,
            fontWeight: 'bold'
        });
        fabricCanvas.add(text);
        fabricCanvas.centerObject(text);
        fabricCanvas.setActiveObject(text);
    };

    const changeBackground = (color: string) => {
        if (!fabricCanvas) return;
        setBackgroundColor(color);
        fabricCanvas.backgroundColor = color;
        fabricCanvas.renderAll();
    };

    const deleteSelected = () => {
        if (!fabricCanvas || !selectedObject) return;
        fabricCanvas.remove(selectedObject);
        fabricCanvas.discardActiveObject();
        fabricCanvas.renderAll();
    };

    // Note: Removed localStorage caching feature to prevent QuotaExceededError
    // Designs are now only saved to S3 via the API

    const handleSave = () => {
        if (!fabricCanvas) return;

        // Validation: Check for background color
        if (!backgroundColor || backgroundColor === 'transparent' || backgroundColor === '') {
            alert("Please select a background color before saving. This ensures your ad looks great on the map!");
            return;
        }

        setIsSaving(true);
        // Small delay to show loading state
        setTimeout(() => {
            // 1. Generate Full Image (with background)
            const fullImage = fabricCanvas.toDataURL({
                format: 'png',
                quality: 1,
                multiplier: 2
            });

            // 2. Generate Transparent Overlay
            const originalBg = fabricCanvas.backgroundColor;
            fabricCanvas.backgroundColor = 'transparent'; // Set transparent
            fabricCanvas.renderAll(); // Re-render

            const overlayImage = fabricCanvas.toDataURL({
                format: 'png',
                quality: 1,
                multiplier: 2
            });

            // Restore background
            fabricCanvas.backgroundColor = originalBg;
            fabricCanvas.renderAll();

            onSave({ fullImage, overlayImage, backgroundColor });
        }, 500);
    };

    return (
        <div className="flex h-screen bg-[#0f172a] text-white overflow-hidden font-sans">
            {/* Sidebar Tools */}
            <div className="w-80 bg-[#1e293b] border-r border-gray-800 flex flex-col shadow-xl z-10">
                <div className="p-6 border-b border-gray-800">
                    <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                        Design Studio
                    </h1>
                    <p className="text-xs text-gray-400 mt-1">Designing for: {territory.name}</p>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-8">
                    {/* Add Content Section */}
                    <section>
                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                            <Layers size={14} /> Layers & Content
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col items-center justify-center p-4 bg-[#0f172a] border border-gray-700 rounded-xl cursor-pointer hover:border-blue-500 hover:bg-[#1e293b] transition-all group">
                                <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center mb-2 group-hover:bg-blue-500/20 transition-colors">
                                    <ImageIcon size={20} className="text-blue-400" />
                                </div>
                                <span className="text-sm font-medium text-gray-300">Image</span>
                                <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                            </label>

                            <button
                                onClick={addText}
                                className="flex flex-col items-center justify-center p-4 bg-[#0f172a] border border-gray-700 rounded-xl hover:border-purple-500 hover:bg-[#1e293b] transition-all group"
                            >
                                <div className="w-10 h-10 rounded-full bg-purple-500/10 flex items-center justify-center mb-2 group-hover:bg-purple-500/20 transition-colors">
                                    <TypeIcon size={20} className="text-purple-400" />
                                </div>
                                <span className="text-sm font-medium text-gray-300">Text</span>
                            </button>
                        </div>
                    </section>

                    {/* Background Section */}
                    <section>
                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                            <Palette size={14} /> Background
                        </h3>
                        <div className="grid grid-cols-5 gap-2">
                            {['#ffffff', '#000000', '#f8fafc', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'].map(color => (
                                <button
                                    key={color}
                                    onClick={() => changeBackground(color)}
                                    className={`w-10 h-10 rounded-lg border-2 transition-transform hover:scale-110 ${backgroundColor === color ? 'border-white shadow-lg scale-110' : 'border-transparent'}`}
                                    style={{ backgroundColor: color }}
                                    title={color}
                                />
                            ))}
                        </div>
                        <div className="mt-3 flex items-center gap-3 p-3 bg-[#0f172a] rounded-lg border border-gray-700">
                            <input
                                type="color"
                                value={backgroundColor}
                                onChange={(e) => changeBackground(e.target.value)}
                                className="w-8 h-8 rounded cursor-pointer bg-transparent border-none"
                            />
                            <span className="text-sm text-gray-400 font-mono">{backgroundColor}</span>
                        </div>
                    </section>

                    {/* Selection Properties */}
                    {selectedObject && (
                        <section className="animate-in slide-in-from-left-4 fade-in duration-200">
                            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                                <MousePointer2 size={14} /> Selection
                            </h3>
                            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-sm text-red-200">Selected Item</span>
                                </div>
                                <button
                                    onClick={deleteSelected}
                                    className="w-full flex items-center justify-center gap-2 p-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors text-sm font-medium"
                                >
                                    <Trash2 size={16} /> Delete Object
                                </button>
                            </div>
                        </section>
                    )}
                </div>

                {/* Footer Info */}
                <div className="p-4 border-t border-gray-800 text-xs text-gray-500 text-center">
                    Use mouse to move, scale & rotate
                </div>
            </div>

            {/* Main Canvas Area */}
            <div className="flex-1 flex flex-col relative bg-[#0f172a] bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px]">
                {/* Top Bar */}
                <div className="h-16 border-b border-gray-800 flex items-center justify-between px-8 bg-[#0f172a]/80 backdrop-blur-md z-10">
                    <div className="flex items-center gap-4">
                        {/* Undo/Redo placeholders - functionality would need history stack */}
                        <button className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors" title="Undo">
                            <Undo size={18} />
                        </button>
                        <button className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors" title="Redo">
                            <Redo size={18} />
                        </button>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={onCancel}
                            className="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors flex items-center gap-2"
                        >
                            <X size={16} /> Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="px-6 py-2 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 rounded-lg shadow-lg shadow-blue-500/20 transition-all transform hover:scale-105 active:scale-95 flex items-center gap-2"
                        >
                            {isSaving ? (
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : (
                                <Download size={16} />
                            )}
                            {isSaving ? 'Saving...' : 'Save Design'}
                        </button>
                    </div>
                </div>

                {/* Canvas Container */}
                <div ref={containerRef} className="flex-1 overflow-auto flex items-center justify-center p-12">
                    <div className="relative shadow-2xl shadow-black/50 rounded-sm overflow-hidden border border-gray-700 bg-[url('https://res.cloudinary.com/dvvqa6xgj/image/upload/v1709138658/checkerboard_v2_q7gq9e.png')] bg-repeat">
                        <canvas ref={canvasRef} />
                    </div>
                </div>
            </div>
        </div>
    );
}
