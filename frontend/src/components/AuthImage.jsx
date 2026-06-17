import { useEffect, useState } from 'react';
import { fetchImageObjectUrl } from '../api/download';

// Renders an image from a protected API endpoint (needs the Bearer token, which
// a plain <img src> can't send). Fetches as a blob and uses an object URL.
export default function AuthImage({ url, alt = '', className = '', onClick }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl;
    let active = true;
    setFailed(false);
    setSrc(null);
    fetchImageObjectUrl(url)
      .then((u) => {
        objectUrl = u;
        if (active) setSrc(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (failed) return <span className={`text-xs text-gray-400 ${className}`}>n/a</span>;
  if (!src) return <span className={`inline-block bg-gray-100 animate-pulse ${className}`} />;
  return <img src={src} alt={alt} className={className} onClick={onClick} />;
}
