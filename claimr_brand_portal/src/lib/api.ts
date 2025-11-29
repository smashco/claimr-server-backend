import axios from 'axios';

// Use relative URL since frontend is served from same domain as backend
const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

export interface Territory {
    id: number;
    name: string;
    center: { lat: number; lng: number };
    geometry: any; // GeoJSON geometry
    areaSqFt: number;
    laps: number;
    ownerName: string;
    identityColor: string;
    rentPrice: number;
}

export const api = {
    getTerritories: async (): Promise<Territory[]> => {
        const response = await axios.get(`${API_URL}/api/brands/territories`);
        return response.data;
    },

    calculatePrice: async (areaSqFt: number, laps: number) => {
        const response = await axios.post(`${API_URL}/api/brands/calculate-price`, { areaSqFt, laps });
        return response.data;
    },

    createAd: async (formData: FormData) => {
        const response = await axios.post(`${API_URL}/api/brands/create-ad`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
        });
        return response.data;
    },

    createOrder: async (amount: number, receipt: string) => {
        const response = await axios.post(`${API_URL}/api/brands/create-order`, { amount, receipt });
        return response.data;
    },

    verifyPayment: async (paymentData: any) => {
        const response = await axios.post(`${API_URL}/api/brands/verify-payment`, paymentData);
        return response.data;
    }
};
