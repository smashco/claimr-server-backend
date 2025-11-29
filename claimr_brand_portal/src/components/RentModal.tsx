'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Upload, Check } from 'lucide-react';
import { api, Territory } from '@/lib/api';

interface RentModalProps {
    territory: Territory | null;
    onClose: () => void;
}

export default function RentModal({ territory, onClose }: RentModalProps) {
    const [duration, setDuration] = useState(3); // Days
    const [file, setFile] = useState<File | null>(null);
    const [brandName, setBrandName] = useState('');
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);

    if (!territory) return null;

    const basePrice = territory.rentPrice;
    const totalPrice = Math.round(basePrice * (duration / 3)); // Simple multiplier logic

    const handleRent = async () => {
        if (!file || !brandName) return;
        setLoading(true);
        try {
            const formData = new FormData();
            formData.append('territoryId', territory.id.toString());
            formData.append('brandName', brandName);
            formData.append('durationDays', duration.toString());
            formData.append('amountPaid', totalPrice.toString());
            formData.append('adContent', file);

            const res = await api.createAd(formData);

            // Mock Payment Verification
            await api.verifyPayment({ adId: res.adId, paymentId: 'mock_payment_id' });

            setSuccess(true);
            setTimeout(() => {
                onClose();
                setSuccess(false);
            }, 2000);
        } catch (err) {
            console.error(err);
            alert('Failed to rent territory');
        } finally {
            setLoading(false);
        }
    };

    return (
        <AnimatePresence>
            {territory && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
                >
                    <motion.div
                        initial={{ scale: 0.9, y: 20 }}
                        animate={{ scale: 1, y: 0 }}
                        exit={{ scale: 0.9, y: 20 }}
                        className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl relative overflow-hidden"
                    >
                        {/* Close Button */}
                        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white">
                            <X className="w-6 h-6" />
                        </button>

                        {success ? (
                            <div className="flex flex-col items-center justify-center py-12 text-green-400">
                                <div className="bg-green-400/20 p-4 rounded-full mb-4">
                                    <Check className="w-12 h-12" />
                                </div>
                                <h2 className="text-2xl font-bold text-white">Success!</h2>
                                <p>Territory Rented Successfully.</p>
                            </div>
                        ) : (
                            <>
                                <h2 className="text-2xl font-bold text-white mb-1">Rent {territory.name}</h2>
                                <p className="text-gray-400 text-sm mb-6">
                                    Area: {Math.round(territory.areaSqFt).toLocaleString()} sqft • Laps: {territory.laps}
                                </p>

                                <div className="space-y-4">
                                    {/* Brand Name */}
                                    <div>
                                        <label className="block text-sm text-gray-400 mb-1">Brand Name</label>
                                        <input
                                            type="text"
                                            value={brandName}
                                            onChange={(e) => setBrandName(e.target.value)}
                                            className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white focus:border-blue-500 outline-none"
                                            placeholder="Enter your brand name"
                                        />
                                    </div>

                                    {/* Duration Selection */}
                                    <div>
                                        <label className="block text-sm text-gray-400 mb-1">Duration</label>
                                        <div className="grid grid-cols-3 gap-2">
                                            {[3, 7, 30].map((d) => (
                                                <button
                                                    key={d}
                                                    onClick={() => setDuration(d)}
                                                    className={`p-2 rounded-lg border text-sm font-medium transition-colors ${duration === d
                                                        ? 'bg-blue-600 border-blue-500 text-white'
                                                        : 'bg-black/50 border-white/10 text-gray-400 hover:bg-white/5'
                                                        }`}
                                                >
                                                    {d} Days
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* File Upload */}
                                    <div>
                                        <label className="block text-sm text-gray-400 mb-1">Ad Creative (Image)</label>
                                        <div className="relative group">
                                            <input
                                                type="file"
                                                accept="image/*"
                                                onChange={(e) => setFile(e.target.files?.[0] || null)}
                                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                            />
                                            <div className={`border-2 border-dashed rounded-lg p-4 flex flex-col items-center justify-center transition-colors ${file ? 'border-green-500 bg-green-500/10' : 'border-white/10 hover:border-white/30 bg-black/30'
                                                }`}>
                                                {file ? (
                                                    <div className="text-green-400 flex items-center gap-2">
                                                        <Check className="w-4 h-4" />
                                                        <span className="text-sm truncate max-w-[200px]">{file.name}</span>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <Upload className="w-6 h-6 text-gray-400 mb-2" />
                                                        <span className="text-xs text-gray-500">Click to upload</span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Price & Pay */}
                                    <div className="pt-4 border-t border-white/10 mt-6">
                                        <div className="flex justify-between items-center mb-4">
                                            <span className="text-gray-400">Total Price</span>
                                            <span className="text-2xl font-bold text-white">₹{totalPrice.toLocaleString()}</span>
                                        </div>
                                        <button
                                            onClick={handleRent}
                                            disabled={loading || !file || !brandName}
                                            className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold py-4 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {loading ? 'Processing...' : 'Pay & Rent Now'}
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
