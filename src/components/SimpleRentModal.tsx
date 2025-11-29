'use client';

import { useState, useEffect } from 'react';
import { api, Territory } from '@/lib/api';

interface SimpleRentModalProps {
    territory: Territory;
    onClose: () => void;
    onPreview: (imageUrl: string, coordinates: number[][]) => void;
    onRentSuccess?: () => void;
    onDesignClick?: () => void;
}

export default function SimpleRentModal({ territory, onClose, onPreview, onRentSuccess, onDesignClick }: SimpleRentModalProps) {
    const [duration, setDuration] = useState(3);
    const [file, setFile] = useState<File | null>(null);
    const [overlayFile, setOverlayFile] = useState<File | null>(null);
    const [backgroundColor, setBackgroundColor] = useState<string>('');
    const [brandName, setBrandName] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('brandProfile');
            return saved ? JSON.parse(saved).name : '';
        }
        return '';
    });
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);

    // Check for saved design on mount
    useEffect(() => {
        const savedDesign = localStorage.getItem(`design_${territory.id}`);
        const savedOverlay = localStorage.getItem(`design_${territory.id}_overlay`);
        const savedBg = localStorage.getItem(`design_${territory.id}_bg`);

        if (savedDesign) {
            fetch(savedDesign)
                .then(res => res.blob())
                .then(blob => {
                    const file = new File([blob], `design_${territory.id}.png`, { type: 'image/png' });
                    setFile(file);
                });
        }

        if (savedOverlay) {
            fetch(savedOverlay)
                .then(res => res.blob())
                .then(blob => {
                    const file = new File([blob], `design_${territory.id}_overlay.png`, { type: 'image/png' });
                    setOverlayFile(file);
                });
        }

        if (savedBg) {
            setBackgroundColor(savedBg);
        }
    }, [territory.id]);

    const ratePerSqFtPerDay = 0.005;
    const totalPrice = Math.max(1, Math.ceil(territory.areaSqFt * ratePerSqFtPerDay * duration));

    const handleRent = async () => {
        if (!file || !brandName) {
            alert('Please fill in all fields');
            return;
        }
        setLoading(true);
        try {
            // 1. Create Ad (Pending)
            const formData = new FormData();
            formData.append('territoryId', territory.id.toString());
            formData.append('brandName', brandName);
            formData.append('durationDays', duration.toString());
            formData.append('amountPaid', totalPrice.toString());
            formData.append('adContent', file);
            if (overlayFile) formData.append('overlayContent', overlayFile);
            if (backgroundColor) formData.append('backgroundColor', backgroundColor);

            const adRes = await api.createAd(formData);
            if (!adRes.success) throw new Error('Failed to create ad');

            // 2. Create Razorpay Order
            // Receipt length must be <= 40 chars. adId might be UUID (36 chars).
            const shortId = adRes.adId.toString().substring(0, 8);
            const orderRes = await api.createOrder(totalPrice, `rcpt_${shortId}_${Date.now().toString().slice(-4)}`);

            // 3. Open Razorpay Checkout
            const options = {
                key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_REQBbbQLxB81Vh', // Fallback for dev
                amount: orderRes.amount,
                currency: orderRes.currency,
                name: "RunerrX",
                description: `Rent ${territory.name} for ${duration} days`,
                order_id: orderRes.id,
                handler: async function (response: any) {
                    // 4. Verify Payment
                    try {
                        await api.verifyPayment({
                            razorpay_order_id: response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature,
                            adId: adRes.adId
                        });
                        setSuccess(true);
                        if (onRentSuccess) onRentSuccess();
                        setTimeout(() => {
                            onClose();
                        }, 2000);
                    } catch (err) {
                        console.error(err);
                        alert('Payment verification failed');
                    }
                },
                prefill: {
                    name: brandName,
                    email: "brand@example.com",
                    contact: "9999999999"
                },
                theme: {
                    color: "#3b82f6"
                }
            };

            const rzp1 = new (window as any).Razorpay(options);
            rzp1.on('payment.failed', function (response: any) {
                alert(response.error.description);
            });
            rzp1.open();

        } catch (err) {
            console.error(err);
            alert('Failed to initiate rental process');
        } finally {
            setLoading(false);
        }
    };

    // Load Razorpay Script
    if (typeof window !== 'undefined' && !(window as any).Razorpay) {
        const script = document.createElement('script');
        script.src = 'https://checkout.razorpay.com/v1/checkout.js';
        script.async = true;
        document.body.appendChild(script);
    }

    return (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                zIndex: 999999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '16px'
            }}
            onClick={onClose}
        >
            <div
                style={{
                    backgroundColor: '#1a1a1a',
                    borderRadius: '16px',
                    padding: '24px',
                    maxWidth: '500px',
                    width: '100%',
                    position: 'relative',
                    border: '1px solid rgba(255, 255, 255, 0.1)'
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Close Button */}
                <button
                    onClick={onClose}
                    style={{
                        position: 'absolute',
                        top: '16px',
                        right: '16px',
                        background: 'none',
                        border: 'none',
                        color: '#999',
                        fontSize: '24px',
                        cursor: 'pointer'
                    }}
                >
                    ×
                </button>

                {success ? (
                    <div style={{ textAlign: 'center', padding: '40px 0', color: '#4ade80' }}>
                        <div style={{ fontSize: '48px', marginBottom: '16px' }}>✓</div>
                        <h2 style={{ fontSize: '24px', fontWeight: 'bold', color: 'white', marginBottom: '8px' }}>Success!</h2>
                        <p>Territory Rented Successfully.</p>
                    </div>
                ) : (
                    <>
                        <h2 style={{ fontSize: '24px', fontWeight: 'bold', color: 'white', marginBottom: '4px' }}>
                            Rent {territory.name}
                        </h2>
                        <p style={{ color: '#999', fontSize: '14px', marginBottom: '24px' }}>
                            Area: {Math.round(territory.areaSqFt).toLocaleString()} sqft
                        </p>

                        {/* Brand Name */}
                        <div style={{ marginBottom: '16px' }}>
                            <label style={{ display: 'block', fontSize: '14px', color: '#999', marginBottom: '4px' }}>
                                Brand Name
                            </label>
                            <input
                                type="text"
                                value={brandName}
                                onChange={(e) => setBrandName(e.target.value)}
                                placeholder="Enter your brand name"
                                style={{
                                    width: '100%',
                                    padding: '12px',
                                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                                    border: '1px solid rgba(255, 255, 255, 0.1)',
                                    borderRadius: '8px',
                                    color: 'white',
                                    fontSize: '14px'
                                }}
                            />
                        </div>

                        {/* Duration */}
                        <div style={{ marginBottom: '16px' }}>
                            <label style={{ display: 'block', fontSize: '14px', color: '#999', marginBottom: '4px' }}>
                                Duration
                            </label>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                                {[3, 7, 30].map((d) => (
                                    <button
                                        key={d}
                                        onClick={() => setDuration(d)}
                                        style={{
                                            padding: '8px',
                                            borderRadius: '8px',
                                            border: `1px solid ${duration === d ? '#3b82f6' : 'rgba(255, 255, 255, 0.1)'}`,
                                            backgroundColor: duration === d ? '#3b82f6' : 'rgba(0, 0, 0, 0.5)',
                                            color: duration === d ? 'white' : '#999',
                                            fontSize: '14px',
                                            fontWeight: '500',
                                            cursor: 'pointer'
                                        }}
                                    >
                                        {d} Days
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Design Studio Integration */}
                        <div style={{ marginBottom: '24px' }}>
                            <label style={{ display: 'block', fontSize: '14px', color: '#999', marginBottom: '8px' }}>
                                Ad Creative
                            </label>

                            {!file ? (
                                <button
                                    onClick={() => {
                                        if (onDesignClick) {
                                            onDesignClick();
                                        } else {
                                            // Fallback to new tab if prop not provided
                                            window.open(`/brand/design?territoryId=${territory.id}`, '_blank');
                                        }
                                    }}
                                    style={{
                                        width: '100%',
                                        padding: '20px',
                                        border: '2px dashed #3b82f6',
                                        borderRadius: '12px',
                                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                                        color: '#60a5fa',
                                        fontSize: '16px',
                                        fontWeight: 'bold',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        gap: '8px'
                                    }}
                                >
                                    <span style={{ fontSize: '24px' }}>🎨</span>
                                    Design Your Area
                                    <span style={{ fontSize: '12px', fontWeight: 'normal', color: '#9ca3af' }}>
                                        Open the Design Studio to create your ad
                                    </span>
                                </button>
                            ) : (
                                <div style={{
                                    position: 'relative',
                                    border: '2px solid #22c55e',
                                    borderRadius: '12px',
                                    padding: '16px',
                                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                                    textAlign: 'center'
                                }}>
                                    <div style={{ color: '#22c55e', fontWeight: 'bold', marginBottom: '8px' }}>
                                        ✓ Design Ready
                                    </div>
                                    <img
                                        src={URL.createObjectURL(file)}
                                        alt="Ad Preview"
                                        style={{
                                            maxWidth: '100%',
                                            maxHeight: '150px',
                                            borderRadius: '8px',
                                            margin: '0 auto',
                                            display: 'block'
                                        }}
                                    />
                                    <button
                                        onClick={() => setFile(null)}
                                        style={{
                                            marginTop: '12px',
                                            color: '#ef4444',
                                            background: 'none',
                                            border: 'none',
                                            fontSize: '12px',
                                            cursor: 'pointer',
                                            textDecoration: 'underline'
                                        }}
                                    >
                                        Remove & Design Again
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Price & Pay */}
                        <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', paddingTop: '16px', marginTop: '24px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <span style={{ color: '#999' }}>Total Price</span>
                                <span style={{ fontSize: '24px', fontWeight: 'bold', color: 'white' }}>
                                    ₹{totalPrice.toLocaleString()}
                                </span>
                            </div>
                            <button
                                onClick={handleRent}
                                disabled={loading || !file || !brandName}
                                style={{
                                    flex: 1,
                                    background: 'linear-gradient(to right, #3b82f6, #8b5cf6)',
                                    color: 'white',
                                    fontWeight: 'bold',
                                    padding: '16px',
                                    borderRadius: '12px',
                                    border: 'none',
                                    cursor: loading || !file || !brandName ? 'not-allowed' : 'pointer',
                                    opacity: loading || !file || !brandName ? 0.5 : 1,
                                    fontSize: '16px'
                                }}
                            >
                                {loading ? 'Processing...' : 'Pay & Rent Now'}
                            </button>
                        </div>

                        {/* Preview Button (Only if file exists) */}
                        {file && (
                            <button
                                onClick={() => {
                                    if (!file || !territory.geometry || !territory.geometry.coordinates) return;

                                    try {
                                        const coords = territory.geometry.coordinates[0];
                                        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;

                                        coords.forEach((p: any) => {
                                            const lng = p[0];
                                            const lat = p[1];
                                            if (lat < minLat) minLat = lat;
                                            if (lat > maxLat) maxLat = lat;
                                            if (lng < minLng) minLng = lng;
                                            if (lng > maxLng) maxLng = lng;
                                        });

                                        const coordinates = [
                                            [minLng, maxLat], // Top Left
                                            [maxLng, maxLat], // Top Right
                                            [maxLng, minLat], // Bottom Right
                                            [minLng, minLat]  // Bottom Left
                                        ];

                                        const imageUrl = URL.createObjectURL(file);
                                        onPreview(imageUrl, coordinates);
                                    } catch (e) {
                                        console.error("Error preparing preview", e);
                                    }
                                }}
                                style={{
                                    width: '100%',
                                    marginTop: '12px',
                                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                    color: 'white',
                                    fontWeight: 'bold',
                                    padding: '12px',
                                    borderRadius: '12px',
                                    border: '1px solid rgba(255, 255, 255, 0.2)',
                                    cursor: 'pointer',
                                    fontSize: '14px'
                                }}
                            >
                                👁 Preview on Map
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
