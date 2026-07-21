import { useState } from 'react';
import AuthImage from './AuthImage';
import { downloadFile } from '../api/download';

// Renders an expense claim's uploaded receipt: an inline thumbnail for images
// (click to open full size) or a download link for PDFs. Falls back to a dash
// when no receipt is attached (e.g. legacy claims).
export default function ReceiptView({ expense }) {
  const [full, setFull] = useState(false);
  if (!expense?.hasReceipt) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  const url = `/expenses/${expense._id}/receipt`;
  const name = expense.receipt?.name || 'receipt';
  const isImage = (expense.receipt?.mime || '').startsWith('image/');

  if (!isImage) {
    return (
      <button type="button" onClick={() => downloadFile(url, name)}
        className="text-xs text-blue-600 hover:underline">
        View PDF
      </button>
    );
  }

  return (
    <>
      <AuthImage url={url} alt="receipt"
        className="h-10 w-10 rounded object-cover border cursor-pointer"
        onClick={() => setFull(true)} />
      {full && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setFull(false)}>
          <AuthImage url={url} alt="receipt"
            className="max-h-[90vh] max-w-[90vw] rounded shadow-lg" />
        </div>
      )}
    </>
  );
}
