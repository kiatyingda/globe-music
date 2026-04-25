import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { supabase, rowToPost, hoursAgo } from './lib/supabase';

const PALETTE = {
  bg: '#F0EBDF',
  ink: '#0A0A0A',
  mute: '#8C8577',
  hairline: '#CFC8B8',
  accent: '#B0411E',
  inkFade: 'rgba(10, 10, 10, 0.5)',
  bgFade: 'rgba(240, 235, 223, 0.5)',
};

// ---------- iso numeric → alpha-2 (for country flags) ----------
const ISO_NA = ('4=AF,8=AL,12=DZ,16=AS,20=AD,24=AO,28=AG,31=AZ,32=AR,36=AU,40=AT,44=BS,48=BH,50=BD,51=AM,52=BB,56=BE,60=BM,64=BT,68=BO,70=BA,72=BW,76=BR,84=BZ,90=SB,96=BN,100=BG,104=MM,108=BI,112=BY,116=KH,120=CM,124=CA,132=CV,140=CF,144=LK,148=TD,152=CL,156=CN,158=TW,170=CO,174=KM,178=CG,180=CD,188=CR,191=HR,192=CU,196=CY,203=CZ,204=BJ,208=DK,212=DM,214=DO,218=EC,222=SV,226=GQ,231=ET,232=ER,233=EE,242=FJ,246=FI,250=FR,258=PF,260=TF,262=DJ,266=GA,268=GE,270=GM,275=PS,276=DE,288=GH,292=GI,300=GR,304=GL,308=GD,316=GU,320=GT,324=GN,328=GY,332=HT,340=HN,344=HK,348=HU,352=IS,356=IN,360=ID,364=IR,368=IQ,372=IE,376=IL,380=IT,384=CI,388=JM,392=JP,398=KZ,400=JO,404=KE,408=KP,410=KR,414=KW,417=KG,418=LA,422=LB,426=LS,428=LV,430=LR,434=LY,438=LI,440=LT,442=LU,446=MO,450=MG,454=MW,458=MY,462=MV,466=ML,470=MT,478=MR,480=MU,484=MX,492=MC,496=MN,498=MD,499=ME,504=MA,508=MZ,512=OM,516=NA,520=NR,524=NP,528=NL,540=NC,548=VU,554=NZ,558=NI,562=NE,566=NG,578=NO,580=MP,581=UM,583=FM,584=MH,585=PW,586=PK,591=PA,598=PG,600=PY,604=PE,608=PH,616=PL,620=PT,624=GW,626=TL,630=PR,634=QA,638=RE,642=RO,643=RU,646=RW,654=SH,659=KN,662=LC,666=PM,670=VC,674=SM,678=ST,682=SA,686=SN,688=RS,690=SC,694=SL,702=SG,703=SK,704=VN,705=SI,706=SO,710=ZA,716=ZW,724=ES,728=SS,729=SD,732=EH,740=SR,748=SZ,752=SE,756=CH,760=SY,762=TJ,764=TH,768=TG,776=TO,780=TT,784=AE,788=TN,792=TR,795=TM,798=TV,800=UG,804=UA,807=MK,818=EG,826=GB,834=TZ,840=US,854=BF,858=UY,860=UZ,862=VE,882=WS,887=YE,894=ZM').split(',').reduce((acc, p) => { const [k, v] = p.split('='); acc[k] = v; return acc; }, {});

function flagFromA2(a2) {
  if (!a2 || a2.length !== 2) return '';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + a2.charCodeAt(0) - 65) + String.fromCodePoint(A + a2.charCodeAt(1) - 65);
}

// ---------- hash ----------
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h;
}

// ---------- TopoJSON decoder ----------
function topoToGeo(topology, name) {
  const transform = topology.transform;
  const scale = transform ? transform.scale : [1, 1];
  const translate = transform ? transform.translate : [0, 0];

  const arcs = topology.arcs.map((arc) => {
    let x = 0,
      y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });

  function resolveArc(i) {
    if (i < 0) return arcs[~i].slice().reverse();
    return arcs[i].slice();
  }

  function stitch(arcIndices) {
    const out = [];
    for (let i = 0; i < arcIndices.length; i++) {
      const arc = resolveArc(arcIndices[i]);
      if (i > 0) arc.shift();
      for (const pt of arc) out.push(pt);
    }
    return out;
  }

  const object = topology.objects[name];
  const features = object.geometries.map((g) => {
    let coords = null;
    if (g.type === 'Polygon') {
      coords = g.arcs.map((ring) => stitch(ring));
    } else if (g.type === 'MultiPolygon') {
      coords = g.arcs.map((poly) => poly.map((ring) => stitch(ring)));
    } else if (g.type === 'LineString') {
      coords = stitch(g.arcs);
    }
    return {
      type: 'Feature',
      id: g.id,
      geometry: { type: g.type, coordinates: coords },
      properties: g.properties || {},
    };
  });

  return { type: 'FeatureCollection', features };
}

// ---------- cover glyph ----------
function computeGlyph(artist, track) {
  const h = hash(`${artist}|${track}`);
  const inv = (h & 0xff) < 90;
  const bg = inv ? PALETTE.ink : PALETTE.bg;
  const fg = inv ? PALETTE.bg : PALETTE.ink;
  const comp = h % 12;
  const v1 = (h >> 8) & 0xff;
  const v2 = (h >> 16) & 0xff;

  let content = null;

  if (comp === 0) {
    const n = 3 + (v1 % 3);
    content = Array.from({ length: n }, (_, i) => (
      <circle
        key={i}
        cx="24"
        cy="24"
        r={4 + (i * 17) / n}
        fill="none"
        stroke={fg}
        strokeWidth={i === 0 ? 2 : 0.8}
      />
    ));
  } else if (comp === 1) {
    content = (
      <>
        <circle cx="24" cy="24" r="11" fill={fg} />
        <circle cx="24" cy="24" r="19" fill="none" stroke={fg} strokeWidth="0.6" />
      </>
    );
  } else if (comp === 2) {
    const k = v1 % 4;
    content = (
      <>
        <rect x="0" y="0" width="48" height="24" fill={fg} />
        {k === 0 && <circle cx="24" cy="34" r="6" fill={fg} />}
        {k === 1 && <rect x="18" y="30" width="12" height="12" fill={fg} />}
        {k === 2 && <line x1="8" y1="36" x2="40" y2="36" stroke={fg} strokeWidth="1.5" />}
        {k === 3 && <path d="M18 42 L24 30 L30 42 Z" fill={fg} />}
      </>
    );
  } else if (comp === 3) {
    const k = v1 % 3;
    content = (
      <>
        <rect x="0" y="0" width="24" height="48" fill={fg} />
        {k === 0 && <circle cx="36" cy="24" r="7" fill={fg} />}
        {k === 1 && <rect x="30" y="16" width="14" height="16" fill={fg} />}
        {k === 2 && (
          <g>
            {[0, 1, 2].map((i) => (
              <circle key={i} cx="36" cy={14 + i * 10} r="2.2" fill={fg} />
            ))}
          </g>
        )}
      </>
    );
  } else if (comp === 4) {
    content = (
      <>
        <rect x="0" y="0" width="24" height="24" fill={fg} />
        <rect x="24" y="24" width="24" height="24" fill={fg} />
      </>
    );
  } else if (comp === 5) {
    content = <circle cx="24" cy="24" r="15" fill={fg} />;
  } else if (comp === 6) {
    const thickness = 10 + (v1 % 8);
    const y = 8 + (v2 % 22);
    content = <rect x="0" y={y} width="48" height={thickness} fill={fg} />;
  } else if (comp === 7) {
    const n = 3 + (v1 % 3);
    const pad = 10;
    const step = (48 - 2 * pad) / (n - 1);
    const dots = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        dots.push(
          <circle
            key={`${i}-${j}`}
            cx={pad + j * step}
            cy={pad + i * step}
            r="1.8"
            fill={fg}
          />
        );
      }
    }
    content = <>{dots}</>;
  } else if (comp === 8) {
    const angleDeg = [30, 45, 60, 120, 135, 150][v1 % 6];
    const ang = (angleDeg * Math.PI) / 180;
    const len = 40;
    const x1 = 24 - (Math.cos(ang) * len) / 2;
    const y1 = 24 - (Math.sin(ang) * len) / 2;
    const x2 = 24 + (Math.cos(ang) * len) / 2;
    const y2 = 24 + (Math.sin(ang) * len) / 2;
    content = (
      <>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={fg} strokeWidth="2.5" />
        <circle cx="24" cy="24" r="4" fill={fg} />
      </>
    );
  } else if (comp === 9) {
    const side = v1 % 4;
    let d;
    if (side === 0) d = 'M8 24 A16 16 0 0 1 40 24 Z';
    else if (side === 1) d = 'M8 24 A16 16 0 0 0 40 24 Z';
    else if (side === 2) d = 'M24 8 A16 16 0 0 1 24 40 Z';
    else d = 'M24 8 A16 16 0 0 0 24 40 Z';
    content = <path d={d} fill={fg} />;
  } else if (comp === 10) {
    content = (
      <>
        <line x1="0" y1="24" x2="48" y2="24" stroke={fg} strokeWidth="0.8" />
        <line x1="24" y1="0" x2="24" y2="48" stroke={fg} strokeWidth="0.8" />
        <rect x="20" y="20" width="8" height="8" fill={fg} />
      </>
    );
  } else {
    const nBars = 2 + (v1 % 3);
    const gap = 3;
    const availH = 48 - (nBars + 1) * gap;
    const barH = availH / nBars;
    const bars = [];
    for (let i = 0; i < nBars; i++) {
      const inset = (i % 2) * 10;
      bars.push(
        <rect
          key={i}
          x={gap + inset}
          y={gap + i * (barH + gap)}
          width={48 - 2 * gap - inset}
          height={barH}
          fill={fg}
        />
      );
    }
    content = <>{bars}</>;
  }

  return { bg, content };
}

function CoverGlyph({ artist, track, size = 48, className }) {
  const { bg, content } = computeGlyph(artist, track);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      style={{ display: 'block' }}
      className={className}
      shapeRendering="geometricPrecision"
    >
      <rect width="48" height="48" fill={bg} />
      {content}
    </svg>
  );
}

function CoverGlyphInline({ artist, track, x = 0, y = 0, size = 48 }) {
  const { bg, content } = computeGlyph(artist, track);
  const s = size / 48;
  return (
    <g transform={`translate(${x}, ${y}) scale(${s})`} shapeRendering="geometricPrecision">
      <rect width="48" height="48" fill={bg} />
      {content}
    </g>
  );
}

// ---------- posts ----------
// All seed posts live in the Supabase `posts` table (created_at backdated to
// preserve the "hours ago" feel). The frontend fetches them on mount and
// subscribes to realtime changes — see App() below.

// ---------- decrypted text ----------
function DecryptedText({ text, duration = 700 }) {
  const [display, setDisplay] = useState(text);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    const glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./';
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const fixIndex = Math.floor(t * text.length);
      const out = [];
      for (let i = 0; i < text.length; i++) {
        if (i < fixIndex) out.push(text[i]);
        else out.push(glyphs[Math.floor(Math.random() * glyphs.length)]);
      }
      setDisplay(out.join(''));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(text);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration]);

  return <span>{display}</span>;
}

// ---------- split text ----------
function SplitText({ text }) {
  const words = text.split(' ');
  const stagger = words.length > 1 ? Math.min(35, (600 - 180) / (words.length - 1)) : 0;
  return (
    <span className="split-container">
      {words.map((w, i) => (
        <span
          key={i}
          className="split-word"
          style={{ animationDelay: `${Math.round(i * stagger)}ms` }}
        >
          {w}
          {i < words.length - 1 ? '\u00A0' : ''}
        </span>
      ))}
    </span>
  );
}

// ---------- noise ----------
function Noise() {
  return (
    <svg className="noise" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <filter id="noise-filter">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix
          type="matrix"
          values="0 0 0 0 0.039  0 0 0 0 0.039  0 0 0 0 0.039  0 0 0 0.55 0"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#noise-filter)" />
    </svg>
  );
}

// ---------- service link helper ----------
function serviceFromLink(link) {
  const s = (link || '').toLowerCase();
  if (s.includes('spotify.com')) return 'SPOTIFY';
  if (s.includes('music.apple')) return 'APPLE MUSIC';
  if (s.includes('youtube') || s.includes('youtu.be')) return 'YOUTUBE';
  if (s.includes('soundcloud')) return 'SOUNDCLOUD';
  if (s.includes('bandcamp')) return 'BANDCAMP';
  return 'SPOTIFY';
}

function videoIdFromLink(link) {
  if (!link) return '';
  try {
    const u = new URL(link.trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      return u.pathname.slice(1).split('/')[0] || '';
    }
    if (host.endsWith('youtube.com') || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
        return parts[1] || '';
      }
    }
  } catch (e) {
    // not a parseable URL
  }
  return '';
}

function playUrlFor(post) {
  if (post.link) return post.link;
  const q = encodeURIComponent(`${post.artistName} ${post.trackName}`.trim());
  switch (post.service) {
    case 'APPLE MUSIC': return `https://music.apple.com/search?term=${q}`;
    case 'YOUTUBE': return `https://www.youtube.com/results?search_query=${q}`;
    case 'SOUNDCLOUD': return `https://soundcloud.com/search?q=${q}`;
    case 'BANDCAMP': return `https://bandcamp.com/search?q=${q}`;
    case 'SPOTIFY':
    default: return `https://open.spotify.com/search/${q}`;
  }
}

function formatHrs(hrs) {
  if (hrs === 0) return 'JUST NOW';
  if (hrs < 1) return `${Math.max(1, Math.round(hrs * 60))}M AGO`;
  if (hrs < 24) return `${Math.round(hrs)}H AGO`;
  return `${Math.round(hrs / 24)}D AGO`;
}

// ---------- globe ----------
function Globe({ posts, onPick }) {
  const SIZE = 640;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R0 = 185;
  const ZOOM_MIN = 0.7;
  const ZOOM_MAX = 3.0;
  const ZOOM_STEP = 0.22;

  const rotRef = useRef([30, -12, 0]);
  const autoRef = useRef(true);
  const lastInteractRef = useRef(0);
  const [, bump] = useState(0);
  const [countries, setCountries] = useState(null);
  const [offline, setOffline] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [hoveredCountry, setHoveredCountry] = useState(null);
  const [zoom, setZoom] = useState(1);
  const svgRef = useRef(null);
  const pointersRef = useRef(new Map()); // pointerId -> {x,y}
  const pinchRef = useRef(null); // {startDist, startZoom}

  const R = R0 * zoom;
  const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const markInteract = () => {
    autoRef.current = false;
    lastInteractRef.current = performance.now();
  };

  const graticule = useMemo(() => d3.geoGraticule10(), []);
  const projection = useMemo(
    () =>
      d3
        .geoOrthographic()
        .translate([CX, CY])
        .scale(R)
        .clipAngle(90),
    [CX, CY, R]
  );

  useEffect(() => {
    let cancelled = false;
    const urls = [
      'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
      'https://unpkg.com/world-atlas@2/countries-110m.json',
    ];
    (async () => {
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const topo = await res.json();
          if (cancelled) return;
          const geo = topoToGeo(topo, 'countries');
          setCountries(geo);
          return;
        } catch (e) {
          // try next
        }
      }
      if (!cancelled) setOffline(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let raf;
    let last = performance.now();
    const tick = (now) => {
      const dt = now - last;
      last = now;
      if (autoRef.current) {
        rotRef.current[0] = (rotRef.current[0] + 0.008 * dt) % 360;
      } else if (now - lastInteractRef.current > 2500) {
        autoRef.current = true;
      }
      bump((v) => (v + 1) & 0xffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const drag = useRef({ active: false, captured: false, downX: 0, downY: 0, start: null, moved: 0 });

  const onPointerDown = useCallback((e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      // begin pinch
      const pts = Array.from(pointersRef.current.values());
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      pinchRef.current = { startDist: Math.hypot(dx, dy), startZoom: zoom };
      drag.current.active = false;
      drag.current.captured = false;
      markInteract();
      return;
    }
    drag.current.active = true;
    drag.current.captured = false;
    drag.current.downX = e.clientX;
    drag.current.downY = e.clientY;
    drag.current.start = [...rotRef.current];
    drag.current.moved = 0;
    autoRef.current = false;
    setHoveredCountry(null);
    setHovered(null);
  }, [zoom]);

  const onPointerMove = useCallback((e) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinchRef.current && pointersRef.current.size >= 2) {
      const pts = Array.from(pointersRef.current.values()).slice(0, 2);
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy);
      const factor = dist / pinchRef.current.startDist;
      setZoom(clampZoom(pinchRef.current.startZoom * factor));
      lastInteractRef.current = performance.now();
      return;
    }
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.downX;
    const dy = e.clientY - drag.current.downY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > drag.current.moved) drag.current.moved = dist;
    if (!drag.current.captured && dist > 3) {
      drag.current.captured = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    if (!drag.current.captured) return;
    const rectW = e.currentTarget.getBoundingClientRect().width;
    // sensitivity scales inversely with zoom — at higher zoom, smaller drags feel right
    const sens = (360 / rectW) / Math.max(0.6, zoom);
    rotRef.current[0] = drag.current.start[0] + dx * sens;
    rotRef.current[1] = Math.max(-85, Math.min(85, drag.current.start[1] - dy * sens));
  }, [zoom]);

  const onPointerUp = useCallback((e) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2 && pinchRef.current) {
      pinchRef.current = null;
      lastInteractRef.current = performance.now();
    }
    const wasDragging = drag.current.captured;
    drag.current.active = false;
    drag.current.captured = false;
    if (wasDragging) {
      lastInteractRef.current = performance.now();
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch (_) {}
    } else {
      lastInteractRef.current = performance.now();
    }
  }, []);

  // wheel zoom — non-passive so we can preventDefault and not scroll the page
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      // normalize delta across browsers/trackpads
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-dy * 0.0018);
      setZoom((z) => clampZoom(z * factor));
      markInteract();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // keyboard shortcuts: +/= zoom in, - zoom out, 0 reset
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setZoom((z) => clampZoom(z + ZOOM_STEP));
        markInteract();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setZoom((z) => clampZoom(z - ZOOM_STEP));
        markInteract();
      } else if (e.key === '0') {
        e.preventDefault();
        setZoom(1);
        markInteract();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const zoomIn = () => { setZoom((z) => clampZoom(z + ZOOM_STEP)); markInteract(); };
  const zoomOut = () => { setZoom((z) => clampZoom(z - ZOOM_STEP)); markInteract(); };
  const zoomReset = () => { setZoom(1); markInteract(); };

  projection.rotate(rotRef.current);
  const pathGen = d3.geoPath(projection);
  const center = [-rotRef.current[0], -rotRef.current[1]];

  return (
    <div className="globe-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
        style={{ touchAction: 'none' }}
      >
        {/* whirl rings — anchored to baseline radius so they don't blow out at high zoom */}
        <g style={{ transformOrigin: `${CX}px ${CY}px` }} className="ring ring-1">
          <circle
            cx={CX}
            cy={CY}
            r={R0 + 20}
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth="0.6"
            strokeDasharray="1 14"
            strokeOpacity="0.5"
          />
        </g>
        <g style={{ transformOrigin: `${CX}px ${CY}px` }} className="ring ring-2">
          <circle
            cx={CX}
            cy={CY}
            r={R0 + 42}
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth="0.6"
            strokeDasharray="8 6"
            strokeOpacity="0.4"
          />
        </g>
        <g style={{ transformOrigin: `${CX}px ${CY}px` }} className="ring ring-3">
          <circle
            cx={CX}
            cy={CY}
            r={R0 + 64}
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth="0.5"
            strokeDasharray="2 22"
            strokeOpacity="0.4"
          />
        </g>
        <g style={{ transformOrigin: `${CX}px ${CY}px` }} className="ring ring-4">
          <circle
            cx={CX}
            cy={CY}
            r={R0 + 90}
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth="0.5"
            strokeDasharray="1 60"
            strokeOpacity="0.35"
          />
        </g>

        {/* corner ticks */}
        {(() => {
          const TR = R0 + 90;
          const TL = 12;
          return (
            <g stroke={PALETTE.ink} strokeWidth="0.8">
              <line x1={CX} y1={CY - TR - 4} x2={CX} y2={CY - TR - 4 - TL} />
              <line x1={CX} y1={CY + TR + 4} x2={CX} y2={CY + TR + 4 + TL} />
              <line x1={CX - TR - 4} y1={CY} x2={CX - TR - 4 - TL} y2={CY} />
              <line x1={CX + TR + 4} y1={CY} x2={CX + TR + 4 + TL} y2={CY} />
            </g>
          );
        })()}

        {/* globe disc */}
        <circle cx={CX} cy={CY} r={R} fill={PALETTE.bg} stroke={PALETTE.ink} strokeWidth="0.8" />

        {/* graticule */}
        <path
          d={pathGen(graticule)}
          fill="none"
          stroke={PALETTE.ink}
          strokeOpacity="0.08"
          strokeWidth="0.5"
        />

        {/* countries */}
        {countries && countries.features.map((feat, i) => {
          const d = pathGen(feat);
          if (!d) return null;
          const isHov = hoveredCountry && hoveredCountry.id === feat.id;
          return (
            <path
              key={feat.id ?? i}
              d={d}
              fill={isHov ? PALETTE.ink : 'transparent'}
              fillOpacity={isHov ? 0.06 : 1}
              stroke={PALETTE.ink}
              strokeWidth={isHov ? 0.8 : 0.5}
              strokeLinejoin="round"
              onPointerEnter={() => {
                if (drag.current.captured) return;
                setHoveredCountry(feat);
              }}
              onPointerLeave={() =>
                setHoveredCountry((h) => (h && h.id === feat.id ? null : h))
              }
              style={{ cursor: 'default' }}
            />
          );
        })}

        {/* posts */}
        {posts.map((p) => {
          const coord = [p.lng, p.lat];
          const dist = d3.geoDistance(coord, center);
          if (dist > Math.PI / 2 - 0.04) return null;
          const xy = projection(coord);
          if (!xy || Number.isNaN(xy[0])) return null;
          const [x, y] = xy;
          const live = p.hrs < 1 || p.own;
          const accent = PALETTE.accent;
          const depth = 1 - dist / (Math.PI / 2);
          const opacity = 0.55 + 0.45 * depth;
          const sz = p.own ? 10 : 8;
          return (
            <g
              key={p.id}
              transform={`translate(${x}, ${y})`}
              opacity={opacity}
              onClick={(e) => {
                if (drag.current.moved > 3) return;
                e.stopPropagation();
                onPick(p);
              }}
              onPointerEnter={() => setHovered(p)}
              onPointerLeave={() => setHovered((h) => (h && h.id === p.id ? null : h))}
              style={{ cursor: 'pointer' }}
            >
              <circle r={12} fill="transparent" />
              {p.own && (
                <rect
                  x={-sz / 2 - 2}
                  y={-sz / 2 - 2}
                  width={sz + 4}
                  height={sz + 4}
                  fill="none"
                  stroke={accent}
                  strokeWidth="0.8"
                />
              )}
              <CoverGlyphInline artist={p.artistName} track={p.trackName} x={-sz / 2} y={-sz / 2} size={sz} />
              {live && (
                <circle
                  className="pulse-ring"
                  cx="0"
                  cy="0"
                  fill="none"
                  stroke={accent}
                  strokeWidth="1"
                />
              )}
            </g>
          );
        })}

        {/* hover tooltip */}
        {hovered && (() => {
          const dist = d3.geoDistance([hovered.lng, hovered.lat], center);
          if (dist > Math.PI / 2 - 0.04) return null;
          const xy = projection([hovered.lng, hovered.lat]);
          if (!xy || Number.isNaN(xy[0])) return null;
          const [hx, hy] = xy;
          const track = hovered.trackName || '—';
          const artist = hovered.artistName || '';
          const meta = `${hovered.city} / ${hovered.hood}`;
          const maxLen = Math.max(track.length, artist.length, meta.length);
          const w = Math.min(220, Math.max(90, 12 + maxLen * 6));
          // flip tooltip to left if near right edge
          const flip = hx + w + 20 > SIZE;
          const tx = flip ? hx - w - 12 : hx + 12;
          const ty = hy - 36;
          return (
            <g transform={`translate(${tx}, ${ty})`} style={{ pointerEvents: 'none' }}>
              <rect x="0" y="0" width={w} height="44" fill={PALETTE.bg} stroke={PALETTE.ink} strokeWidth="0.6" />
              <text x="8" y="14" fontSize="10" fontFamily="'IBM Plex Sans'" fontWeight="400" fill={PALETTE.ink}>
                {track.length > 34 ? track.slice(0, 33) + '…' : track}
              </text>
              <text x="8" y="26" fontSize="9" fontFamily="'IBM Plex Sans'" fontWeight="300" fill={PALETTE.mute}>
                {artist.length > 34 ? artist.slice(0, 33) + '…' : artist}
              </text>
              <text x="8" y="38" fontSize="8" fontFamily="'IBM Plex Mono'" letterSpacing="0.6" fill={PALETTE.mute}>
                {meta}
              </text>
            </g>
          );
        })()}

        {/* country hover tooltip */}
        {hoveredCountry && (() => {
          const centroid = d3.geoCentroid(hoveredCountry);
          const dist = d3.geoDistance(centroid, center);
          if (dist > Math.PI / 2 - 0.04) return null;
          const xy = projection(centroid);
          if (!xy || Number.isNaN(xy[0])) return null;
          const [cx, cy] = xy;
          const name = (hoveredCountry.properties?.name || '').toUpperCase();
          if (!name) return null;
          const idStr = String(hoveredCountry.id ?? '');
          const a2 = ISO_NA[idStr] || ISO_NA[String(parseInt(idStr, 10))];
          const flag = flagFromA2(a2);
          const w = Math.min(220, Math.max(60, name.length * 6.2 + (flag ? 30 : 14)));
          const flip = cx + w + 14 > SIZE;
          const tx = flip ? cx - w - 10 : cx + 10;
          const ty = cy - 12;
          return (
            <g transform={`translate(${tx}, ${ty})`} style={{ pointerEvents: 'none' }}>
              <rect x="0" y="0" width={w} height="22" fill={PALETTE.bg} stroke={PALETTE.ink} strokeWidth="0.6" />
              {flag && (
                <foreignObject x="6" y="3" width="20" height="18">
                  <div
                    xmlns="http://www.w3.org/1999/xhtml"
                    style={{ fontSize: '13px', lineHeight: 1, fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif' }}
                  >
                    {flag}
                  </div>
                </foreignObject>
              )}
              <text
                x={flag ? 28 : 8}
                y="14"
                fontSize="9"
                fontFamily="'IBM Plex Mono'"
                letterSpacing="1"
                fill={PALETTE.ink}
              >
                {name.length > 28 ? name.slice(0, 27) + '…' : name}
              </text>
            </g>
          );
        })()}

        {offline && (
          <text
            x={CX}
            y={CY}
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily="IBM Plex Mono"
            fontSize="11"
            letterSpacing="2"
            fill={PALETTE.mute}
          >
            [ OFFLINE — OUTLINES UNAVAILABLE ]
          </text>
        )}
      </svg>
      <div className="zoom-rail" aria-label="Zoom controls">
        <button
          type="button"
          className="zoom-btn"
          onClick={zoomIn}
          disabled={zoom >= ZOOM_MAX - 0.001}
          title="Zoom in (+)"
          aria-label="Zoom in"
        >+</button>
        <button
          type="button"
          className="zoom-readout"
          onClick={zoomReset}
          title="Reset zoom (0)"
          aria-label="Reset zoom"
        >× {zoom.toFixed(zoom < 1 ? 2 : 1)}</button>
        <button
          type="button"
          className="zoom-btn"
          onClick={zoomOut}
          disabled={zoom <= ZOOM_MIN + 0.001}
          title="Zoom out (−)"
          aria-label="Zoom out"
        >−</button>
      </div>
    </div>
  );
}

// ---------- neighborhood ----------
function Hood({ post, onBack, onEdit, onDelete }) {
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    setIsPlaying(false);
  }, [post.id]);

  // seed from post id for reproducibility
  const seed = useMemo(() => {
    let s = 0;
    const str = String(post.id);
    for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
    return s;
  }, [post.id]);

  const neighbors = useMemo(() => {
    const out = [];
    let s = seed;
    const next = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
    const n = 6 + Math.floor(next() * 3);
    for (let i = 0; i < n; i++) {
      const r = 40 + next() * 180;
      const a = next() * Math.PI * 2;
      out.push({ x: 200 + Math.cos(a) * r, y: 200 + Math.sin(a) * r });
    }
    return out;
  }, [seed]);

  const live = post.hrs < 1 || post.own;

  const fmtLat = `${Math.abs(post.lat).toFixed(3)}°${post.lat >= 0 ? 'N' : 'S'}`;
  const fmtLng = `${Math.abs(post.lng).toFixed(3)}°${post.lng >= 0 ? 'E' : 'W'}`;

  return (
    <div className="hood">
      <div className="hood-canvas">
        <svg viewBox="0 0 400 400">
          {/* grid 24x24 */}
          <g stroke={PALETTE.hairline} strokeOpacity="0.6" strokeWidth="0.4">
            {Array.from({ length: 25 }).map((_, i) => (
              <line key={`v${i}`} x1={(i * 400) / 24} y1="0" x2={(i * 400) / 24} y2="400" />
            ))}
            {Array.from({ length: 25 }).map((_, i) => (
              <line key={`h${i}`} x1="0" y1={(i * 400) / 24} x2="400" y2={(i * 400) / 24} />
            ))}
          </g>
          {/* contour rings */}
          {[40, 75, 115, 160, 210, 265].map((r, i) => (
            <circle
              key={r}
              cx="200"
              cy="200"
              r={r}
              fill="none"
              stroke={PALETTE.ink}
              strokeWidth="0.5"
              strokeOpacity={0.6 - i * 0.08}
            />
          ))}
          {/* neighbor dots */}
          {neighbors.map((n, i) => (
            <rect
              key={i}
              x={n.x - 1.5}
              y={n.y - 1.5}
              width="3"
              height="3"
              fill={PALETTE.ink}
              fillOpacity="0.3"
            />
          ))}
          {/* corner L-brackets */}
          <g stroke={PALETTE.ink} strokeWidth="1" fill="none">
            <path d="M20 8 L8 8 L8 20" />
            <path d="M380 8 L392 8 L392 20" />
            <path d="M20 392 L8 392 L8 380" />
            <path d="M380 392 L392 392 L392 380" />
          </g>
          {/* center orbit rings */}
          <circle cx="200" cy="200" r="70" fill="none" stroke={PALETTE.ink} strokeWidth="0.4" strokeOpacity="0.18" strokeDasharray="2 4" />
          <circle cx="200" cy="200" r="96" fill="none" stroke={PALETTE.ink} strokeWidth="0.4" strokeOpacity="0.12" strokeDasharray="1 6" />
          {/* pulse ring */}
          <circle
            className="hood-pulse"
            cx="200"
            cy="200"
            fill="none"
            stroke={live ? PALETTE.accent : PALETTE.ink}
            strokeWidth="1"
          />
          {/* center glyph */}
          <CoverGlyphInline artist={post.artistName} track={post.trackName} x={170} y={170} size={60} />
          {/* cross ticks around the cover */}
          <g stroke={PALETTE.ink} strokeWidth="0.6">
            <line x1="200" y1="154" x2="200" y2="148" />
            <line x1="200" y1="252" x2="200" y2="246" />
            <line x1="154" y1="200" x2="148" y2="200" />
            <line x1="252" y1="200" x2="246" y2="200" />
          </g>
          {/* label */}
          <text
            x="14"
            y="384"
            fontFamily="IBM Plex Mono"
            fontSize="9"
            fill={PALETTE.mute}
            letterSpacing="1.2"
          >
            {`${fmtLat} / ${fmtLng} · ${post.city} / ${post.hood}`}
          </text>
        </svg>
      </div>

      <div className="post-card">
        <div className="now-playing">
          <span className="now-playing-label">
            [ NOW PLAYING ]
            {isPlaying && post.videoId && (
              <span className="eq" aria-hidden="true">
                <span /><span /><span /><span /><span />
              </span>
            )}
          </span>
          <span>{formatHrs(post.hrs)}</span>
        </div>
        <div className={`post-glyph${isPlaying && post.videoId ? ' is-playing' : ''}`}>
          {isPlaying && post.videoId ? (
            <>
              <svg viewBox="0 0 200 200" className="vinyl" shapeRendering="geometricPrecision">
                {/* vinyl disc */}
                <circle cx="100" cy="100" r="99" fill={PALETTE.ink} />
                {/* outer rim highlight */}
                <circle cx="100" cy="100" r="98.5" fill="none" stroke={PALETTE.bg} strokeOpacity="0.2" strokeWidth="0.5" />
                {/* grooves — fine */}
                {Array.from({ length: 22 }, (_, i) => 38 + i * 2.7).map((r, i) => (
                  <circle
                    key={`g${i}`}
                    cx="100"
                    cy="100"
                    r={r}
                    fill="none"
                    stroke={PALETTE.bg}
                    strokeOpacity={0.04 + (i % 4 === 0 ? 0.06 : 0)}
                    strokeWidth="0.4"
                  />
                ))}
                {/* light reflection arc */}
                <path
                  d="M 30 100 A 70 70 0 0 1 100 30"
                  fill="none"
                  stroke={PALETTE.bg}
                  strokeOpacity="0.1"
                  strokeWidth="14"
                  strokeLinecap="round"
                />
                {/* label */}
                <circle cx="100" cy="100" r="34" fill={PALETTE.accent} />
                <circle cx="100" cy="100" r="34" fill="none" stroke={PALETTE.bg} strokeOpacity="0.25" strokeWidth="0.6" />
                <text
                  x="100"
                  y="89"
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono"
                  fontSize="6"
                  fontWeight="500"
                  fill={PALETTE.bg}
                  letterSpacing="0.6"
                >
                  {(post.trackName || '').toUpperCase().slice(0, 18)}
                </text>
                <text
                  x="100"
                  y="100"
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono"
                  fontSize="5"
                  fill={PALETTE.bg}
                  fillOpacity="0.75"
                  letterSpacing="0.5"
                >
                  {(post.artistName || '').toUpperCase().slice(0, 22)}
                </text>
                <text
                  x="100"
                  y="115"
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono"
                  fontSize="4.5"
                  fill={PALETTE.bg}
                  fillOpacity="0.55"
                  letterSpacing="0.6"
                >
                  GLOBE · {post.city}
                </text>
                {/* spindle hole */}
                <circle cx="100" cy="100" r="2.4" fill={PALETTE.bg} />
              </svg>
              <iframe
                className="hidden-embed"
                src={`https://www.youtube.com/embed/${post.videoId}?autoplay=1&rel=0&modestbranding=1&controls=0`}
                title={`${post.trackName} — ${post.artistName}`}
                allow="autoplay; encrypted-media"
                aria-hidden="true"
              />
            </>
          ) : (
            <CoverGlyph artist={post.artistName} track={post.trackName} size={200} />
          )}
        </div>
        <h1 className="post-track">{post.trackName}</h1>
        <p className="post-artist">{post.artistName}</p>
        <div className="post-handle">
          {post.handle} · {post.city} / {post.hood}
        </div>
        <p className="post-vibe" key={post.id}>
          <SplitText text={post.vibeNote} />
        </p>
        <button
          className="btn play-btn"
          type="button"
          onClick={() => {
            if (isPlaying) {
              setIsPlaying(false);
              return;
            }
            if (post.videoId) {
              setIsPlaying(true);
            } else {
              window.open(playUrlFor(post), '_blank', 'noopener,noreferrer');
            }
          }}
        >
          {isPlaying ? '[ STOP ]' : `[ PLAY ON ${post.service} ]`}
        </button>
        {(onEdit || onDelete) && (
          <div className="post-owner-actions">
            {onEdit && (
              <button className="btn btn-ghost" type="button" onClick={onEdit}>
                [ EDIT ]
              </button>
            )}
            {onDelete && (
              <button
                className="btn btn-ghost btn-danger"
                type="button"
                onClick={() => {
                  if (typeof window !== 'undefined' && !window.confirm('DELETE THIS POST?')) return;
                  onDelete();
                }}
              >
                [ DELETE ]
              </button>
            )}
          </div>
        )}
        <button className="back-link" type="button" onClick={onBack}>
          ← BACK TO GLOBE
        </button>
      </div>
    </div>
  );
}

// ---------- compose modal ----------
function Compose({ onClose, onSubmit, initial, onDelete }) {
  const isEdit = !!initial;
  const [link, setLink] = useState(initial?.link || '');
  const [track, setTrack] = useState(initial?.trackName || '');
  const [artist, setArtist] = useState(initial?.artistName || '');
  const [vibe, setVibe] = useState(initial?.vibeNote || '');

  const service = serviceFromLink(link) || (isEdit ? initial.service : '');
  const showPreview = link.trim().length > 0;
  const canPost = link.trim().length > 0;

  const submit = () => {
    if (!canPost) return;
    onSubmit({
      link: link.trim(),
      track: track.trim(),
      artist: artist.trim(),
      vibe: vibe.trim(),
      service,
    });
  };

  const remove = () => {
    if (!isEdit || !onDelete) return;
    if (typeof window !== 'undefined' && !window.confirm('DELETE THIS POST?')) return;
    onDelete(initial);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{isEdit ? '[ EDIT POST ]' : '[ NEW POST ]'}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-row">
          PINNED TO · {isEdit ? `${initial.hood}, ${initial.city}` : 'SENGKANG, SINGAPORE'}
        </div>
        <div className="modal-row mute">LOCATION FUZZED TO ~500M GRID</div>

        <input
          className="modal-input"
          placeholder="PASTE SPOTIFY / APPLE MUSIC / YOUTUBE LINK"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <div className="modal-meta">LINK METADATA WILL BE RESOLVED VIA OEMBED — V1</div>

        <div className="modal-preview">
          <div className="modal-preview-glyph">
            {showPreview ? (
              <CoverGlyph artist={artist || 'unknown'} track={track || link} size={120} />
            ) : (
              <div className="glyph-placeholder">[ COVER ]</div>
            )}
          </div>
          <div className="modal-preview-inputs">
            <input
              className="modal-input"
              placeholder="TRACK NAME"
              value={track}
              onChange={(e) => setTrack(e.target.value)}
            />
            <input
              className="modal-input"
              placeholder="ARTIST"
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
            />
          </div>
        </div>

        <textarea
          className="modal-textarea"
          placeholder="ONE LINE. WHAT DOES THIS SOUND LIKE HERE, RIGHT NOW?"
          maxLength={80}
          value={vibe}
          onChange={(e) => setVibe(e.target.value)}
        />

        <div className="modal-footer">
          <span className="char-count">{80 - vibe.length} / 80</span>
          <div className="modal-actions">
            {isEdit && (
              <button className="btn btn-ghost btn-danger" onClick={remove} type="button">
                [ DELETE ]
              </button>
            )}
            <button className="btn btn-ghost" onClick={onClose} type="button">
              [ CANCEL ]
            </button>
            <button className="btn" onClick={submit} disabled={!canPost} type="button">
              {isEdit ? '[ SAVE ]' : '[ POST ]'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- header ----------
function Header({ total, live, mine, onMine, onSearch, searchActive }) {
  const t = String(total).padStart(3, '0');
  const l = String(live).padStart(2, '0');
  const m = String(mine).padStart(2, '0');
  return (
    <header className="header">
      <div className="header-left">
        <span className="wordmark">
          <span className="bracket">[ </span>
          <DecryptedText text="GLOBE" />
          <span className="bracket"> ]</span>
        </span>
        <span className="sub">— UNNAMED · V0</span>
      </div>
      <div className="counter">
        <span>
          {t} PLAYS · {l} LIVE
        </span>
        {live > 0 && <span className="live-dot" />}
        <button
          type="button"
          className={`chip chip-search${searchActive ? ' is-filtered' : ''}`}
          onClick={onSearch}
          title="SEARCH ALL POSTS · /"
        >
          SEARCH
          {searchActive && <span className="chip-pip" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={`chip${mine === 0 ? ' chip-empty' : ''}`}
          onClick={onMine}
          title={mine > 0 ? 'JUMP TO YOUR POSTS' : 'POST SOMETHING'}
        >
          {m} YOURS
        </button>
      </div>
    </header>
  );
}

// ---------- search bar ----------
// ---------- search modal (full-screen index) ----------
function SearchModal({ posts, onClose, onPick, query, onQuery, serviceFilter, onServiceFilter, liveOnly, onLiveOnly, onClear }) {
  const services = ['ALL', 'SPOTIFY', 'APPLE MUSIC', 'YOUTUBE'];
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [highlight, setHighlight] = useState(0);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = posts.filter((p) => {
      if (serviceFilter !== 'ALL' && p.service !== serviceFilter) return false;
      if (liveOnly && !(p.hrs < 1 || p.own)) return false;
      if (!q) return true;
      return (
        (p.trackName || '').toLowerCase().includes(q) ||
        (p.artistName || '').toLowerCase().includes(q) ||
        (p.city || '').toLowerCase().includes(q) ||
        (p.hood || '').toLowerCase().includes(q) ||
        (p.handle || '').toLowerCase().includes(q) ||
        (p.vibeNote || '').toLowerCase().includes(q)
      );
    });
    out.sort((a, b) => (a.hrs || 0) - (b.hrs || 0));
    return out;
  }, [posts, query, serviceFilter, liveOnly]);

  const filterActive = query.trim().length > 0 || serviceFilter !== 'ALL' || liveOnly;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setHighlight(0);
  }, [query, serviceFilter, liveOnly]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, matched.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter' && matched[highlight]) {
        e.preventDefault();
        onPick(matched[highlight]);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [matched, highlight, onClose, onPick]);

  // scroll highlighted into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-i="${highlight}"]`);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight]);

  return (
    <div className="search-modal" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <span className="search-corner search-corner-tl" aria-hidden="true" />
        <span className="search-corner search-corner-tr" aria-hidden="true" />
        <span className="search-corner search-corner-bl" aria-hidden="true" />
        <span className="search-corner search-corner-br" aria-hidden="true" />

        <div className="search-head">
          <span className="search-title">[ SEARCH · INDEX ]</span>
          <button className="search-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="search-input-wrap">
          <span className="search-prompt" aria-hidden="true">›</span>
          <input
            ref={inputRef}
            className="search-big-input"
            placeholder="track, artist, city…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Search"
          />
          <span className="search-caret" aria-hidden="true" />
        </div>

        <div className="search-filters">
          <span className="search-filters-label">FILTER</span>
          {services.map((s) => (
            <button
              key={s}
              type="button"
              className={`filter-chip${serviceFilter === s ? ' is-active' : ''}`}
              onClick={() => onServiceFilter(s)}
            >
              {s}
            </button>
          ))}
          <span className="filter-divider" />
          <button
            type="button"
            className={`filter-chip${liveOnly ? ' is-active' : ''}`}
            onClick={() => onLiveOnly(!liveOnly)}
          >
            LIVE ONLY
          </button>
        </div>

        <div className="search-count-row">
          <span>
            MATCHING
            <span className="search-count-num">{String(matched.length).padStart(3, '0')}</span>
            / {String(posts.length).padStart(3, '0')}
          </span>
          {filterActive && (
            <button type="button" className="search-clear" onClick={onClear}>
              [ CLEAR ]
            </button>
          )}
        </div>

        <div className="search-results" ref={listRef}>
          {matched.length === 0 ? (
            <div className="search-empty">
              <p className="search-empty-line">─── NO MATCHES ───</p>
              <p className="search-empty-hint">TRY A DIFFERENT WORD · OR CLEAR FILTERS</p>
            </div>
          ) : (
            <ul className="search-list">
              {matched.map((p, i) => (
                <li
                  key={p.id}
                  data-i={i}
                  style={{ '--i': Math.min(i, 24) }}
                  className={`search-result${i === highlight ? ' is-highlight' : ''}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => onPick(p)}
                >
                  <span className="result-index">{String(i + 1).padStart(3, '0')}</span>
                  <span className="result-glyph">
                    <svg viewBox="0 0 48 48" width="40" height="40">
                      <CoverGlyphInline artist={p.artistName} track={p.trackName} size={48} />
                    </svg>
                  </span>
                  <span className="result-text">
                    <span className="result-track">{p.trackName}</span>
                    <span className="result-artist">{p.artistName}</span>
                  </span>
                  <span className="result-meta">
                    <span className="result-loc">{p.city} / {p.hood}</span>
                    <span className="result-svc">
                      {p.service} · {formatHrs(p.hrs)}
                      {(p.hrs < 1 || p.own) && <span className="result-live-dot" />}
                    </span>
                  </span>
                  <span className="result-arrow" aria-hidden="true">→</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="search-footer">
          <span className="search-foot-item"><kbd>↑↓</kbd> NAVIGATE</span>
          <span className="search-foot-item"><kbd>↵</kbd> LISTEN</span>
          <span className="search-foot-item"><kbd>ESC</kbd> CLOSE</span>
        </div>
      </div>
    </div>
  );
}

// ---------- mine list view ----------
function MineView({ posts, onBack, onPick, onEdit, onDelete, onCompose }) {
  return (
    <div className="mine">
      <div className="mine-head">
        <span className="mine-title">[ MY POSTS · {String(posts.length).padStart(2, '0')} ]</span>
        <button className="back-link" type="button" onClick={onBack}>
          ← BACK TO GLOBE
        </button>
      </div>
      {posts.length === 0 ? (
        <div className="mine-empty">
          <p>NO POSTS YET.</p>
          <button className="btn" type="button" onClick={onCompose}>
            {'[ + SHARE WHAT YOU\u2019RE PLAYING ]'}
          </button>
        </div>
      ) : (
        <ul className="mine-list">
          {posts.map((p) => (
            <li key={p.id} className="mine-row">
              <button
                className="mine-row-main"
                type="button"
                onClick={() => onPick(p)}
                title="LISTEN"
              >
                <span className="mine-glyph">
                  <svg viewBox="0 0 48 48" width="44" height="44">
                    <CoverGlyphInline artist={p.artistName} track={p.trackName} size={48} />
                  </svg>
                </span>
                <span className="mine-text">
                  <span className="mine-track">{p.trackName}</span>
                  <span className="mine-artist">{p.artistName}</span>
                  <span className="mine-loc">
                    {p.city} / {p.hood} · {p.service} · {formatHrs(p.hrs)}
                  </span>
                </span>
              </button>
              <div className="mine-actions">
                <button type="button" className="btn btn-ghost" onClick={() => onEdit(p)}>
                  [ EDIT ]
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-danger"
                  onClick={() => {
                    if (typeof window !== 'undefined' && !window.confirm('DELETE THIS POST?')) return;
                    onDelete(p);
                  }}
                >
                  [ DELETE ]
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- footer ----------
function Footer({ view, onCompose }) {
  const hint =
    view === 'globe'
      ? 'DRAG TO ROTATE · TAP A DOT TO HEAR WHAT\u2019S PLAYING'
      : view === 'mine'
      ? 'YOUR POSTS · TAP TO LISTEN · EDIT OR DELETE ANY ROW'
      : 'ONE TRACK IN THIS NEIGHBOURHOOD · MORE NEARBY';
  return (
    <footer className="footer">
      <span>{hint}</span>
      <button className="btn" onClick={onCompose}>
        {'[ + SHARE WHAT YOU\u2019RE PLAYING ]'}
      </button>
    </footer>
  );
}

// ---------- root ----------
export default function App() {
  const [view, setView] = useState('globe');
  const [selected, setSelected] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [rows, setRows] = useState([]); // raw Supabase rows (snake_case)
  const [userId, setUserId] = useState(null);
  // eslint-disable-next-line no-unused-vars
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [serviceFilter, setServiceFilter] = useState('ALL');
  const [liveOnly, setLiveOnly] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // ---- Supabase: anonymous auth + initial fetch + realtime subscription -----
  useEffect(() => {
    let mounted = true;
    let channel = null;

    (async () => {
      // 1. Sign in anonymously (or restore an existing session). The user_id is
      //    used for posts.owner_id so other devices can't edit/delete this
      //    device's posts.
      try {
        const { data: { session } } = await supabase.auth.getSession();
        let user = session?.user ?? null;
        if (!user) {
          const { data, error } = await supabase.auth.signInAnonymously();
          if (error) {
            // eslint-disable-next-line no-console
            console.warn('[supabase] anonymous auth failed:', error.message);
          } else {
            user = data.user;
          }
        }
        if (mounted) setUserId(user?.id ?? null);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[supabase] auth error:', e?.message ?? e);
      }

      // 2. Fetch all posts (newest first).
      try {
        const { data, error } = await supabase
          .from('posts')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) {
          // eslint-disable-next-line no-console
          console.warn('[supabase] fetch posts failed:', error.message);
        } else if (mounted) {
          setRows(data ?? []);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[supabase] fetch error:', e?.message ?? e);
      }
      if (mounted) setLoading(false);

      // 3. Realtime — keep all open tabs in sync.
      channel = supabase
        .channel('posts-stream')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, (payload) => {
          setRows((prev) => (prev.some((r) => r.id === payload.new.id) ? prev : [payload.new, ...prev]));
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, (payload) => {
          setRows((prev) => prev.map((r) => (r.id === payload.new.id ? payload.new : r)));
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, (payload) => {
          setRows((prev) => prev.filter((r) => r.id !== payload.old.id));
        })
        .subscribe();
    })();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  // ---- derived UI shape: row -> post + computed `own` and `hrs` -------------
  const posts = useMemo(() => {
    return rows.map((r) => {
      const p = rowToPost(r);
      p.own = !!(userId && p.ownerId === userId && !p.isSeed);
      p.hrs = hoursAgo(p.createdAt);
      return p;
    });
  }, [rows, userId]);

  const live = useMemo(() => posts.filter((p) => p.hrs < 1 || p.own).length, [posts]);
  const ownPosts = useMemo(() => posts.filter((p) => p.own), [posts]);

  // Keep `selected` fresh when its underlying row changes (edit / realtime).
  useEffect(() => {
    if (!selected) return;
    const fresh = posts.find((p) => p.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [posts, selected]);

  const filterActive = query.trim().length > 0 || serviceFilter !== 'ALL' || liveOnly;

  const pick = (p) => {
    setSelected(p);
    setView('hood');
  };

  const goToMine = () => {
    if (ownPosts.length === 0) {
      setEditing(null);
      setComposeOpen(true);
      return;
    }
    setView('mine');
  };

  const startEdit = (post) => {
    setEditing(post);
    setComposeOpen(true);
  };

  const remove = async (post) => {
    // Optimistic remove from local rows; realtime will reconcile.
    setRows((prev) => prev.filter((r) => r.id !== post.id));
    if (selected && selected.id === post.id) {
      setSelected(null);
      if (view === 'hood') setView(ownPosts.length > 1 ? 'mine' : 'globe');
    }
    if (composeOpen) {
      setComposeOpen(false);
      setEditing(null);
    }
    const { error } = await supabase.from('posts').delete().eq('id', post.id);
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[supabase] delete failed:', error.message);
    }
  };

  const submit = async (data) => {
    const videoId = data.service === 'YOUTUBE' ? videoIdFromLink(data.link) : '';

    if (editing) {
      const patch = {
        track_name: data.track || '(UNTITLED)',
        artist_name: data.artist || '(UNKNOWN ARTIST)',
        service: data.service,
        vibe_note: data.vibe || 'posted from here, right now.',
        link: data.link,
        video_id: videoId,
        updated_at: new Date().toISOString(),
      };
      // Optimistic patch on local rows.
      setRows((prev) => prev.map((r) => (r.id === editing.id ? { ...r, ...patch } : r)));
      const updatedView = {
        ...editing,
        trackName: patch.track_name,
        artistName: patch.artist_name,
        service: patch.service,
        vibeNote: patch.vibe_note,
        link: patch.link,
        videoId: patch.video_id,
      };
      setComposeOpen(false);
      setEditing(null);
      setSelected(updatedView);
      setView('hood');

      const { error } = await supabase
        .from('posts')
        .update(patch)
        .eq('id', editing.id);
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[supabase] update failed:', error.message);
      }
      return;
    }

    if (!userId) {
      // eslint-disable-next-line no-console
      console.warn('[supabase] cannot post: no user (is anonymous auth enabled?).');
      return;
    }

    const insertRow = {
      owner_id: userId,
      handle: '@you',
      lat: 1.35,
      lng: 103.82,
      city: 'SINGAPORE',
      hood: 'SENGKANG',
      track_name: data.track || '(UNTITLED)',
      artist_name: data.artist || '(UNKNOWN ARTIST)',
      service: data.service,
      vibe_note: data.vibe || 'posted from here, right now.',
      link: data.link,
      video_id: videoId,
    };

    const { data: row, error } = await supabase
      .from('posts')
      .insert(insertRow)
      .select()
      .single();
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[supabase] insert failed:', error.message);
      return;
    }

    // Add to local rows if realtime hasn't beaten us to it.
    setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]));

    const newPost = rowToPost(row);
    newPost.own = true;
    newPost.hrs = 0;

    setComposeOpen(false);
    setEditing(null);
    setSelected(newPost);
    setView('hood');
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); return; }
        if (composeOpen) {
          setComposeOpen(false);
          setEditing(null);
        } else if (view === 'hood' || view === 'mine') {
          setView('globe');
        }
        return;
      }
      // open search with "/" shortcut when not focused in a field
      if (e.key === '/' && !composeOpen && !searchOpen) {
        const t = e.target;
        const tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [composeOpen, view, searchOpen]);

  return (
    <>
      <style>{STYLES}</style>
      <Noise />
      <div className="app">
        <Header
          total={posts.length}
          live={live}
          mine={ownPosts.length}
          onMine={goToMine}
          onSearch={() => setSearchOpen(true)}
          searchActive={filterActive}
        />
        <main className="main">
          {view === 'globe' && <Globe posts={posts} onPick={pick} />}
          {view === 'hood' && selected && (
            <Hood
              post={selected}
              onBack={() => setView('globe')}
              onEdit={selected.own ? () => startEdit(selected) : undefined}
              onDelete={selected.own ? () => remove(selected) : undefined}
            />
          )}
          {view === 'mine' && (
            <MineView
              posts={ownPosts}
              onBack={() => setView('globe')}
              onPick={pick}
              onEdit={startEdit}
              onDelete={remove}
              onCompose={() => { setEditing(null); setComposeOpen(true); }}
            />
          )}
          {/* decorative marks */}
          <span className="mark mark-plus">+</span>
          <span className="mark mark-dot">·</span>
        </main>
        <Footer
          view={view}
          onCompose={() => { setEditing(null); setComposeOpen(true); }}
        />
      </div>
      {composeOpen && (
        <Compose
          onClose={() => { setComposeOpen(false); setEditing(null); }}
          onSubmit={submit}
          initial={editing}
          onDelete={editing ? remove : undefined}
        />
      )}
      {searchOpen && (
        <SearchModal
          posts={posts}
          onClose={() => setSearchOpen(false)}
          onPick={(p) => { setSearchOpen(false); pick(p); }}
          query={query}
          onQuery={setQuery}
          serviceFilter={serviceFilter}
          onServiceFilter={setServiceFilter}
          liveOnly={liveOnly}
          onLiveOnly={setLiveOnly}
          onClear={() => { setQuery(''); setServiceFilter('ALL'); setLiveOnly(false); }}
        />
      )}
    </>
  );
}

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,100;0,200;0,300;0,400;1,300&display=swap');

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; padding: 0; }
body {
  background: ${PALETTE.bg};
  color: ${PALETTE.ink};
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  line-height: 1.5;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.noise {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 0;
  pointer-events: none;
  mix-blend-mode: multiply;
  opacity: 0.5;
}

.app {
  position: relative;
  z-index: 1;
  height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
}

/* header */
.header {
  padding: 16px 28px 18px 28px;
  border-bottom: 1px solid ${PALETTE.hairline};
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  font-weight: 400;
}
.header-left { display: flex; gap: 10px; align-items: baseline; }
.wordmark { font-weight: 500; color: ${PALETTE.ink}; letter-spacing: 0.12em; }
.bracket { color: ${PALETTE.mute}; font-weight: 400; }
.sub { color: ${PALETTE.mute}; font-weight: 400; }
.counter { color: ${PALETTE.ink}; display: flex; align-items: center; gap: 10px; }
.chip {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 500;
  background: transparent;
  border: 1px solid ${PALETTE.ink};
  color: ${PALETTE.ink};
  padding: 3px 9px;
  margin-left: 4px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
  border-radius: 0;
}
.chip:hover {
  background: ${PALETTE.ink};
  color: ${PALETTE.bg};
}
.chip.chip-empty {
  border-color: ${PALETTE.hairline};
  color: ${PALETTE.mute};
}
.chip.chip-empty:hover {
  border-color: ${PALETTE.ink};
  color: ${PALETTE.inkFade};
  background: transparent;
}
.live-dot {
  width: 6px; height: 6px; background: ${PALETTE.accent};
  display: inline-block;
  animation: blink 1.6s steps(1) infinite;
}
@keyframes blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}

/* main */
.main {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 12px 24px;
  overflow: hidden;
}

/* globe */
.globe-wrap {
  width: 100%;
  max-width: 720px;
  aspect-ratio: 1;
  touch-action: none;
  position: relative;
}
.zoom-rail {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
  user-select: none;
  z-index: 2;
}
.zoom-rail button {
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: 0.06em;
  background: ${PALETTE.bg};
  border: 1px solid ${PALETTE.hairline};
  color: ${PALETTE.ink};
  cursor: pointer;
  padding: 0;
  transition: color 0.12s, background 0.12s, border-color 0.12s, transform 0.12s;
  border-radius: 0;
}
.zoom-rail button:hover:not(:disabled) {
  background: ${PALETTE.ink};
  color: ${PALETTE.bg};
  border-color: ${PALETTE.ink};
}
.zoom-rail button:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}
.zoom-rail .zoom-btn {
  width: 28px;
  height: 28px;
  font-size: 16px;
  line-height: 1;
  font-weight: 500;
}
.zoom-rail .zoom-btn:active:not(:disabled) {
  transform: scale(0.94);
}
.zoom-rail .zoom-readout {
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 4px 0;
  color: ${PALETTE.mute};
  text-align: center;
  border-color: transparent;
  background: transparent;
}
.zoom-rail .zoom-readout:hover {
  color: ${PALETTE.bg};
  background: ${PALETTE.ink};
  border-color: ${PALETTE.ink};
}
.globe-wrap svg {
  display: block;
  width: 100%;
  height: 100%;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.ring {
  transform-origin: center;
}
.ring-1 { animation: spinCW 18s linear infinite; }
.ring-2 { animation: spinCCW 22s linear infinite; }
.ring-3 { animation: spinCW 44s linear infinite; }
.ring-4 { animation: spinCCW 70s linear infinite; }
@keyframes spinCW { to { transform: rotate(360deg); } }
@keyframes spinCCW { to { transform: rotate(-360deg); } }

.pulse-ring {
  animation: pulseRing 2.4s ease-out infinite;
}
@keyframes pulseRing {
  0% { r: 3px; opacity: 0.9; }
  100% { r: 16px; opacity: 0; }
}

/* decorative marks */
.mark {
  position: absolute;
  color: ${PALETTE.ink};
  opacity: 0.25;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 18px;
  pointer-events: none;
  user-select: none;
}
.mark-plus { top: 12%; right: 10%; }
.mark-dot { bottom: 14%; left: 8%; font-size: 26px; }
@media (max-width: 760px) {
  .mark { display: none; }
}

/* footer */
.footer {
  padding: 16px 28px 18px 28px;
  border-top: 1px solid ${PALETTE.hairline};
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: ${PALETTE.mute};
  gap: 16px;
}
.footer > span { flex: 1; }

/* buttons */
.btn {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 500;
  border: none;
  border-radius: 0;
  background: ${PALETTE.ink};
  color: ${PALETTE.bg};
  padding: 11px 16px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.btn:hover { color: ${PALETTE.bgFade}; }
.btn-ghost {
  background: transparent;
  color: ${PALETTE.ink};
  border: 1px solid ${PALETTE.hairline};
}
.btn-ghost:hover { color: ${PALETTE.inkFade}; border-color: ${PALETTE.ink}; }
.btn-danger:hover { color: ${PALETTE.accent}; border-color: ${PALETTE.accent}; }
.btn:disabled { opacity: 0.3; cursor: not-allowed; }
.btn:disabled:hover { color: ${PALETTE.bg}; }

/* search chip in header */
.chip.chip-search {
  position: relative;
  letter-spacing: 0.18em;
  padding-right: 14px;
}
.chip.chip-search.is-filtered {
  background: ${PALETTE.ink};
  color: ${PALETTE.bg};
  border-color: ${PALETTE.ink};
}
.chip-pip {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: ${PALETTE.accent};
  box-shadow: 0 0 0 2px ${PALETTE.bg};
}

/* search modal — full-screen departure board */
@keyframes search-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes search-row-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes search-caret {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@keyframes search-corners-in {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}

.search-modal {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  background: ${PALETTE.bgFade};
  backdrop-filter: blur(14px) saturate(110%);
  -webkit-backdrop-filter: blur(14px) saturate(110%);
  animation: search-fade-in 0.18s ease-out;
}
.search-panel {
  position: relative;
  width: 100%;
  max-width: 760px;
  max-height: 100%;
  background: ${PALETTE.bg};
  border: 1px solid ${PALETTE.hairline};
  display: flex;
  flex-direction: column;
  padding: 28px 32px 0;
  overflow: hidden;
}

/* corner brackets */
.search-corner {
  position: absolute;
  width: 18px;
  height: 18px;
  pointer-events: none;
  animation: search-corners-in 0.32s 0.04s both ease-out;
}
.search-corner-tl {
  top: 8px;
  left: 8px;
  border-top: 1px solid ${PALETTE.ink};
  border-left: 1px solid ${PALETTE.ink};
}
.search-corner-tr {
  top: 8px;
  right: 8px;
  border-top: 1px solid ${PALETTE.ink};
  border-right: 1px solid ${PALETTE.ink};
}
.search-corner-bl {
  bottom: 8px;
  left: 8px;
  border-bottom: 1px solid ${PALETTE.ink};
  border-left: 1px solid ${PALETTE.ink};
}
.search-corner-br {
  bottom: 8px;
  right: 8px;
  border-bottom: 1px solid ${PALETTE.ink};
  border-right: 1px solid ${PALETTE.ink};
}

.search-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding-bottom: 12px;
  border-bottom: 1px solid ${PALETTE.hairline};
}
.search-title {
  font: 500 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: ${PALETTE.ink};
}
.search-close {
  background: transparent;
  border: none;
  color: ${PALETTE.mute};
  font-family: 'IBM Plex Mono', monospace;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  transition: color 0.15s;
}
.search-close:hover { color: ${PALETTE.ink}; }

.search-input-wrap {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 22px 4px 18px;
  border-bottom: 1px solid ${PALETTE.hairline};
}
.search-prompt {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 22px;
  line-height: 1;
  color: ${PALETTE.accent};
  font-weight: 500;
}
.search-big-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  font: 300 26px/1.2 'IBM Plex Sans', system-ui, sans-serif;
  letter-spacing: 0.04em;
  text-transform: none;
  color: ${PALETTE.ink};
  padding: 4px 0;
}
.search-big-input::placeholder {
  color: ${PALETTE.mute};
  font-style: italic;
  letter-spacing: 0.02em;
}
.search-caret {
  width: 1px;
  height: 26px;
  background: ${PALETTE.ink};
  animation: search-caret 1.05s steps(1) infinite;
}

.search-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 14px 4px 12px;
  border-bottom: 1px solid ${PALETTE.hairline};
}
.search-filters-label {
  font-size: 10px;
  letter-spacing: 0.16em;
  color: ${PALETTE.mute};
  margin-right: 4px;
}
.filter-chip {
  font: 500 10px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  background: transparent;
  color: ${PALETTE.mute};
  border: 1px solid ${PALETTE.hairline};
  padding: 5px 10px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
  border-radius: 0;
}
.filter-chip:hover {
  color: ${PALETTE.ink};
  border-color: ${PALETTE.ink};
}
.filter-chip.is-active {
  color: ${PALETTE.bg};
  background: ${PALETTE.ink};
  border-color: ${PALETTE.ink};
}
.filter-divider {
  width: 1px;
  align-self: stretch;
  background: ${PALETTE.hairline};
  margin: 2px 4px;
}

.search-count-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 12px 4px 10px;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: ${PALETTE.mute};
}
.search-count-num {
  color: ${PALETTE.ink};
  font-weight: 500;
  margin: 0 4px;
}
.search-clear {
  font: 500 10px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  background: transparent;
  border: none;
  color: ${PALETTE.accent};
  cursor: pointer;
  padding: 4px 0;
}
.search-clear:hover { color: ${PALETTE.inkFade}; }

.search-results {
  flex: 1;
  overflow-y: auto;
  margin: 0 -32px;
  padding: 0 32px 8px;
  scrollbar-width: thin;
  scrollbar-color: ${PALETTE.hairline} transparent;
}
.search-results::-webkit-scrollbar { width: 6px; }
.search-results::-webkit-scrollbar-thumb { background: ${PALETTE.hairline}; }
.search-list {
  list-style: none;
  margin: 0;
  padding: 4px 0 4px;
}
.search-result {
  display: grid;
  grid-template-columns: 28px 44px minmax(0, 1.6fr) minmax(0, 1fr) 14px;
  align-items: center;
  gap: 14px;
  padding: 11px 8px;
  border-bottom: 1px dashed ${PALETTE.hairline};
  cursor: pointer;
  background: transparent;
  border-left: 0;
  border-right: 0;
  border-top: 0;
  width: 100%;
  text-align: left;
  font-family: inherit;
  color: inherit;
  text-transform: none;
  letter-spacing: normal;
  transition: background 0.12s, padding 0.12s;
  animation: search-row-in 0.34s both ease-out;
  animation-delay: calc(var(--i, 0) * 22ms);
}
.search-result:hover,
.search-result.is-highlight {
  background: rgba(10, 10, 10, 0.04);
  padding-left: 14px;
  border-bottom-color: ${PALETTE.ink};
}
.search-result.is-highlight {
  box-shadow: inset 3px 0 0 ${PALETTE.accent};
}
.search-result.is-highlight .result-arrow,
.search-result:hover .result-arrow {
  color: ${PALETTE.accent};
  transform: translateX(2px);
}
.result-index {
  font: 500 10px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.1em;
  color: ${PALETTE.mute};
  text-transform: uppercase;
}
.result-glyph {
  font: 500 10px/1 'IBM Plex Mono', monospace;
  color: ${PALETTE.mute};
  letter-spacing: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.result-glyph .result-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${PALETTE.accent};
  display: inline-block;
}
.result-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.result-track {
  font: 400 14px/1.3 'IBM Plex Sans', system-ui, sans-serif;
  letter-spacing: 0.04em;
  color: ${PALETTE.ink};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result-artist {
  font: 300 italic 12px/1.3 'IBM Plex Sans', system-ui, sans-serif;
  color: ${PALETTE.inkFade};
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result-meta {
  font: 500 10px/1.4 'IBM Plex Mono', monospace;
  color: ${PALETTE.mute};
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-align: right;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-end;
  min-width: 0;
}
.result-loc {
  color: ${PALETTE.ink};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.result-svc {
  color: ${PALETTE.mute};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}
.result-arrow {
  font: 500 14px/1 'IBM Plex Mono', monospace;
  color: ${PALETTE.mute};
  transition: color 0.15s, transform 0.15s;
}

.search-empty {
  padding: 40px 16px 32px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.search-empty-line {
  font: 300 18px/1.3 'IBM Plex Sans', system-ui, sans-serif;
  font-style: italic;
  color: ${PALETTE.inkFade};
  letter-spacing: 0.02em;
}
.search-empty-hint {
  font: 500 10px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: ${PALETTE.mute};
}

.search-footer {
  display: flex;
  justify-content: center;
  gap: 24px;
  padding: 12px 0 14px;
  border-top: 1px solid ${PALETTE.hairline};
  margin-top: 4px;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: ${PALETTE.mute};
}
.search-foot-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.search-footer kbd {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border: 1px solid ${PALETTE.hairline};
  color: ${PALETTE.ink};
  background: transparent;
  min-width: 16px;
  text-align: center;
}

@media (max-width: 560px) {
  .search-panel { padding: 24px 18px 0; }
  .search-results { margin: 0 -18px; padding: 0 18px 8px; }
  .search-big-input { font-size: 20px; }
  .search-result { grid-template-columns: 22px 14px 1fr auto 10px; gap: 10px; }
  .result-meta { font-size: 9px; }
  .search-footer { gap: 14px; flex-wrap: wrap; }
}

/* mine list view */
.mine {
  width: 100%;
  max-width: 720px;
  padding: 16px 24px 32px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mine-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid ${PALETTE.hairline};
  padding-bottom: 8px;
}
.mine-title {
  font-weight: 500;
  letter-spacing: 0.16em;
}
.mine-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 64px 24px;
  color: ${PALETTE.mute};
  text-align: center;
}
.mine-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.mine-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid ${PALETTE.hairline};
  padding: 12px 4px;
}
.mine-row-main {
  flex: 1 1 220px;
  min-width: 0;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${PALETTE.ink};
  transition: opacity 0.15s;
}
.mine-row-main:hover { opacity: 0.65; }
.mine-glyph {
  display: inline-flex;
  width: 44px;
  height: 44px;
}
.mine-glyph svg { display: block; }
.mine-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.mine-track {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mine-artist {
  color: ${PALETTE.mute};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mine-loc {
  font-size: 9px;
  color: ${PALETTE.mute};
  letter-spacing: 0.14em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mine-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin-left: auto;
}
.mine-actions .btn {
  padding: 6px 10px;
  font-size: 10px;
  white-space: nowrap;
}

/* hood owner actions */
.post-owner-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.post-owner-actions .btn {
  flex: 1;
  padding: 8px 10px;
  font-size: 10px;
}

/* hood */
.hood {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 48px;
  padding: 16px 24px;
  max-width: 1100px;
  width: 100%;
  align-items: center;
}
.hood-canvas {
  width: 100%;
  aspect-ratio: 1;
  max-width: 480px;
  justify-self: center;
}
.hood-canvas svg { width: 100%; height: 100%; display: block; }
.hood-pulse {
  animation: pulseRing 2.4s ease-out infinite;
  transform-origin: 200px 200px;
}
.post-card {
  display: flex;
  flex-direction: column;
  max-width: 440px;
  justify-self: start;
}
.now-playing {
  display: flex;
  justify-content: space-between;
  color: ${PALETTE.mute};
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  margin-bottom: 22px;
}
.now-playing-label {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 11px;
}
.eq > span {
  display: inline-block;
  width: 2px;
  background: ${PALETTE.accent};
  height: 3px;
  transform-origin: bottom;
  animation: eqBar 1s ease-in-out infinite;
}
.eq > span:nth-child(1) { animation-delay: 0s;    animation-duration: 0.9s; }
.eq > span:nth-child(2) { animation-delay: 0.15s; animation-duration: 1.1s; }
.eq > span:nth-child(3) { animation-delay: 0.05s; animation-duration: 0.7s; }
.eq > span:nth-child(4) { animation-delay: 0.25s; animation-duration: 1.3s; }
.eq > span:nth-child(5) { animation-delay: 0.4s;  animation-duration: 0.8s; }
@keyframes eqBar {
  0%, 100% { height: 3px; }
  50%      { height: 11px; }
}
.post-glyph {
  position: relative;
  width: 200px;
  height: 200px;
  margin-bottom: 26px;
  border: 1px solid ${PALETTE.hairline};
  overflow: hidden;
  transition: border-color 0.2s, background 0.2s;
}
.post-glyph.is-playing {
  border-color: transparent;
  overflow: visible;
}
.vinyl {
  width: 100%;
  height: 100%;
  display: block;
  animation: vinylSpin 3.6s linear infinite;
  transform-origin: 50% 50%;
  will-change: transform;
}
@keyframes vinylSpin {
  to { transform: rotate(360deg); }
}
.hidden-embed {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  border: 0;
  left: -10px;
  top: -10px;
}
.post-track {
  font-family: 'IBM Plex Sans', sans-serif;
  font-weight: 200;
  font-size: 28px;
  color: ${PALETTE.ink};
  text-transform: none;
  letter-spacing: -0.01em;
  line-height: 1.12;
  margin: 0 0 4px 0;
}
.post-artist {
  font-family: 'IBM Plex Sans', sans-serif;
  font-weight: 400;
  font-size: 14px;
  color: ${PALETTE.mute};
  text-transform: none;
  letter-spacing: 0;
  margin: 0 0 14px 0;
}
.post-handle {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  color: ${PALETTE.mute};
  letter-spacing: 0.12em;
  margin-bottom: 16px;
}
.post-vibe {
  font-family: 'IBM Plex Sans', sans-serif;
  font-weight: 300;
  font-size: 16px;
  color: ${PALETTE.ink};
  text-transform: none;
  font-style: italic;
  line-height: 1.45;
  letter-spacing: 0;
  margin: 14px 0 28px 0;
}
.play-btn { align-self: flex-start; margin-bottom: 22px; }
.back-link {
  background: none; border: none;
  color: ${PALETTE.ink};
  cursor: pointer;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 0;
  text-align: left;
  align-self: flex-start;
}
.back-link:hover { color: ${PALETTE.inkFade}; }

@media (max-width: 760px) {
  .hood { grid-template-columns: 1fr; gap: 28px; padding: 16px; }
  .hood-canvas { max-width: 320px; }
  .post-card { max-width: 100%; }
}

/* modal */
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(10, 10, 10, 0.75);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 100;
  padding: 24px;
}
.modal {
  background: ${PALETTE.bg};
  border: 1px solid ${PALETTE.ink};
  width: 100%;
  max-width: 520px;
  padding: 22px 24px;
  font-family: 'IBM Plex Mono', monospace;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid ${PALETTE.hairline};
  margin-bottom: 16px;
  font-size: 11px;
  letter-spacing: 0.12em;
}
.modal-close {
  background: none; border: none;
  cursor: pointer;
  font-size: 18px;
  font-family: 'IBM Plex Mono', monospace;
  color: ${PALETTE.ink};
  padding: 0; line-height: 1;
}
.modal-close:hover { color: ${PALETTE.inkFade}; }
.modal-row {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: ${PALETTE.ink};
  margin-bottom: 4px;
}
.modal-row.mute { color: ${PALETTE.mute}; margin-bottom: 14px; }
.modal-input {
  width: 100%;
  background: transparent;
  border: 1px solid ${PALETTE.hairline};
  padding: 10px 12px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  border-radius: 0;
  color: ${PALETTE.ink};
  margin-bottom: 6px;
}
.modal-input:focus { outline: none; border-color: ${PALETTE.ink}; }
.modal-input::placeholder { color: ${PALETTE.mute}; }
.modal-meta {
  font-size: 9px;
  color: ${PALETTE.mute};
  letter-spacing: 0.12em;
  margin: 4px 0 16px 0;
}
.modal-preview {
  display: flex;
  gap: 16px;
  padding: 4px 0 12px 0;
  align-items: flex-start;
}
.modal-preview-glyph {
  width: 120px; height: 120px;
  flex-shrink: 0;
  border: 1px solid ${PALETTE.hairline};
}
.modal-preview-inputs {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.glyph-placeholder {
  width: 100%; height: 100%;
  display: flex; justify-content: center; align-items: center;
  color: ${PALETTE.mute};
  font-size: 10px;
  letter-spacing: 0.12em;
}
.modal-textarea {
  width: 100%;
  background: transparent;
  border: 1px solid ${PALETTE.hairline};
  padding: 10px 12px;
  font-family: 'IBM Plex Sans', sans-serif;
  font-weight: 300;
  font-size: 14px;
  font-style: italic;
  border-radius: 0;
  color: ${PALETTE.ink};
  resize: none;
  min-height: 70px;
  text-transform: none;
  letter-spacing: 0;
  margin: 6px 0 4px 0;
  line-height: 1.5;
}
.modal-textarea:focus { outline: none; border-color: ${PALETTE.ink}; }
.modal-textarea::placeholder {
  color: ${PALETTE.mute};
  font-family: 'IBM Plex Mono', monospace;
  font-style: normal;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.modal-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 16px;
  border-top: 1px solid ${PALETTE.hairline};
  margin-top: 12px;
}
.char-count {
  font-size: 10px;
  color: ${PALETTE.mute};
  letter-spacing: 0.12em;
}
.modal-actions {
  display: flex;
  gap: 8px;
}

/* split text */
.split-container { display: inline; }
.split-word {
  display: inline-block;
  opacity: 0;
  transform: translateY(4px);
  animation: splitIn 180ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
  white-space: pre;
}
@keyframes splitIn {
  to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 520px) {
  .header, .footer { padding-left: 16px; padding-right: 16px; }
  .header-left { gap: 6px; font-size: 10px; }
  .sub { display: none; }
  .footer { flex-direction: column; gap: 12px; align-items: stretch; }
  .footer .btn { width: 100%; text-align: center; }
}
`;
