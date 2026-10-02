import { ExternalLink, ImageOff, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MediaRef } from '../../../shared/protocol';
import { cachedMedia, loadMedia, whenNear } from '../media';
import { closeViewer, openViewer, useStore, type ViewerImage } from '../store';
import { useFocusTrap } from './common';

const VISIBLE = 4;

/** Loads an image once its element is near the screen. */
function useMediaImage(src: string, ref: RefObject<Element | null>): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>(() => {
    const url = cachedMedia(src);
    return url ? { url } : {};
  });
  const settled = Boolean(state.url || state.error);
  useEffect(() => {
    const el = ref.current;
    if (settled || !el) return;
    let live = true;
    const stop = whenNear(el, () =>
      loadMedia(src).then(
        (url) => live && setState({ url }),
        (err: Error) => live && setState({ error: err.message }),
      ),
    );
    return () => {
      live = false;
      stop();
    };
  }, [src, settled, ref]);
  return state;
}

/** Opens an image in the viewer, loading it again if it has been dropped from memory. */
export function showMedia(src: string, name: string): void {
  const url = cachedMedia(src);
  if (url) openViewer({ src, url, name });
  else loadMedia(src).then((loaded) => openViewer({ src, url: loaded, name }), () => {});
}

function MediaThumb({ media }: { media: MediaRef }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { url, error } = useMediaImage(media.url, ref);
  if (error) {
    return (
      <span className="media-error" title={media.name}>
        <ImageOff size={14} aria-hidden="true" />
        {error}
      </span>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      className={`media-thumb${url ? '' : ' loading'}`}
      aria-label={url ? `Open ${media.name}` : `Loading ${media.name}`}
      title={media.name}
      onClick={() => url && openViewer({ src: media.url, url, name: media.name })}
    >
      {url && <img src={url} alt="" />}
    </button>
  );
}

/** Images an agent pointed at, as thumbnails: a few, then "+N". */
export function MediaStrip({ media }: { media: MediaRef[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? media : media.slice(0, VISIBLE);
  return (
    <div className="media-strip">
      {shown.map((m) => (
        <MediaThumb key={m.url} media={m} />
      ))}
      {shown.length < media.length && (
        <button
          type="button"
          className="media-more"
          aria-label={`Show ${media.length - shown.length} more images`}
          onClick={() => setAll(true)}
        >
          +{media.length - shown.length}
        </button>
      )}
    </div>
  );
}

function Viewer({ image }: { image: ViewerImage }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  useFocusTrap(ref, close);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeViewer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      ref={ref}
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      tabIndex={-1}
      // A tap anywhere but the picture or the buttons closes it.
      onClick={(e) => {
        if (!(e.target as Element).closest('.viewer-image, .viewer-bar a, .viewer-bar button')) closeViewer();
      }}
      // So does a swipe up or down (not while zoomed in: that's panning).
      onTouchStart={(e) => {
        const t = e.touches[0];
        const zoomed = (window.visualViewport?.scale ?? 1) > 1.01;
        swipe.current = e.touches.length === 1 && t && !zoomed ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = swipe.current;
        const t = e.changedTouches[0];
        swipe.current = null;
        if (!start || !t) return;
        const dy = t.clientY - start.y;
        if (Math.abs(dy) > 80 && Math.abs(dy) > Math.abs(t.clientX - start.x) * 1.5) closeViewer();
      }}
    >
      <div className="viewer-bar">
        <span className="viewer-name">{image.name}</span>
        <a className="viewer-action" href={image.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} aria-hidden="true" /> Open
        </a>
        <button ref={close} type="button" className="viewer-close" aria-label="Close" onClick={closeViewer}>
          <X size={22} />
        </button>
      </div>
      <div className="viewer-stage">
        <img className="viewer-image" src={image.url} alt={image.name} />
      </div>
    </div>
  );
}

/** Full-screen view of one image, over everything else. */
export function MediaViewer() {
  const image = useStore((s) => s.viewer);
  return image ? <Viewer key={image.src} image={image} /> : null;
}
