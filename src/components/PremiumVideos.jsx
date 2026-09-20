import { PlayCircle } from 'lucide-react';
import { chaosFromUrl } from '../chaos';

const VIDEOS = [
  { title: '1. Accepting a Friendly Stranger', url: 'https://www.youtube.com/watch?v=sS19XTOhp9c' },
  { title: '2. Sitting Politely for Petting', url: 'https://www.youtube.com/watch?v=cUiTogQMaPY' },
  { title: '3. Appearance and Grooming', url: 'https://www.youtube.com/watch?v=JaFBFHhbNu0' },
  { title: 'Exercises Explained and Demonstrated', url: 'https://www.youtube.com/watch?v=WUy9HzYX4OY' },
];

// DEMO ONLY (remediation). Ticking "Simulate a bad release" in the page header (or
// opening the page with ?chaos=1) simulates a bad
// release: the last video has no URL, so this component throws while rendering.
// That produces JavaScript errors in New Relic, which is what the alert reacts to.
export default function PremiumVideos({ chaos = chaosFromUrl() }) {
  const videos = chaos ? [...VIDEOS.slice(0, 3), { title: VIDEOS[3].title }] : VIDEOS;

  return (
    <div className="card animate-fade-in" style={{ borderColor: 'var(--primary)', backgroundColor: '#EEF2FF' }}>
      <h3 style={{ color: 'var(--primary)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <PlayCircle size={24} />
        Premium Video Tutorials
      </h3>
      <p style={{ marginBottom: '1rem', color: 'var(--text-main)', fontSize: '0.875rem' }}>
        Unlock our exclusive library of expert canine behaviorist videos. Master the 10 CGC test items with visual guides.
      </p>

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {videos.map((video) => (
          <div key={video.title} style={{ background: 'white', padding: '0.6rem 0.75rem', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>{video.title}</span>
            {/* The bug: video.url is undefined for the last video in chaos mode. */}
            <a href={new URL(video.url).href} target="_blank" rel="noreferrer" className="btn btn-primary" style={{ padding: '0.4rem 0.8rem', fontSize: '0.875rem', textDecoration: 'none' }}>Watch</a>
          </div>
        ))}
      </div>
    </div>
  );
}
