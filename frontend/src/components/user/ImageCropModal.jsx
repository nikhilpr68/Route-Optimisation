import React, { useEffect, useRef, useState } from 'react';

const CROP_SIZE = 280;
const OUTPUT_SIZE = 512;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readImageDimensions(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        image,
        width: image.naturalWidth,
        height: image.naturalHeight
      });
    };
    image.onerror = () => reject(new Error('Unable to load the selected image.'));
    image.src = src;
  });
}

export default function ImageCropModal({ source, onCancel, onApply }) {
  const frameRef = useRef(null);
  const dragRef = useRef({ pointerId: null, startX: 0, startY: 0, startOffsetX: 0, startOffsetY: 0 });
  const [imageState, setImageState] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    setError('');
    setZoom(1);
    setOffset({ x: 0, y: 0 });

    readImageDimensions(source?.src || '')
      .then((loaded) => {
        if (!mounted) return;
        setImageState(loaded);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err.message || 'Unable to load the selected image.');
      });

    return () => {
      mounted = false;
    };
  }, [source]);

  const naturalWidth = imageState?.width || 1;
  const naturalHeight = imageState?.height || 1;
  const baseScale = Math.max(CROP_SIZE / naturalWidth, CROP_SIZE / naturalHeight);
  const totalScale = baseScale * zoom;
  const displayWidth = naturalWidth * totalScale;
  const displayHeight = naturalHeight * totalScale;
  const maxOffsetX = Math.max(0, (displayWidth - CROP_SIZE) / 2);
  const maxOffsetY = Math.max(0, (displayHeight - CROP_SIZE) / 2);

  const applyOffset = (nextX, nextY) => {
    setOffset({
      x: clamp(nextX, -maxOffsetX, maxOffsetX),
      y: clamp(nextY, -maxOffsetY, maxOffsetY)
    });
  };

  useEffect(() => {
    applyOffset(offset.x, offset.y);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePointerDown = (event) => {
    if (!imageState || exporting) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: offset.x,
      startOffsetY: offset.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragRef.current.startX;
    const deltaY = event.clientY - dragRef.current.startY;
    applyOffset(dragRef.current.startOffsetX + deltaX, dragRef.current.startOffsetY + deltaY);
  };

  const handlePointerUp = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current.pointerId = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleApply = async () => {
    if (!imageState) return;
    setExporting(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable.');

      const imageLeft = (CROP_SIZE - displayWidth) / 2 + offset.x;
      const imageTop = (CROP_SIZE - displayHeight) / 2 + offset.y;
      const sourceX = Math.max(0, (0 - imageLeft) / totalScale);
      const sourceY = Math.max(0, (0 - imageTop) / totalScale);
      const sourceWidth = Math.min(naturalWidth, CROP_SIZE / totalScale);
      const sourceHeight = Math.min(naturalHeight, CROP_SIZE / totalScale);

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        imageState.image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        OUTPUT_SIZE,
        OUTPUT_SIZE
      );

      const croppedImage = canvas.toDataURL('image/png');
      onApply(croppedImage);
    } catch (err) {
      setError(err.message || 'Unable to crop the selected image.');
      setExporting(false);
      return;
    }
    setExporting(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(3,6,14,0.82)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        zIndex: 1000
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(92vw, 560px)',
          borderRadius: '24px',
          border: '1px solid rgba(255,255,255,0.14)',
          background: 'linear-gradient(180deg, rgba(9,14,28,0.97) 0%, rgba(5,8,18,0.98) 100%)',
          boxShadow: '0 30px 70px rgba(0,0,0,0.45)',
          padding: '22px',
          color: 'white',
          display: 'grid',
          gap: '16px'
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: '1.15rem' }}>Crop Profile Picture</h3>
          <p style={{ margin: '8px 0 0 0', opacity: 0.7, fontSize: '0.9rem' }}>
            Drag to reposition and use zoom before applying.
          </p>
        </div>

        <div
          ref={frameRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            width: `${CROP_SIZE}px`,
            height: `${CROP_SIZE}px`,
            maxWidth: '100%',
            margin: '0 auto',
            borderRadius: '28px',
            overflow: 'hidden',
            position: 'relative',
            background: 'radial-gradient(circle at top, rgba(37,99,235,0.35), rgba(15,23,42,0.95))',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
            touchAction: 'none',
            cursor: imageState ? 'grab' : 'default'
          }}
        >
          {imageState ? (
            <img
              src={source?.src}
              alt="Crop preview"
              draggable={false}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: `${displayWidth}px`,
                height: `${displayHeight}px`,
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                userSelect: 'none',
                pointerEvents: 'none'
              }}
            />
          ) : null}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.18), inset 0 0 0 999px rgba(0,0,0,0.08)',
              borderRadius: '28px',
              pointerEvents: 'none'
            }}
          />
        </div>

        <label style={{ display: 'grid', gap: '8px' }}>
          <span style={{ fontSize: '0.84rem', opacity: 0.75 }}>Zoom</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>

        {error ? (
          <div style={{ color: '#fca5a5', fontSize: '0.86rem' }}>{error}</div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              height: '40px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.16)',
              background: 'rgba(255,255,255,0.04)',
              color: 'white',
              padding: '0 14px',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!imageState || exporting}
            style={{
              height: '40px',
              borderRadius: '12px',
              border: '1px solid rgba(96,165,250,0.55)',
              background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
              color: 'white',
              fontWeight: 700,
              padding: '0 16px',
              cursor: !imageState || exporting ? 'not-allowed' : 'pointer',
              opacity: !imageState || exporting ? 0.7 : 1
            }}
          >
            {exporting ? 'Applying...' : 'Apply Crop'}
          </button>
        </div>
      </div>
    </div>
  );
}
