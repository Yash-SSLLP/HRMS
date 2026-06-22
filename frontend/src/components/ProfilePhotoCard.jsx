import { useRef, useState } from 'react';
import api from '../api/client';
import AuthImage from './AuthImage';
import { useAuthStore } from '../store/authStore';

function initials(user) {
  const a = (user?.firstName || '').trim()[0] || '';
  const b = (user?.lastName || '').trim()[0] || '';
  return (a + b).toUpperCase() || 'U';
}

// Self-service profile photo: upload / replace / remove. Updates the cached
// auth user so the top-bar and sidebar avatars refresh immediately.
export default function ProfilePhotoCard() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const big = (
    <span
      className="inline-flex items-center justify-center rounded-full accent-bg text-white font-semibold"
      style={{ width: 96, height: 96, fontSize: 34 }}
    >
      {initials(user)}
    </span>
  );

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.append('photo', file);
      const { data } = await api.post('/auth/me/avatar', form);
      setUser(data.user);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not upload photo');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await api.delete('/auth/me/avatar');
      setUser(data.user);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not remove photo');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white shadow rounded-lg p-5 mb-4">
      <h2 className="card-title mb-3">Profile Photo</h2>
      <div className="flex items-center gap-5">
        <div className="relative shrink-0">
          {user?.photo ? (
            <AuthImage
              url={`/auth/users/${user._id}/avatar?p=${encodeURIComponent(user.photo)}`}
              alt={initials(user)}
              className="rounded-full object-cover bg-gray-100"
              style={{ width: 96, height: 96 }}
              fallback={big}
            />
          ) : big}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-gray-500 mb-3">
            Shown across the app and in chat. JPG, PNG or WebP up to 5&nbsp;MB.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-60"
            >
              {busy ? 'Saving…' : user?.photo ? 'Change photo' : 'Upload photo'}
            </button>
            {user?.photo && (
              <button
                onClick={onRemove}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-red-600 hover:bg-red-50 disabled:opacity-60"
              >
                Remove
              </button>
            )}
          </div>
          {error && <div className="text-sm text-red-700 mt-2">{error}</div>}
        </div>
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
    </div>
  );
}
