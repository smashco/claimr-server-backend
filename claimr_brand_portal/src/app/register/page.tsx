'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Lock, Mail, User, Globe, Upload, ArrowRight } from 'lucide-react';

export default function RegisterPage() {
    const router = useRouter();
    const [formData, setFormData] = useState({
        brandName: '',
        email: '',
        website: '',
        password: '',
    });
    const [isLoading, setIsLoading] = useState(false);
    const [logoPreview, setLogoPreview] = useState<string | null>(null);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);

        // Simulate API call and save to localStorage
        setTimeout(() => {
            const brandProfile = {
                name: formData.brandName,
                website: formData.website,
                email: formData.email,
                logo: logoPreview || '/nike-logo.png' // Fallback to default if no logo
            };
            localStorage.setItem('brandProfile', JSON.stringify(brandProfile));

            setIsLoading(false);
            router.push('/dashboard');
        }, 1500);
    };

    return (
        <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden bg-slate-950 py-10">
            {/* Animated Background Elements */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <motion.div
                    animate={{
                        x: [0, -50, 0],
                        y: [0, 100, 0],
                        opacity: [0.2, 0.5, 0.2]
                    }}
                    transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute top-[-10%] right-[-10%] w-[600px] h-[600px] rounded-full bg-cyan-500/10 blur-[100px]"
                />
                <motion.div
                    animate={{
                        x: [0, 50, 0],
                        y: [0, -50, 0],
                        opacity: [0.2, 0.5, 0.2]
                    }}
                    transition={{ duration: 18, repeat: Infinity, ease: "easeInOut", delay: 1 }}
                    className="absolute bottom-[-10%] left-[-10%] w-[700px] h-[700px] rounded-full bg-purple-600/10 blur-[120px]"
                />
            </div>

            {/* Register Card */}
            <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.5 }}
                className="relative z-10 w-full max-w-lg p-8 glass-panel rounded-2xl border border-white/10"
            >
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold mb-2 text-white">
                        Join <span className="bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-purple-500">RunerrX</span>
                    </h1>
                    <p className="text-slate-400 text-sm">Create your brand profile and start dominating.</p>
                </div>

                <form onSubmit={handleRegister} className="space-y-5">

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-slate-300 uppercase tracking-wider ml-1">Brand Name</label>
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 group-focus-within:text-cyan-400 transition-colors">
                                    <User size={18} />
                                </div>
                                <input
                                    type="text"
                                    name="brandName"
                                    value={formData.brandName}
                                    onChange={handleChange}
                                    className="w-full bg-slate-900/50 border border-white/10 rounded-lg py-3 pl-10 pr-4 text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all"
                                    placeholder="Nike"
                                    required
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-medium text-slate-300 uppercase tracking-wider ml-1">Website</label>
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 group-focus-within:text-cyan-400 transition-colors">
                                    <Globe size={18} />
                                </div>
                                <input
                                    type="url"
                                    name="website"
                                    value={formData.website}
                                    onChange={handleChange}
                                    className="w-full bg-slate-900/50 border border-white/10 rounded-lg py-3 pl-10 pr-4 text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all"
                                    placeholder="nike.com"
                                />
                            </div>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-300 uppercase tracking-wider ml-1">Email Address</label>
                        <div className="relative group">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 group-focus-within:text-cyan-400 transition-colors">
                                <Mail size={18} />
                            </div>
                            <input
                                type="email"
                                name="email"
                                value={formData.email}
                                onChange={handleChange}
                                className="w-full bg-slate-900/50 border border-white/10 rounded-lg py-3 pl-10 pr-4 text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all"
                                placeholder="marketing@nike.com"
                                required
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-300 uppercase tracking-wider ml-1">Password</label>
                        <div className="relative group">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 group-focus-within:text-purple-400 transition-colors">
                                <Lock size={18} />
                            </div>
                            <input
                                type="password"
                                name="password"
                                value={formData.password}
                                onChange={handleChange}
                                className="w-full bg-slate-900/50 border border-white/10 rounded-lg py-3 pl-10 pr-4 text-white placeholder-slate-600 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50 transition-all"
                                placeholder="••••••••"
                                required
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-300 uppercase tracking-wider ml-1">Brand Logo</label>
                        <div
                            onClick={() => document.getElementById('logo-upload')?.click()}
                            className="border-2 border-dashed border-white/10 rounded-lg p-6 flex flex-col items-center justify-center text-slate-500 hover:border-cyan-500/50 hover:bg-white/5 transition-all cursor-pointer group relative overflow-hidden"
                        >
                            {logoPreview ? (
                                <img src={logoPreview} alt="Logo Preview" className="w-20 h-20 object-contain z-10" />
                            ) : (
                                <>
                                    <Upload size={24} className="mb-2 group-hover:text-cyan-400 transition-colors" />
                                    <span className="text-xs">Click to upload logo (PNG/JPG)</span>
                                </>
                            )}
                            <input
                                id="logo-upload"
                                type="file"
                                accept="image/png, image/jpeg"
                                className="hidden"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        const reader = new FileReader();
                                        reader.onloadend = () => {
                                            setLogoPreview(reader.result as string);
                                        };
                                        reader.readAsDataURL(file);
                                    }
                                }}
                            />
                        </div>
                    </div>

                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        type="submit"
                        disabled={isLoading}
                        className="w-full bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-500 hover:to-purple-500 text-white font-bold py-3 rounded-lg shadow-lg shadow-cyan-500/20 flex items-center justify-center gap-2 transition-all mt-4"
                    >
                        {isLoading ? (
                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <>
                                Create Account <ArrowRight size={18} />
                            </>
                        )}
                    </motion.button>
                </form>

                <div className="mt-8 text-center">
                    <p className="text-slate-400 text-sm">
                        Already have an account?{' '}
                        <Link href="/login" className="text-cyan-400 hover:text-cyan-300 font-medium transition-colors">
                            Log In
                        </Link>
                    </p>
                </div>
            </motion.div>
        </div>
    );
}
