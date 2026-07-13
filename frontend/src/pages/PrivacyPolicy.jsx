import { Link } from 'react-router-dom';
import { COMPANY_NAME } from '../config/company';

// Minimal, self-contained privacy policy — reachable at /privacy without login.
export default function PrivacyPolicy() {
  const org = COMPANY_NAME || 'the Company';
  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-2xl mx-auto bg-white shadow rounded-2xl p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-gray-900">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mt-1">How {org}'s HR portal handles your data.</p>

        <div className="mt-6 space-y-5 text-sm text-gray-700 leading-relaxed">
          <section>
            <h2 className="font-semibold text-gray-900 mb-1">What we collect</h2>
            <p>Your employment details (name, contact, designation, department), attendance including check-in/out time, selfie and location captured at each punch, leave and payroll records, uploaded documents, and requests you raise in the app.</p>
          </section>
          <section>
            <h2 className="font-semibold text-gray-900 mb-1">How we use it</h2>
            <p>Only to run internal HR operations - attendance, leave, payroll, statutory compliance, performance, and communication. We do not sell your data or use it for advertising.</p>
          </section>
          <section>
            <h2 className="font-semibold text-gray-900 mb-1">Who can see it</h2>
            <p>Access is limited to you and authorized HR/administrators on a need-to-know basis. Sensitive identifiers (e.g. Aadhaar, bank details) are masked and restricted to HR.</p>
          </section>
          <section>
            <h2 className="font-semibold text-gray-900 mb-1">Storage &amp; security</h2>
            <p>Data is stored on secured servers and transmitted over encrypted connections. Access is protected by individual logins and role-based permissions.</p>
          </section>
          <section>
            <h2 className="font-semibold text-gray-900 mb-1">Your choices</h2>
            <p>You can view your profile in the app and request corrections through the built-in change-request flow. Location is captured only at the moment you punch attendance.</p>
          </section>
          <section>
            <h2 className="font-semibold text-gray-900 mb-1">Contact</h2>
            <p>For any privacy question, contact your HR team through the app.</p>
          </section>
        </div>

        <div className="mt-8 pt-4 border-t border-gray-100">
          <Link to="/login" className="text-sm text-indigo-600 hover:underline">← Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}
