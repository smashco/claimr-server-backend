'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { ArrowRight, MapPin, TrendingUp, DollarSign } from 'lucide-react';

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white overflow-hidden relative">
      {/* Background Gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-purple-900/20 via-black to-blue-900/20 pointer-events-none" />

      {/* Navigation */}
      <nav className="absolute top-0 left-0 right-0 z-50 p-6 flex justify-between items-center container mx-auto">
        <div className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-purple-500">
          RunerrX
        </div>
        <div className="flex gap-4">
          <Link href="/login">
            <button className="px-4 py-2 text-slate-300 hover:text-white font-medium transition-colors">
              Log In
            </button>
          </Link>
          <Link href="/register">
            <button className="px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/10 rounded-full text-white font-medium transition-all backdrop-blur-md">
              Get Started
            </button>
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <div className="container mx-auto px-4 h-screen flex flex-col justify-center items-center relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="text-center"
        >
          <h1 className="text-6xl md:text-8xl font-bold tracking-tighter mb-6 bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-purple-500 to-pink-500">
            DOMINATE<br />THE MAP
          </h1>
          <p className="text-xl md:text-2xl text-gray-400 mb-12 max-w-2xl mx-auto">
            Rent real-world territories. Place your brand where players run.
            <span className="text-white font-semibold"> Be seen by thousands.</span>
          </p>

          <div className="flex flex-col md:flex-row gap-4 justify-center items-center">
            <Link href="/register">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="group bg-gradient-to-r from-cyan-500 to-purple-600 text-white px-8 py-4 rounded-full font-bold text-lg flex items-center gap-2 shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 transition-all"
              >
                Start Campaign
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </motion.button>
            </Link>

            <Link href="/map">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="px-8 py-4 rounded-full font-bold text-lg flex items-center gap-2 text-slate-300 hover:text-white border border-white/10 hover:bg-white/5 transition-all"
              >
                View Live Map
              </motion.button>
            </Link>
          </div>
        </motion.div>

        {/* Stats / Features */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.8 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-24 w-full max-w-4xl"
        >
          <FeatureCard
            icon={<MapPin className="w-8 h-8 text-cyan-400" />}
            title="Select Territory"
            desc="Choose high-traffic zones captured by top players."
          />
          <FeatureCard
            icon={<DollarSign className="w-8 h-8 text-green-400" />}
            title="Rent & Rule"
            desc="Pay per sqft. Your brand stays even if the territory is conquered."
          />
          <FeatureCard
            icon={<TrendingUp className="w-8 h-8 text-pink-400" />}
            title="High Engagement"
            desc="Players see your brand daily on their run map."
          />
        </motion.div>
      </div>
    </main>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
  return (
    <div className="bg-white/5 backdrop-blur-lg p-6 rounded-2xl border border-white/10 hover:border-cyan-500/30 transition-colors group">
      <div className="mb-4 group-hover:scale-110 transition-transform duration-300">{icon}</div>
      <h3 className="text-xl font-bold mb-2 text-white">{title}</h3>
      <p className="text-gray-400">{desc}</p>
    </div>
  );
}
