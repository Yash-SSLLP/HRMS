import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const BADGES = [
  'Team Player',
  'Innovation',
  'Leadership',
  'Extra Mile',
  'Customer Hero',
  'Above & Beyond',
];

const BADGE_STYLES = {
  'Team Player': 'bg-blue-100 text-blue-800',
  Innovation: 'bg-purple-100 text-purple-800',
  Leadership: 'bg-amber-100 text-amber-800',
  'Extra Mile': 'bg-green-100 text-green-800',
  'Customer Hero': 'bg-rose-100 text-rose-800',
  'Above & Beyond': 'bg-indigo-100 text-indigo-800',
};

const initials = (person) => {
  if (!person) return '?';
  const f = (person.firstName || '').trim();
  const l = (person.lastName || '').trim();
  const text = `${f.charAt(0)}${l.charAt(0)}`.toUpperCase();
  return text || '?';
};

const fullName = (person) =>
  person ? `${person.firstName || ''} ${person.lastName || ''}`.trim() : 'Someone';

export default function EmployeeRecognition() {
  const [recognitions, setRecognitions] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ to: '', badge: 'Team Player', message: '' });

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [wallRes, peopleRes] = await Promise.all([
        api.get('/recognition'),
        api.get('/recognition/people'),
      ]);
      setRecognitions(wallRes.data.recognitions || []);
      setPeople(peopleRes.data.people || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load recognition wall');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/recognition', form);
      setShowModal(false);
      setForm({ to: '', badge: 'Team Player', message: '' });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not give kudos');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Recognition" subtitle="Celebrate your colleagues">
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm"
        >
          🎉 Give Kudos
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white shadow rounded-lg p-5 text-center text-gray-500">Loading…</div>
      ) : recognitions.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-5 text-center text-gray-500">
          No recognition yet. Be the first to give kudos!
        </div>
      ) : (
        <div className="space-y-4">
          {recognitions.map((r) => (
            <div key={r._id} className="bg-white shadow rounded-lg p-5">
              <div className="flex items-start gap-3">
                <span className="avatar-circle accent-bg text-white">{initials(r.from)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-gray-800">
                      <span className="font-semibold">{fullName(r.from)}</span>
                      {' recognized '}
                      <span className="font-semibold">{fullName(r.to)}</span>
                    </p>
                    <span
                      className={`inline-block px-2 py-0.5 text-xs rounded-lg ${
                        BADGE_STYLES[r.badge] || 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      🏆 {r.badge}
                    </span>
                  </div>
                  <p className="text-sm text-gray-700 mt-2 whitespace-pre-line">{r.message}</p>
                  <p className="text-xs text-gray-400 mt-2">
                    {new Date(r.createdAt).toLocaleString([], { hour12: true })}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">Give Kudos</h2>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Recipient *</label>
                <select
                  required
                  value={form.to}
                  onChange={(e) => setForm({ ...form, to: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2"
                >
                  <option value="">Select a person…</option>
                  {people.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.firstName} {p.lastName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Badge *</label>
                <select
                  required
                  value={form.badge}
                  onChange={(e) => setForm({ ...form, badge: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2"
                >
                  {BADGES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Message *</label>
                <textarea
                  required
                  value={form.message}
                  rows={4}
                  maxLength={500}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2"
                />
                <p className="text-xs text-gray-400 mt-1">{form.message.length}/500</p>
              </div>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                  {error}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
                >
                  {saving ? 'Sending…' : 'Send Kudos'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
