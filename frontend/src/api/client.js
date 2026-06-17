import axios from 'axios';
import { useAuthStore } from '../store/authStore';

// In dev, Vite proxies /api to VITE_BACKEND_URL, so a relative baseURL works.
// In a production build there's no proxy, so point axios at the backend directly.
const backendUrl = import.meta.env.VITE_BACKEND_URL;
const baseURL = import.meta.env.PROD && backendUrl ? `${backendUrl}/api` : '/api';

const api = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(err);
  }
);

export default api;
